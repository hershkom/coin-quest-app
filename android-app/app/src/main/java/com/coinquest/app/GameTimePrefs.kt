package com.coinquest.app

/** Shared SharedPreferences keys for native game-time enforcement, used by
 *  both GameTimeOverlayService (writer) and GameTimeAccessibilityService
 *  (reader) -- kept in prefs rather than only in-memory so the re-block
 *  guard survives the app process being killed and restarted by Android,
 *  which is exactly when a background AccessibilityService is most likely
 *  to still be alive on its own. */
object GameTimePrefs {
    const val NAME = "coinquest_gametime"
    const val TARGET_PACKAGE = "target_package"
    const val SESSION_ACTIVE = "session_active"
}
