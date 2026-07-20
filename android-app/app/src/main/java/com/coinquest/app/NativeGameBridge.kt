package com.coinquest.app

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.text.TextUtils
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.util.Locale

/**
 * Exposed to the web app as `window.CoinQuestNative` -- lets app.js redeem
 * bought game-time minutes against a real, purchased native app (Minecraft)
 * instead of only the web-embedded games, with the same enforced-countdown
 * mechanism proven in the standalone ScreenTimeSpike project (Accessibility
 * Service + floating overlay + performGlobalAction(GLOBAL_ACTION_HOME)).
 *
 * Also exposes Android's own TextToSpeech engine (AN1, ANDROID-APP-PLAN.md):
 * the WebView's bundled Web Speech API often has no Hebrew voice installed
 * at all, while the OS-level TTS engine is far more reliably available --
 * app.js's speakWithHighlight() prefers this path when ttsAvailable() is
 * true and falls back to speechSynthesis otherwise.
 *
 * All @JavascriptInterface methods are called by the WebView on a background
 * thread, not the UI thread -- anything touching Activity/window APIs is
 * explicitly hopped onto the UI thread.
 */
class NativeGameBridge(private val activity: Activity, private val webView: WebView) {

    private var tts: TextToSpeech? = null
    @Volatile private var ttsReady = false

    init {
        instance = this
        tts = TextToSpeech(activity) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) {
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) { notifyTtsEnd(utteranceId) }
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) { notifyTtsEnd(utteranceId) }
                    override fun onError(utteranceId: String?, errorCode: Int) { notifyTtsEnd(utteranceId) }
                    // Per-word position callback -- only exists on API 26+. On
                    // older devices speech still plays via onDone/onError above,
                    // just without a live word highlight in the web UI.
                    override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) {
                        notifyTtsBoundary(utteranceId, start)
                    }
                })
            }
        }
    }

    private fun notifyTtsBoundary(utteranceId: String?, charIndex: Int) {
        val uid = utteranceId ?: return
        activity.runOnUiThread {
            webView.evaluateJavascript(
                "window._nativeTtsBoundary && window._nativeTtsBoundary('$uid',$charIndex);", null
            )
        }
    }
    private fun notifyTtsEnd(utteranceId: String?) {
        val uid = utteranceId ?: return
        activity.runOnUiThread {
            webView.evaluateJavascript(
                "window._nativeTtsEnd && window._nativeTtsEnd('$uid');", null
            )
        }
    }

    /** False until the engine has actually finished initializing -- checked
     *  fresh on every call from app.js rather than cached, since init is async
     *  and may still be in flight the first time a question tries to speak
     *  (in which case app.js's Web Speech fallback takes over instead). */
    @JavascriptInterface
    fun ttsAvailable(): Boolean = ttsReady && tts != null

    /** `lang` is a BCP-47-ish tag like "he-IL" or "en-US" (exactly what
     *  app.js already passes to SpeechSynthesisUtterance.lang) -- split on
     *  '-' into a Locale rather than requiring a second format. `rate`
     *  mirrors SpeechSynthesisUtterance.rate (1.0 = normal); app.js passes a
     *  slower value in calm mode (A6, ANDROID-APP-PLAN.md), same as the Web
     *  Speech fallback path. Returns false (and speaks nothing) if the
     *  engine isn't ready or the language/voice isn't available, so the
     *  caller can fall back cleanly. */
    @JavascriptInterface
    fun ttsSpeak(text: String, lang: String, utteranceId: String, rate: Float): Boolean {
        val engine = tts ?: return false
        if (!ttsReady) return false
        val parts = lang.split("-")
        val locale = if (parts.size >= 2) Locale(parts[0], parts[1]) else Locale(parts[0])
        if (engine.isLanguageAvailable(locale) < TextToSpeech.LANG_AVAILABLE) return false
        engine.language = locale
        engine.setSpeechRate(if (rate > 0f) rate else 1.0f)
        val params = Bundle()
        val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
        return result == TextToSpeech.SUCCESS
    }

    @JavascriptInterface
    fun ttsStop() {
        try { tts?.stop() } catch (e: Exception) { /* nothing to clean up */ }
    }

    /** AN5 (ANDROID-APP-PLAN.md): hour/minute are local 24h wall-clock
     *  values (e.g. 8, 0), chosen by the parent in Admin Settings. Persists
     *  across app restarts AND device reboots (see ChoreReminderScheduler/
     *  ReminderReceiver's BOOT_COMPLETED handling). */
    @JavascriptInterface
    fun scheduleChoreReminder(hour: Int, minute: Int) {
        ChoreReminderScheduler.schedule(activity, hour, minute)
    }
    @JavascriptInterface
    fun cancelChoreReminder() {
        ChoreReminderScheduler.cancel(activity)
    }

    /** AN6 (ANDROID-APP-PLAN.md): app.js toggles this on entering/leaving a
     *  learning question or game view, so the screen doesn't time out and
     *  lock mid-question -- a real interruption for a child who's slower to
     *  read/respond than the OS's default screen timeout assumes. */
    @JavascriptInterface
    fun keepScreenOn(on: Boolean) {
        activity.runOnUiThread {
            if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    /** AN8 (ANDROID-APP-PLAN.md): lets app.js compare this install against
     *  the latest published family-flavor release (see build-apk.yml) and
     *  show a parent-only "update available" banner -- there's no Play
     *  Store auto-update path for a sideloaded APK. Falls back to -1 (never
     *  "newer than -1", so no false update prompt) if it can't be read. */
    @JavascriptInterface
    fun getVersionCode(): Int {
        return try {
            val pkgInfo = activity.packageManager.getPackageInfo(activity.packageName, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pkgInfo.longVersionCode.toInt() else @Suppress("DEPRECATION") pkgInfo.versionCode
        } catch (e: Exception) { -1 }
    }

    /** Called from MainActivity.onDestroy() -- releases the TTS engine so it
     *  doesn't leak past the Activity's lifecycle. */
    fun shutdownTts() {
        try { tts?.stop(); tts?.shutdown() } catch (e: Exception) { }
        tts = null
        ttsReady = false
    }

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

    /** Arms the always-on wall for the given packages (CSV) -- called by
     *  app.js on every launch with every native game it knows about. Without
     *  this, the accessibility service only learned WHAT to block when the
     *  first paid session ever started, so on a fresh install the child
     *  could open the game freely without ever buying time. Replaces (not
     *  merges) the stored set so a game a parent removed from the app stops
     *  being blocked too. */
    @JavascriptInterface
    fun setEnforcedPackages(csv: String) {
        activity.getSharedPreferences(GameTimePrefs.NAME, android.content.Context.MODE_PRIVATE)
            .edit().putString(GameTimePrefs.ENFORCED_PACKAGES, csv.trim()).apply()
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
