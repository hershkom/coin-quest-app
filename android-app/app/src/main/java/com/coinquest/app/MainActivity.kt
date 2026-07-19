package com.coinquest.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.*
import android.widget.ProgressBar
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var nativeBridge: NativeGameBridge
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private val FILE_CHOOSER_REQUEST = 100
    private val PERMISSION_REQUEST = 101
    // Firebase Hosting (same-origin with authDomain) — required for Google
    // sign-in to survive the OAuth redirect round-trip on mobile browsers.
    // firebaseapp.com, not web.app: only it is pre-authorized on the OAuth client.
    private val APP_URL = "https://coin-quest-app.firebaseapp.com/"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        progressBar = findViewById(R.id.progressBar)
        swipeRefresh = findViewById(R.id.swipeRefresh)

        requestPermissions()
        setupWebView()
        // Real-purchased-game time enforcement (see NativeGameBridge/
        // GameTimeOverlayService/GameTimeAccessibilityService) -- exposed as
        // window.CoinQuestNative to app.js. Harmless no-op if the web app
        // never calls it (e.g. running in a plain browser during dev).
        nativeBridge = NativeGameBridge(this, webView)
        webView.addJavascriptInterface(nativeBridge, "CoinQuestNative")
        webView.loadUrl(APP_URL)

        // AN4 (ANDROID-APP-PLAN.md): a pull-to-refresh gesture used to reload
        // the page (and silently wipe whatever question/game state was on
        // screen) from ANY accidental downward swipe -- a real risk for a
        // 7-year-old's touch habits. Disabled entirely; a manual refresh
        // button lives in Admin Settings (parent-only, behind the PIN) for
        // the rare case something needs a full reload.
        swipeRefresh.isEnabled = false
        swipeRefresh.setColorSchemeResources(R.color.purple)
    }

    private fun requestPermissions() {
        val needed = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) needed.add(Manifest.permission.CAMERA)
        // So the game-time foreground-service notification is actually visible
        // to the parent on Android 13+; not required for enforcement to work.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) needed.add(Manifest.permission.POST_NOTIFICATIONS)
        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERMISSION_REQUEST)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Subframe navigations (e.g. the in-app game portal's iframe
                // loading a web-embedded game like ClassiCube) must stay inside
                // the WebView — kicking them to an external browser would both
                // break the game and escape the app's screen-time enforcement.
                if (!request.isForMainFrame) return false
                val url = request.url.toString()
                // Stay in-app only for the coin-quest domain
                if (url.startsWith("https://coin-quest-app.web.app") ||
                    url.startsWith("https://coin-quest-app.firebaseapp.com") ||
                    url.startsWith("https://hershkom.github.io") ||
                    url.startsWith("https://generativelanguage.googleapis.com") ||
                    url.startsWith("https://api.groq.com") ||
                    url.startsWith("https://accounts.google.com")) {
                    return false
                }
                // Open other URLs in external browser
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                progressBar.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView, url: String) {
                progressBar.visibility = View.GONE
                swipeRefresh.isRefreshing = false
            }

            // AN3 (ANDROID-APP-PLAN.md): the web app's own service worker
            // (sw.js) already covers offline use for anything visited before
            // -- this only fires for the genuinely uncovered gap: a cold
            // first launch with zero connectivity ever, before the SW has
            // cached anything, where WebView would otherwise show Chromium's
            // own English "no internet" error page. Loads a local, Hebrew,
            // on-brand fallback instead. Sub-frame errors (e.g. an
            // embedded game's iframe failing) are left alone.
            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: android.webkit.WebResourceError
            ) {
                if (request.isForMainFrame) {
                    view.loadUrl("file:///android_asset/offline.html")
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            // Camera & microphone permissions for WebRTC / QR / voice
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    request.grant(request.resources)
                }
            }

            // File chooser for image uploads
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = filePathCallback
                val intent = Intent(Intent.ACTION_GET_CONTENT)
                intent.addCategory(Intent.CATEGORY_OPENABLE)
                intent.type = "image/*"
                startActivityForResult(Intent.createChooser(intent, "בחר תמונה"), FILE_CHOOSER_REQUEST)
                return true
            }

            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progressBar.progress = newProgress
                if (newProgress == 100) progressBar.visibility = View.GONE
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == FILE_CHOOSER_REQUEST) {
            val results = if (resultCode == Activity.RESULT_OK && data != null)
                arrayOf(data.data ?: return fileUploadCallback?.onReceiveValue(null).also { fileUploadCallback = null } ?: Unit)
            else null
            fileUploadCallback?.onReceiveValue(results)
            fileUploadCallback = null
        }
    }

    // AN4 (ANDROID-APP-PLAN.md): with no WebView history left, the OLD
    // behavior exited the app on a single back-press -- one accidental tap
    // (or a curious kid mashing buttons) silently closed everything mid-task.
    // Now it asks first, in the app's own Hebrew tone, via a plain native
    // AlertDialog (works even if the WebView itself is what's unresponsive).
    override fun onBackPressed() {
        if (webView.canGoBack()) { webView.goBack(); return }
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("לצאת מהאפליקציה?")
            .setPositiveButton("כן") { _, _ -> super.onBackPressed() }
            .setNegativeButton("לא", null)
            .show()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onDestroy() {
        nativeBridge.shutdownTts()
        super.onDestroy()
    }
}
