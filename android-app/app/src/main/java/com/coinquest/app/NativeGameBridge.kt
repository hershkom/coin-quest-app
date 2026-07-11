package com.coinquest.app

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.text.TextUtils
import android.webkit.JavascriptInterface
import android.webkit.WebView

/**
 * Exposed to the web app as `window.CoinQuestNative` -- lets app.js redeem
 * bought game-time minutes against a real, purchased native app (Minecraft)
 * instead of only the web-embedded games, with the same enforced-countdown
 * mechanism proven in the standalone ScreenTimeSpike project (Accessibility
 * Service + floating overlay + performGlobalAction(GLOBAL_ACTION_HOME)).
 *
 * All @JavascriptInterface methods are called by the WebView on a background
 * thread, not the UI thread -- anything touching Activity/window APIs is
 * explicitly hopped onto the UI thread.
 */
class NativeGameBridge(private val activity: Activity, private val webView: WebView) {

    init { instance = this }

    @JavascriptInterface
    fun isPackageInstalled(pkg: String): Boolean {
        return try {
            activity.packageManager.getLaunchIntentForPackage(pkg) != null
        } catch (e: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun hasOverlayPermission(): Boolean = Settings.canDrawOverlays(activity)

    @JavascriptInterface
    fun hasAccessibilityPermission(): Boolean {
        val expected = ComponentName(activity, GameTimeAccessibilityService::class.java)
        val enabled = Settings.Secure.getString(
            activity.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val splitter = TextUtils.SimpleStringSplitter(':')
        splitter.setString(enabled)
        for (name in splitter) {
            if (ComponentName.unflattenFromString(name) == expected) return true
        }
        return false
    }

    @JavascriptInterface
    fun requestOverlayPermission() {
        activity.runOnUiThread {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${activity.packageName}")
            )
            activity.startActivity(intent)
        }
    }

    @JavascriptInterface
    fun requestAccessibilityPermission() {
        activity.runOnUiThread {
            activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
    }

    /** Returns false immediately (no session started) if permissions are
     *  missing or the game isn't installed -- a session that can't be
     *  enforced must never start, since enforcement is the entire point. */
    @JavascriptInterface
    fun startNativeSession(pkg: String, seconds: Int): Boolean {
        if (seconds <= 0) return false
        if (!hasOverlayPermission() || !hasAccessibilityPermission()) return false
        val launchIntent = activity.packageManager.getLaunchIntentForPackage(pkg) ?: return false

        activity.runOnUiThread {
            // Start the foreground overlay service BEFORE launching the game:
            // launching the game backgrounds this Activity, and starting a
            // foreground service from the background throws
            // ForegroundServiceStartNotAllowedException on Android 12+.
            val overlayIntent = Intent(activity, GameTimeOverlayService::class.java)
                .putExtra(GameTimeOverlayService.EXTRA_SECONDS, seconds)
                .putExtra(GameTimeOverlayService.EXTRA_PACKAGE, pkg)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(overlayIntent)
            } else {
                activity.startService(overlayIntent)
            }
            activity.startActivity(launchIntent)
        }
        return true
    }

    private fun notifyEnded(consumedSeconds: Int) {
        activity.runOnUiThread {
            webView.evaluateJavascript(
                "window.onNativeGameSessionEnded && window.onNativeGameSessionEnded($consumedSeconds);",
                null
            )
        }
    }

    companion object {
        // GameTimeOverlayService (a Service, not the Activity) reaches the
        // WebView through this static hook rather than needing its own
        // Activity/WebView references.
        private var instance: NativeGameBridge? = null

        fun notifySessionEnded(consumedSeconds: Int) {
            instance?.notifyEnded(consumedSeconds)
        }
    }
}
