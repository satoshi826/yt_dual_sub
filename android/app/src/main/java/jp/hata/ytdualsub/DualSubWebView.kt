package jp.hata.ytdualsub

import android.annotation.SuppressLint
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import java.io.BufferedReader

private const val TAG = "DualSubWebView"
private const val INITIAL_URL = "https://m.youtube.com/"

// 完全 Chrome モバイル偽装。WebView デフォルト UA (";wv" "Version/4.0" 入り)を
// YouTube が検知して縮小レイアウトを返してくるため、Pixel + Chrome として完全に
// 偽装する。Chrome バージョンは固定なので 1 年に一度くらい更新が必要(老朽化すると
// 「古いブラウザ」とみなされる)。
private const val CHROME_MOBILE_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"

// ブラウザ偽装スニペット。WebView 環境を本物の Chrome モバイルとして見せかける。
//   1) navigator.userAgentData.brands を Chrome 風に上書き(Client Hints 検知回避)
//   2) window.chrome を最小限の本物 Chrome 風オブジェクトに上書き
// なお、これらを完全に揃えても YouTube は別の手段で WebView を見抜いて
// sticky モード(ミニプレーヤー固定)に入れてくるため、対症療法として
// UNSTICK_PLAYER も合わせて注入している。
private const val BROWSER_SPOOF = """
(function() {
  try {
    const fakeBrands = [
      { brand: 'Chromium', version: '130' },
      { brand: 'Google Chrome', version: '130' },
      { brand: 'Not?A_Brand', version: '99' }
    ];
    const fakeFull = [
      { brand: 'Chromium', version: '130.0.0.0' },
      { brand: 'Google Chrome', version: '130.0.0.0' },
      { brand: 'Not?A_Brand', version: '99.0.0.0' }
    ];
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      get: () => ({
        brands: fakeBrands,
        mobile: true,
        platform: 'Android',
        getHighEntropyValues: () => Promise.resolve({
          architecture: '', bitness: '', model: 'Pixel 8',
          platformVersion: '14.0.0',
          uaFullVersion: '130.0.0.0',
          fullVersionList: fakeFull,
        }),
        toJSON: () => ({ brands: fakeBrands, mobile: true, platform: 'Android' }),
      }),
    });
  } catch (e) { /* ignore */ }

  try {
    if (typeof window.chrome === 'undefined') {
      // 実 Chrome の window.chrome オブジェクトの最小サブセット。
      // YouTube はサイト内で feature gate に使っているらしく、これが
      // undefined だとモバイル sticky プレーヤー等の縮小レイアウトに分岐する。
      const noop = () => {};
      const chromeStub = {
        app: { isInstalled: false, InstallState: {}, RunningState: {} },
        runtime: {
          id: undefined,
          connect: () => ({ onMessage: { addListener: noop }, postMessage: noop, disconnect: noop }),
          sendMessage: noop,
          onMessage:   { addListener: noop, removeListener: noop },
          onConnect:   { addListener: noop, removeListener: noop },
        },
        csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: 0, tran: 15 }),
        loadTimes: () => ({
          requestTime: Date.now() / 1000,
          startLoadTime: Date.now() / 1000,
          commitLoadTime: Date.now() / 1000,
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          firstPaintTime: Date.now() / 1000,
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: false,
          wasNpnNegotiated: false,
          npnNegotiatedProtocol: 'unknown',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'unknown',
        }),
      };
      Object.defineProperty(window, 'chrome', {
        configurable: true, writable: true, value: chromeStub,
      });
    }
  } catch (e) { /* ignore */ }
})();
"""

