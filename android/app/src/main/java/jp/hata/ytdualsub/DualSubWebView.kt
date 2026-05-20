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
private const val MOBILE_UA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"

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
    val webView = WebView(context)

    with(webView.settings) {
        javaScriptEnabled = true
        domStorageEnabled = true          // localStorage 有効化(設定永続化)
        mediaPlaybackRequiresUserGesture = false
        userAgentString = MOBILE_UA       // m.youtube.com を出させる
        loadWithOverviewMode = true
        useWideViewPort = true
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
            if (url == null) return
            if (!isYouTubeHost(url)) return
            // 多重インストールガードは JS 側にあるので、毎回 evaluateJavascript で OK
            view.evaluateJavascript(injectionScript) { result ->
                Log.d(TAG, "Injected dualsub_overlay.js into $url (result=$result)")
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
