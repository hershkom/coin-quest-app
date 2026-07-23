package com.coinquest.app

/** Shared SharedPreferences keys for native game-time enforcement, used by
 *  GameTimeOverlayService (writer), GameTimeAccessibilityService (reader) and
 *  NativeGameBridge (arming) -- kept in prefs rather than only in-memory so
 *  the re-block guard survives the app process being killed and restarted by
 *  Android, which is exactly when a background AccessibilityService is most
 *  likely to still be alive on its own. */
object GameTimePrefs {
    const val NAME = "coinquest_gametime"
    const val TARGET_PACKAGE = "target_package"
    const val SESSION_ACTIVE = "session_active"

    /** CSV of package names that must ALWAYS be blocked outside a paid
     *  session. Written by NativeGameBridge.setEnforcedPackages() on every
     *  app launch (and by the overlay service as a session starts, as
     *  defense in depth). Exists because TARGET_PACKAGE alone was only
     *  written when the FIRST session ever started -- meaning on a fresh
     *  install the accessibility service had no idea what to block and the
     *  child could open the game freely without ever buying time. */
    const val ENFORCED_PACKAGES = "enforced_packages"

    /** Wall-clock ms (System.currentTimeMillis) when the current session is
     *  due to end, written alongside SESSION_ACTIVE=true. Failsafe for the
     *  overlay-service process dying mid-session (crash/OOM/force-stop):
     *  without it, a stale SESSION_ACTIVE=true meant the accessibility
     *  service allowed the game forever. The accessibility service treats an
     *  ACTIVE flag whose deadline has passed as NOT active and self-heals
     *  the flag. Wall clock (not elapsedRealtime) so it survives a reboot;
     *  the countdown that ends real sessions is still the monotonic
     *  CountDownTimer -- this deadline is only the crash backstop. */
    const val SESSION_END_AT = "session_end_at"

    /** The child id (web-side profile id) the current session was started for.
     *  Passed in by NativeGameBridge.startNativeSession and echoed back when the
     *  session ends, so the wallet debit lands on the child who actually played
     *  -- not on whoever happens to be the active profile when the session ends
     *  (a sibling could be switched to while the game ran in the foreground). */
    const val SESSION_CHILD_ID = "session_child_id"

    /** Crash-safe record of time actually consumed by a session, updated every
     *  tick by the overlay service. If the app process is killed mid-game the
     *  onNativeGameSessionEnded WebView callback never arrives and the wallet
     *  would never be debited (the child effectively played for free). The web
     *  app reads these on the next launch and debits the pending amount, then
     *  clears them. The normal end-of-session callback also clears them (via
     *  clearPendingConsumed) so the two paths never double-count. */
    const val CONSUMED_PENDING_SECONDS = "consumed_pending_seconds"
    const val CONSUMED_PENDING_CHILD = "consumed_pending_child"

    /** Set on a PARENT's own install (a device used for remote admin/control,
     *  not a child's device) to turn off the entire game-time enforcement
     *  watcher on THIS install -- there's no child here to enforce against,
     *  so a persistent background service/notification/suspended-games-list
     *  is pure downside (battery, confusion, and would suspend a game the
     *  parent themselves has installed). Device-local only, deliberately not
     *  synced via Firebase: it describes this physical install, not the family. */
    const val PARENT_DEVICE_MODE = "parent_device_mode"
}