// YouTube ミニプレーヤー(sticky-player)抑制スニペット。
// WebView では動画ページに入った瞬間から #player-container-id.sticky-player が
// 付与され、プレーヤーが 125px 程度に固定される。本物の Chrome モバイルでは
// スクロール時にしか起きない挙動。最終手段として CSS specificity を最大化
// (html[data-dualsub-unstick="on"] body #id ...)した !important CSS で
// 常時 relative + 16:9 化する。
//
// 適用範囲: watch ページのみ。ホーム/Shorts/検索結果などでは documentElement
// の data-dualsub-unstick 属性を "off" にし、CSS が一切マッチしないようにする。
// SPA 遷移にも追従する(yt-navigate-finish, popstate, pushState patch)。
//
// 重要: YouTube は <head> 内に見知らぬ <style> があると定期的に剥がしてくる。
// そのため <style> は <head> ではなく documentElement (= <html>) 直下に直接
// append する。さらに念のため MutationObserver で documentElement の childList
// を監視し、剥がされた場合は再 append する自己修復ロジックを持たせる。
//
// PoC スクリプト本体には混ぜない(PC ブラウザでは sticky-player はスクロール時に
// 正常動作するので壊さない方が良い)。
private const val UNSTICK_PLAYER = """
(function() {
  // onPageStarted では document.documentElement がまだ null のことがある。
  // その段階でガードを立てると onPageFinished の再注入が無効化されるため、
  // documentElement が用意されるまでは何もせず次の呼び出しに任せる。
  if (!document.documentElement) return;
  if (window.__dualsubUnstickInstalled) return;
  window.__dualsubUnstickInstalled = true;

  // CSS は html[data-dualsub-unstick="on"] 下でのみ有効。watch ページ以外では
  // 属性を "off" にして CSS を完全に dormant にする(.player-size 等は YT の
  // ホームでも使われており、影響を出さないようにするため)。
  const CSS_TEXT = [
    // player-container を常に relative + 16:9 に固定する
    'html[data-dualsub-unstick="on"] body #player-container-id,',
    'html[data-dualsub-unstick="on"] body .player-container {',
    '  position: relative !important;',
    '  top: auto !important;',
    '  left: auto !important;',
    '  right: auto !important;',
    '  bottom: auto !important;',
    '  width: 100% !important;',
    '  height: auto !important;',
    '  max-height: none !important;',
    '  min-height: 0 !important;',
    '  aspect-ratio: 16 / 9 !important;',
    '  transform: none !important;',
    '  z-index: auto !important;',
    '}',
    // 内側のプレーヤー要素は親に合わせて伸ばす
    'html[data-dualsub-unstick="on"] body #player-container-id #movie_player,',
    'html[data-dualsub-unstick="on"] body #player-container-id #player,',
    'html[data-dualsub-unstick="on"] body #player-container-id #player.player-api,',
    'html[data-dualsub-unstick="on"] body .player-container #movie_player,',
    'html[data-dualsub-unstick="on"] body .player-container #player.player-api {',
    '  height: 100% !important;',
    '  width: 100% !important;',
    '  max-height: none !important;',
    '  padding: 0 !important;',     /* YT の padding-bottom 方式 aspect-ratio を打ち消す */
    '}',
    // .player-size は古い aspect-ratio 確保用 padding を持っている。
    // 我々は親で aspect-ratio: 16/9 を強制したので、二重に効かないよう殺す。
    'html[data-dualsub-unstick="on"] body #player-container-id .player-size,',
    'html[data-dualsub-unstick="on"] body .player-container .player-size {',
    '  padding-bottom: 0 !important;',
    '}',
    // sticky 時に「ここに player があったよ」と空き枠を確保する placeholder。
    // sticky を殺したので不要、display:none で完全除去する。
    'html[data-dualsub-unstick="on"] body .player-size.player-placeholder { display: none !important; }',
    // ytm-app.sticky-player に乗っていた padding-top (header 48px 分) を相殺
    'html[data-dualsub-unstick="on"] body ytm-app.sticky-player { padding-top: 0 !important; }',
    // ヘッダーが sticky-player 状態で fixed になるのも止める
    'html[data-dualsub-unstick="on"] body ytm-header-bar.sticky-player,',
    'html[data-dualsub-unstick="on"] body ytm-mobile-topbar-renderer.sticky-player {',
    '  position: relative !important;',
    '  top: auto !important;',
    '}',
  ].join('\n');

  // -------- watch ページ判定 + scope 属性更新 --------
  // PoC スクリプト側の isWatchPage() と同じ条件: /watch, /embed/<id>, /v/<id>。
  // /shorts と / (ホーム) は対象外。
  function isWatchPage() {
    const p = location.pathname;
    if (p === '/watch') return true;
    if (/^\/(embed|v)\//.test(p)) return true;
    return false;
  }
  function updateScope() {
    document.documentElement.dataset.dualsubUnstick = isWatchPage() ? 'on' : 'off';
  }
  updateScope();
  // YT SPA 遷移: yt-navigate-finish (YT 公式の遷移完了イベント) と popstate を listen。
  // 念のため history.pushState/replaceState も patch (一部の遷移は yt-navigate-finish を
  // 発火しないことがあるため)。
  window.addEventListener('popstate', updateScope);
  document.addEventListener('yt-navigate-finish', updateScope);
  try {
    const origPush = history.pushState;
    history.pushState = function() {
      const r = origPush.apply(this, arguments);
      updateScope();
      return r;
    };
    const origReplace = history.replaceState;
    history.replaceState = function() {
      const r = origReplace.apply(this, arguments);
      updateScope();
      return r;
    };
  } catch (e) { /* ignore */ }

  // -------- <style> 注入(documentElement 直下、自己修復付き)--------
  let styleEl = null;
  function ensureStyle() {
    // 既に DOM に残っていれば何もしない
    if (styleEl && styleEl.isConnected) return;
    try {
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-dualsub', 'unstick');
      styleEl.textContent = CSS_TEXT;
      // <head> は YT に剥がされるので documentElement 直下に置く
      document.documentElement.appendChild(styleEl);
    } catch (e) {
      console.error('[dualsub] unstick style 注入失敗', e);
    }
  }

  ensureStyle();

  // YT が我々の <style> を documentElement から剥がしたら再 append する
  try {
    const obs = new MutationObserver(() => ensureStyle());
    obs.observe(document.documentElement, { childList: true });
  } catch (e) {
    console.error('[dualsub] unstick observer 設置失敗', e);
  }

  // YouTube 内部レイアウトの再計算を誘発する
  try { window.dispatchEvent(new Event('resize')); } catch (e) {}
})();
"""

