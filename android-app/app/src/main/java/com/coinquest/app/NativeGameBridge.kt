package com.coinquest.app

import android.app.Activity
import android.content.ComponentName
import android.content.Context
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

    /** Fixes Google Sign-In's "Error 403: disallowed_useragent" inside this
     *  WebView -- see the long comment on MainActivity.WEB_CLIENT_ID for
     *  why. Delegates to the Activity since launching the sign-in picker
     *  needs one; the cast is safe, this bridge is only ever constructed
     *  with a MainActivity instance (see MainActivity.onCreate). */
    @JavascriptInterface
    fun nativeGoogleSignIn() {
        activity.runOnUiThread {
            (activity as MainActivity).startNativeGoogleSignIn()
        }
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

    /** Native OS-level event reminders. `json` is a JSON array of
     *  {id, at, title, emoji} for every upcoming event (at = epoch ms when the
     *  reminder should fire). app.js computes it from state.events and pushes
     *  the full list on launch and after any add/delete/remote sync; this just
     *  hands it to EventReminderScheduler, which diffs and (re)arms. */
    @JavascriptInterface
    fun syncEventReminders(json: String) {
        EventReminderScheduler.syncAll(activity, json)
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

    /** True when CoinQuest is the provisioned device owner -- the state that
     *  lets it hard-block (suspend) the native game. app.js gates the native
     *  game-launch feature on this the way it used to gate on accessibility. */
    @JavascriptInterface
    fun isDeviceOwner(): Boolean = GamePolicyManager.isDeviceOwner(activity)

    /** True if "usage access" is granted -- the permission the always-on
     *  GameWatchService wall runs on. This is the enforcement path that
     *  coexists with Family Link (which force-disables accessibility services
     *  but does not touch usage access). */
    @JavascriptInterface
    fun hasUsageAccess(): Boolean = GameWatchService.hasUsageAccess(activity)

    /** Opens the system "usage access" settings screen so the parent can grant
     *  it to CoinQuest (there's no runtime-prompt for this special access). */
    @JavascriptInterface
    fun requestUsageAccess() {
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
            } catch (e: Exception) {
                // Some OEMs hide the direct screen -- fall back to app details.
                activity.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
                )
            }
        }
    }

    /** Starts (or refreshes) the always-on usage-access game wall. Safe to call
     *  repeatedly. No-op without usage access (the service would just idle). */
    @JavascriptInterface
    fun startGameWatch() {
        if (!GameWatchService.hasUsageAccess(activity)) return
        activity.runOnUiThread { startWatch(activity) }
    }

    /** Suspend (block) every enforced native game right now, so a game is
     *  walled off by default whenever no coin-bought session is active.
     *  app.js calls this on launch (and the game stays blocked until a session
     *  unsuspends it). Never suspends the package of a currently-valid session.
     *  No-op if not device owner. `csv` is the same comma-separated package
     *  list app.js already passes to setEnforcedPackages. */
    @JavascriptInterface
    fun blockGames(csv: String) {
        val pkgs = csv.split(',').map { it.trim() }.filter { it.isNotBlank() }
        GamePolicyManager.block(activity, pkgs)
    }

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
        // Immediately assert the device-owner default block, so a game is
        // suspended the moment the app knows about it -- not only after the
        // first session ends. block() itself skips a currently-valid session's
        // target, so this can't kill a game the child is legitimately playing.
        // (No-op if not device owner; the usage-access wall below is the path
        // that actually runs on a Family-Link device.)
        val pkgs = csv.split(',').map { it.trim() }.filter { it.isNotBlank() }
        GamePolicyManager.block(activity, pkgs)
        // Bring up the always-on usage-access wall if it's granted, so the game
        // is guarded from app launch on (the primary enforcement on a
        // Family-Link device, where device-owner/accessibility aren't available).
        if (pkgs.isNotEmpty() && GameWatchService.hasUsageAccess(activity)) startWatch(activity)
    }

    /** Returns false immediately (no session started) if permissions are
     *  missing or the game isn't installed -- a session that can't be
     *  enforced must never start, since enforcement is the entire point. */
    @JavascriptInterface
    fun startNativeSession(pkg: String, seconds: Int, childId: String): Boolean {
        if (seconds <= 0) return false
        // A session that can't be enforced must never start. Enforcement is
        // satisfied by ANY available wall, so this works across device types:
        //  - Usage access (GameWatchService): the Family-Link-compatible wall,
        //    the primary path on this user's MIUI + Family Link device.
        //  - Device Owner: GamePolicyManager suspend/unsuspend (allow() below
        //    is a no-op if we're not owner).
        //  - AccessibilityService: legacy path (dies under Family Link).
        // The overlay permission is required in all cases for the countdown.
        if (!hasOverlayPermission()) return false
        val enforceable = GameWatchService.hasUsageAccess(activity) ||
            GamePolicyManager.isDeviceOwner(activity) ||
            hasAccessibilityPermission()
        if (!enforceable) return false
        val launchIntent = activity.packageManager.getLaunchIntentForPackage(pkg) ?: return false

        // Make sure the always-on wall is running for the usage-access path, and
        // unsuspend for the device-owner path (no-op otherwise).
        startGameWatch()
        GamePolicyManager.allow(activity, pkg)

        activity.runOnUiThread {
            // Start the foreground overlay service BEFORE launching the game:
            // launching the game backgrounds this Activity, and starting a
            // foreground service from the background throws
            // ForegroundServiceStartNotAllowedException on Android 12+.
            val overlayIntent = Intent(activity, GameTimeOverlayService::class.java)
                .putExtra(GameTimeOverlayService.EXTRA_SECONDS, seconds)
                .putExtra(GameTimeOverlayService.EXTRA_PACKAGE, pkg)
                .putExtra(GameTimeOverlayService.EXTRA_CHILD_ID, childId)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(overlayIntent)
            } else {
                activity.startService(overlayIntent)
            }
            activity.startActivity(launchIntent)
        }
        return true
    }

    /** Crash backstop for native game time (see GameTimePrefs.CONSUMED_PENDING_*):
     *  the web app reads these on launch and, if a session ended without its
     *  onNativeGameSessionEnded callback being delivered (app process killed
     *  mid-game), debits the pending seconds against the right child, then
     *  calls clearPendingConsumed(). */
    @JavascriptInterface
    fun getPendingConsumedSeconds(): Int {
        return activity.getSharedPreferences(GameTimePrefs.NAME, android.content.Context.MODE_PRIVATE)
            .getInt(GameTimePrefs.CONSUMED_PENDING_SECONDS, 0)
    }
    @JavascriptInterface
    fun getPendingConsumedChild(): String {
        return activity.getSharedPreferences(GameTimePrefs.NAME, android.content.Context.MODE_PRIVATE)
            .getString(GameTimePrefs.CONSUMED_PENDING_CHILD, "") ?: ""
    }
    @JavascriptInterface
    fun clearPendingConsumed() {
        activity.getSharedPreferences(GameTimePrefs.NAME, android.content.Context.MODE_PRIVATE)
            .edit().putInt(GameTimePrefs.CONSUMED_PENDING_SECONDS, 0)
            .remove(GameTimePrefs.CONSUMED_PENDING_CHILD).apply()
    }

    private fun notifyEnded(consumedSeconds: Int, childId: String) {
        activity.runOnUiThread {
            webView.evaluateJavascript(
                "window.onNativeGameSessionEnded && window.onNativeGameSessionEnded($consumedSeconds,${org.json.JSONObject.quote(childId)});",
                null
            )
        }
    }

    companion object {
        // GameTimeOverlayService (a Service, not the Activity) reaches the
        // WebView through this static hook rather than needing its own
        // Activity/WebView references.
        private var instance: NativeGameBridge? = null

        /** Start the always-on usage-access game wall. Reused from the bridge
         *  (app launch) and ReminderReceiver (BOOT_COMPLETED). Caller checks
         *  usage access first; this just fires the foreground service. */
        fun startWatch(context: Context) {
            try {
                val intent = Intent(context, GameWatchService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) { /* OEM background-start limits: retried next launch */ }
        }

        fun notifySessionEnded(consumedSeconds: Int, childId: String) {
            instance?.notifyEnded(consumedSeconds, childId)
        }

        /** Clear the static Activity/WebView reference when the bridge's
         *  Activity is destroyed, so a rotated-away/finished MainActivity (and
         *  its WebView) isn't leaked for the process lifetime. */
        fun clearInstance(b: NativeGameBridge) {
            if (instance === b) instance = null
        }
    }
}
