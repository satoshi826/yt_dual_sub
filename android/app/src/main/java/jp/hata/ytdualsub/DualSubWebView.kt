package jp.hata.ytdualsub

import android.annotation.SuppressLint
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.view.ViewGroup
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import java.io.BufferedReader

private const val TAG = "DualSubWebView"

private const val INITIAL_URL = "https://m.youtube.com/"

// 内容ベースの 8 桁 hex ハッシュ。assets/dualsub_overlay.js が 1 文字でも変われば
// 変わるので、「今動いているコードがどのバージョンか」をリビルド検証用に
// Logcat / Console へ出す用途。
private fun shortHash(s: String): String =
    s.hashCode().toUInt().toString(16).padStart(8, '0').take(8)

@Composable
fun DualSubWebView(onWebViewReady: (WebView) -> Unit) {
    // 重要: AndroidView は必ず Modifier.fillMaxSize() を付ける。これを忘れると
    // Compose 側の measure pass で WebView の高さ制約が宙ぶらりんになり、
    // 内部の Chromium CSS engine が viewport height=0 と認識する。結果、
    // matchMedia('(orientation: landscape)') が portrait なのに true を返し、
    // m.youtube.com の landscape 用 CSS (~190 ルール) が誤適用され player が
    // 125px に縮む等の症状が出る。WebView 側の layoutParams も MATCH_PARENT を
    // 明示している(下記 createConfiguredWebView 内)。
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
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

    val overlayHash = shortHash(injectionScript)
    Log.i(TAG, "dualsub build: overlay=$overlayHash")

    val webView = WebView(context).apply {
        // layoutParams を MATCH_PARENT で明示。これが無いと WebView の高さが 0 として
        // 内部 CSS engine に通知され、matchMedia('(orientation: landscape)') が誤って
        // true を返す。AndroidView 側の Modifier.fillMaxSize と対になる設定。
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
    }

    with(webView.settings) {
        javaScriptEnabled = true
        domStorageEnabled = true          // localStorage 有効化(設定永続化)
        mediaPlaybackRequiresUserGesture = false
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

        override fun onPageFinished(view: WebView, url: String?) {
            super.onPageFinished(view, url)
            if (url == null || !isYouTubeHost(url)) return
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
