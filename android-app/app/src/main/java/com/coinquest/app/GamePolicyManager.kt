package com.coinquest.app

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log

/**
 * The Device-Owner enforcement layer that replaced the AccessibilityService as
 * the thing that keeps the purchased native game (Minecraft) walled off unless
 * a coin-bought session is active.
 *
 * When CoinQuest is provisioned as device owner, DevicePolicyManager lets us
 * setPackagesSuspended(game, true) -- a suspended app cannot be launched at all
 * (tapping it shows a system "paused" dialog we customize to point back at
 * CoinQuest), and this holds at the OS policy level, so unlike the old
 * accessibility approach there is no window where the child can slip the game
 * open before a watcher reacts, and nothing (notably Google Family Link, which
 * force-disables third-party accessibility services) can quietly switch it off.
 *
 * Model:
 *  - Default / no active session: every enforced game is SUSPENDED (block()).
 *  - Session bought: the target game is UNSUSPENDED just before launch (allow()).
 *  - Session ends (timeout / ✖ / left game): the game is SUSPENDED again.
 *
 * Every entry point is a no-op-safe if we're not device owner (returns false),
 * so a not-yet-provisioned install simply can't start native sessions rather
 * than crashing -- NativeGameBridge.startNativeSession() checks isDeviceOwner()
 * up front for exactly that reason.
 */
object GamePolicyManager {

    private const val TAG = "CoinQuestGamePolicy"

    private fun dpm(context: Context) =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager

    /** True only when this app is the provisioned device owner -- the sole
     *  state in which setPackagesSuspended is permitted for us. */
    fun isDeviceOwner(context: Context): Boolean {
        return try {
            dpm(context).isDeviceOwnerApp(context.packageName)
        } catch (e: Exception) {
            false
        }
    }

    /** Suspend (block) the given packages. Called on app launch and whenever a
     *  session ends, so the enforced game is walled off by default. Silently
     *  skips packages that aren't installed AND the package of a currently-valid
     *  session (so a default-block on launch can never suspend a game the child
     *  is legitimately mid-session in). Returns true if the policy call ran
     *  (device owner); false if we're not device owner. */
    fun block(context: Context, packages: Collection<String>): Boolean {
        val prefs = context.getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)
        val sessionActive = prefs.getBoolean(GameTimePrefs.SESSION_ACTIVE, false)
        val endAt = prefs.getLong(GameTimePrefs.SESSION_END_AT, 0L)
        val activeTarget = if (sessionActive && endAt > System.currentTimeMillis())
            prefs.getString(GameTimePrefs.TARGET_PACKAGE, null) else null
        val toBlock = packages.filter { it != activeTarget }
        return setSuspended(context, toBlock, true)
    }

    /** Unsuspend (allow) a single package right before launching a bought
     *  session. Returns true on success. */
    fun allow(context: Context, pkg: String): Boolean =
        setSuspended(context, listOf(pkg), false)

    private fun setSuspended(context: Context, packages: Collection<String>, suspended: Boolean): Boolean {
        if (!isDeviceOwner(context)) return false
        val admin = CoinQuestDeviceAdminReceiver.componentName(context)
        val dpm = dpm(context)
        val installed = packages.filter { it.isNotBlank() && isInstalled(context, it) }
        if (installed.isEmpty()) return true
        return try {
            // Returns the subset that could NOT be suspended (e.g. a package
            // that's exempt); an empty/return-all-succeeded result is normal.
            val failed = dpm.setPackagesSuspended(admin, installed.toTypedArray(), suspended)
            Log.d(TAG, "setPackagesSuspended(suspended=$suspended) applied to $installed; failed=${failed.toList()}")
            true
        } catch (e: Exception) {
            Log.w(TAG, "setPackagesSuspended failed", e)
            false
        }
    }

    private fun isInstalled(context: Context, pkg: String): Boolean {
        return try {
            context.packageManager.getApplicationInfo(pkg, 0)
            true
        } catch (e: PackageManager.NameNotFoundException) {
            false
        }
    }
}
