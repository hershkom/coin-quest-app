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
 *
 * This service ALSO keeps `foregroundPackage` up to date on every window
 * change (for every app, not just the enforced game -- its config leaves
 * packageNames unrestricted). GameTimeOverlayService polls that value from its
 * own countdown tick to notice when the child has left the game and shut the
 * session down, rather than counting on catching one specific leave-transition
 * event (which proved unreliable on real devices) or on the child tapping the
 * overlay's own close button.
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

        // Track the current foreground app for the overlay's away-detection
        // poll. Ignore our OWN package: the floating countdown overlay is a
        // non-focusable system-overlay window belonging to this app, and if it
        // ever fired a window-state event we must not mistake that for the
        // child having switched to "the CoinQuest app" -- that would make the
        // overlay think the game left the foreground while it's actually still
        // being played underneath. Ignoring it leaves foregroundPackage at the
        // real underlying app (the game, or wherever the child navigated).
        if (pkg != applicationContext.packageName) foregroundPackage = pkg

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

    /** Actively queries which app owns the current active window RIGHT NOW,
     *  rather than relying on a TYPE_WINDOW_STATE_CHANGED event having fired.
     *  This is the reliable path on OEMs (notably Samsung/One UI) where pressing
     *  Home or Back to leave a game does NOT reliably emit a window-state event
     *  -- app LAUNCHES always emit one (so the re-entry block still works), but
     *  the LEAVE transition can be silently dropped, which is exactly why the
     *  event-only away-detection wasn't catching the child exiting the game.
     *  Requires canRetrieveWindowContent=true (see the service config XML).
     *  Returns null if unknown / our own package (so the caller treats it as
     *  "no signal" rather than "left the game"). */
    fun activeWindowPackage(): String? {
        return try {
            val p = rootInActiveWindow?.packageName?.toString()
            if (p == null || p == applicationContext.packageName) null else p
        } catch (e: Exception) { null }
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
        foregroundPackage = null
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    companion object {
        private const val TAG = "CoinQuestGameTime"
        private const val DEADLINE_GRACE_MS = 30_000L

        /** Set while the service is connected; null otherwise. */
        var instance: GameTimeAccessibilityService? = null
            private set

        /** The current foreground app package (this app's own package excluded
         *  -- see onAccessibilityEvent), or null if unknown. @Volatile because
         *  GameTimeOverlayService reads it from its countdown-timer callback,
         *  which may be a different thread than the one writing it here. */
        @Volatile
        var foregroundPackage: String? = null
            private set
    }
}
