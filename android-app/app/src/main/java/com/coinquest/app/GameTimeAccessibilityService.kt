package com.coinquest.app

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.widget.Toast

/**
 * Watches for the configured native game's package coming to the foreground.
 *
 * Core mechanism (foreground detection + performGlobalAction(GLOBAL_ACTION_HOME))
 * is unchanged from the standalone ScreenTimeSpike project, confirmed working
 * on a real device before this integration. What's NEW here, closing a gap the
 * spike's own findings explicitly flagged as open ("nothing stops the child
 * from manually reopening the game after the session ends"): if the target
 * package comes to the foreground while no paid session is active, it is
 * immediately sent home again, every time -- the game is walled off unless a
 * session bought with real coins is currently running.
 *
 * Also watches the OPPOSITE direction: the child leaving the target game while
 * a paid session is still running (Home/Back to the launcher, switching to a
 * different app). Before this, the floating countdown overlay had no idea the
 * child had left -- it just kept draining the purchased minutes in the
 * background until the timer ran out or they went back in specifically to tap
 * the overlay's own close button. See scheduleAwayEnd/cancelPendingAwayEnd.
 */
class GameTimeAccessibilityService : AccessibilityService() {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingAwayEnd: Runnable? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.d(TAG, "Accessibility service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return

        val prefs = getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)
        val sessionTarget = prefs.getString(GameTimePrefs.TARGET_PACKAGE, null)
        val sessionActive = isSessionValid(prefs)

        // packageNames is deliberately unrestricted in this service's config
        // (see game_time_accessibility_config.xml), so this fires for EVERY
        // app's foreground change, not just the enforced game(s) -- which is
        // exactly what lets us notice the child switching away from an active
        // session's target, something the enforced-only check below can't see
        // (it bails out immediately for any package that isn't in the list).
        if (sessionActive && sessionTarget != null) {
            if (pkg == sessionTarget) cancelPendingAwayEnd() // back in the game -- false alarm cancelled
            else scheduleAwayEnd(sessionTarget)
        }

        // ENFORCED_PACKAGES is armed on every app launch (see
        // NativeGameBridge.setEnforcedPackages); TARGET_PACKAGE is kept as a
        // fallback so a device that ran an older version (where only the
        // first session ever wrote it) stays blocked even before the web app
        // has re-armed the new pref.
        val enforced = (prefs.getString(GameTimePrefs.ENFORCED_PACKAGES, null) ?: "")
            .split(',').filter { it.isNotBlank() }.toMutableSet()
        sessionTarget?.let { if (it.isNotBlank()) enforced.add(it) }
        if (pkg !in enforced) return

        if (!sessionActive) {
            Log.d(TAG, "Blocked foreground of $pkg -- no active paid session")
            Toast.makeText(
                applicationContext,
                "אין לך זמן משחק כרגע 🪙 — פתח את כספת המטבעות כדי לקנות זמן",
                Toast.LENGTH_LONG
            ).show()
            performGlobalAction(GLOBAL_ACTION_HOME)
        } else {
            Log.d(TAG, "$pkg is in the foreground during an active session")
        }
    }

    /** Grace period before treating "child left the game" as genuinely done.
     *  Long enough that a quick notification-shade peek, an incoming system
     *  dialog, or a brief app-switcher glance over the game doesn't burn the
     *  whole session; short enough that actually leaving (home screen,
     *  another app) stops wasting purchased time within a few seconds instead
     *  of running the full purchased duration in the background. */
    private fun scheduleAwayEnd(targetPackage: String) {
        if (pendingAwayEnd != null) return // already counting down since they first left -- don't keep restarting it
        val r = Runnable {
            pendingAwayEnd = null
            val prefs = getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)
            // Re-check on fire: still away, and still the SAME active session
            // (covers the timer firing after the session already ended some
            // other way, e.g. the child tapped the overlay's own close button
            // in the meantime).
            if (isSessionValid(prefs) && prefs.getString(GameTimePrefs.TARGET_PACKAGE, null) == targetPackage) {
                Log.d(TAG, "Child left $targetPackage for ${AWAY_GRACE_MS}ms -- ending the session early")
                GameTimeOverlayService.instance?.endEarlyDueToAppSwitch()
            }
        }
        pendingAwayEnd = r
        mainHandler.postDelayed(r, AWAY_GRACE_MS)
    }

    private fun cancelPendingAwayEnd() {
        pendingAwayEnd?.let { mainHandler.removeCallbacks(it) }
        pendingAwayEnd = null
    }

    /** A session is valid only if the ACTIVE flag is set AND its wall-clock
     *  deadline hasn't passed (plus a small grace for clock skew between the
     *  writer and this check). A stale ACTIVE flag -- the overlay service's
     *  process died mid-session without running endSession() -- used to mean
     *  the game was allowed FOREVER; now it's detected here, self-healed,
     *  and blocked. A missing deadline with ACTIVE=true is treated as stale
     *  too (every current writer sets both together). */
    private fun isSessionValid(prefs: android.content.SharedPreferences): Boolean {
        if (!prefs.getBoolean(GameTimePrefs.SESSION_ACTIVE, false)) return false
        val endAt = prefs.getLong(GameTimePrefs.SESSION_END_AT, 0L)
        if (endAt > 0L && System.currentTimeMillis() <= endAt + DEADLINE_GRACE_MS) return true
        Log.w(TAG, "Stale SESSION_ACTIVE flag (deadline ${endAt}) -- self-healing to inactive")
        prefs.edit().putBoolean(GameTimePrefs.SESSION_ACTIVE, false).remove(GameTimePrefs.SESSION_END_AT).apply()
        return false
    }

    override fun onInterrupt() {
        Log.d(TAG, "Accessibility service interrupted")
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        Log.d(TAG, "Accessibility service unbound")
        cancelPendingAwayEnd()
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    /** Called by GameTimeOverlayService when a session ends (timeout or early stop). */
    fun goHome() {
        Log.d(TAG, "Forcing home via GLOBAL_ACTION_HOME")
        performGlobalAction(GLOBAL_ACTION_HOME)
    }

    companion object {
        private const val TAG = "CoinQuestGameTime"
        private const val DEADLINE_GRACE_MS = 30_000L
        private const val AWAY_GRACE_MS = 4_000L

        /** Set while the service is connected; null otherwise. */
        var instance: GameTimeAccessibilityService? = null
            private set
    }
}
