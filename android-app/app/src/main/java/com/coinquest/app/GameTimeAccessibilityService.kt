package com.coinquest.app

import android.accessibilityservice.AccessibilityService
import android.content.Context
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
 */
class GameTimeAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.d(TAG, "Accessibility service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return

        val prefs = getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)
        // ENFORCED_PACKAGES is armed on every app launch (see
        // NativeGameBridge.setEnforcedPackages); TARGET_PACKAGE is kept as a
        // fallback so a device that ran an older version (where only the
        // first session ever wrote it) stays blocked even before the web app
        // has re-armed the new pref.
        val enforced = (prefs.getString(GameTimePrefs.ENFORCED_PACKAGES, null) ?: "")
            .split(',').filter { it.isNotBlank() }.toMutableSet()
        prefs.getString(GameTimePrefs.TARGET_PACKAGE, null)?.let { if (it.isNotBlank()) enforced.add(it) }
        if (pkg !in enforced) return

        if (!isSessionValid(prefs)) {
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

        /** Set while the service is connected; null otherwise. */
        var instance: GameTimeAccessibilityService? = null
            private set
    }
}