// 内容ベースの 8 桁 hex ハッシュ。Kotlin 定数や asset を 1 文字でも変えると変わるので、
// 「今動いているコードがどのバージョンか」をリビルド検証用に Logcat / Console へ出す用途。
private fun shortHash(s: String): String =
    s.hashCode().toUInt().toString(16).padStart(8, '0').take(8)

@Composable
fun DualSubWebView(onWebViewReady: (WebView) -> Unit) {
    AndroidView(
        modifier = Modifier,
        factory = { ctx ->
            // assets/dualsub_overlay.js を一度だけ読み込む
            val injectionScript = loadInjectionScript(ctx.assets)

            createConfiguredWebView(ctx, injectionScript).also(onWebViewReady)
        },
    )
}

@SuppressLint("SetJavaScriptEnabled")
private fun createConfiguredWebView(
    context: android.content.Context,
    injectionScript: String,
): WebView {
    // Chrome DevTools (chrome://inspect) から WebView 中身を覗けるようにする
    // (リリースビルドでも有効。個人用途のため。気になれば BuildConfig.DEBUG で絞れる)
    WebView.setWebContentsDebuggingEnabled(true)

    // バージョン識別用ハッシュ。Kotlin / JS asset の中身が変われば変化する。
    val overlayHash = shortHash(injectionScript)
    val unstickHash = shortHash(UNSTICK_PLAYER)
    val spoofHash = shortHash(BROWSER_SPOOF)
    Log.i(TAG, "dualsub build: overlay=$overlayHash unstick=$unstickHash spoof=$spoofHash")

    val webView = WebView(context)

    with(webView.settings) {
        javaScriptEnabled = true
        domStorageEnabled = true          // localStorage 有効化(設定永続化)
        mediaPlaybackRequiresUserGesture = false
        userAgentString = CHROME_MOBILE_UA  // WebView 検知回避
        useWideViewPort = true            // <meta name="viewport"> を尊重する
        loadWithOverviewMode = false      // ページ全体ズームアウトを止める
        setSupportZoom(false)
    }

    // Cookie 永続化(ログイン状態と CC 状態の維持)
    CookieManager.getInstance().apply {
        setAcceptCookie(true)
        setAcceptThirdPartyCookies(webView, true)
    }

    // console.log を Logcat に転送(PoC スクリプトのログ確認用)
    webView.webChromeClient = object : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            val tag = "DualSubJS"
            val msg = "${message.message()} (${message.sourceId()}:${message.lineNumber()})"
            when (message.messageLevel()) {
                ConsoleMessage.MessageLevel.ERROR -> Log.e(tag, msg)
                ConsoleMessage.MessageLevel.WARNING -> Log.w(tag, msg)
                ConsoleMessage.MessageLevel.DEBUG -> Log.d(tag, msg)
                else -> Log.i(tag, msg)
            }
            return true
        }
    }

    // ページロード完了時に dualsub_overlay.js を注入
    webView.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // YouTube ドメイン内は WebView 内遷移、それ以外は WebView 内で許容(外部アプリ起動は今回はしない)
            return false
        }

        // ページ開始時、できるだけ早くブラウザ偽装を注入する。
        // 遅らせるとサイト初期化スクリプトに先に WebView と判定されてしまう。
        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            super.onPageStarted(view, url, favicon)
            if (url == null || !isYouTubeHost(url)) return
            view.evaluateJavascript(
                "console.log('[dualsub] spoof build:', '$spoofHash', '(onPageStarted)');\n$BROWSER_SPOOF",
                null,
            )
            view.evaluateJavascript(
                "console.log('[dualsub] unstick build:', '$unstickHash', '(onPageStarted)');\n$UNSTICK_PLAYER",
                null,
            )
        }

        override fun onPageFinished(view: WebView, url: String?) {
            super.onPageFinished(view, url)
            if (url == null) return
            if (!isYouTubeHost(url)) return
            // 念のため onPageFinished でも UNSTICK_PLAYER を呼ぶ(initial 注入後に
            // YouTube が遅延でクラスを付け直すケースの保険)
            view.evaluateJavascript(
                "console.log('[dualsub] unstick build:', '$unstickHash', '(onPageFinished)');\n$UNSTICK_PLAYER",
                null,
            )
            // 多重インストールガードは JS 側にあるので、毎回 evaluateJavascript で OK
            view.evaluateJavascript(
                "console.log('[dualsub] overlay build:', '$overlayHash');\n$injectionScript",
            ) { result ->
                Log.d(TAG, "Injected dualsub_overlay.js (build=$overlayHash) into $url (result=$result)")
            }
        }
    }

    webView.loadUrl(INITIAL_URL)
    return webView
}

private fun isYouTubeHost(url: String): Boolean {
    return url.startsWith("https://m.youtube.com/") ||
        url.startsWith("https://www.youtube.com/") ||
        url.startsWith("https://youtube.com/")
}

private fun loadInjectionScript(assets: android.content.res.AssetManager): String {
    return assets.open("dualsub_overlay.js").use { input ->
        input.bufferedReader().use(BufferedReader::readText)
    }
}
