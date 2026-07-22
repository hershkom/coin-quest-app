package com.coinquest.app

import android.app.AppOpsManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.widget.Toast
import androidx.core.app.NotificationCompat

/**
 * The always-on enforcement watcher that gates the purchased native game
 * (Minecraft) WITHOUT an AccessibilityService -- the whole point being that it
 * coexists with Google Family Link.
 *
 * Family Link (a Profile Owner) force-disables third-party accessibility
 * services (it sets an empty permitted-accessibility-services policy), which is
 * why the AccessibilityService-based wall silently died on the user's device.
 * Family Link does NOT, however, restrict the "usage access" special permission
 * or the "draw over other apps" overlay permission. So this service reads the
 * current foreground app from UsageStatsManager (usage access) and, when the
 * enforced game is opened without a valid coin-bought session, sends the device
 * back to the home screen (a plain CATEGORY_HOME intent -- allowed from the
 * background because the app holds SYSTEM_ALERT_WINDOW) with a calm toast. The
 * game is never truly playable outside a session, yet Family Link keeps every
 * one of its own controls (web filtering, app-install approval, remote
 * management, screen time). The two enforcement layers run side by side.
 *
 * It also exposes currentForegroundPackage() as the single foreground-detection
 * source for GameTimeOverlayService's away-detection, replacing the
 * accessibility service there too.
 */
class GameWatchService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var lastKickAtMs = 0L

    private val poll = object : Runnable {
        override fun run() {
            try { enforceOnce() } catch (e: Exception) { Log.w(TAG, "poll error", e) }
            handler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        startForegroundWithNotification()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        handler.removeCallbacks(poll)
        handler.post(poll)
        // START_STICKY: MIUI/OEMs kill background work aggressively; ask the
        // system to recreate the watcher if it's killed while a device is
        // meant to be enforced (paired with the BOOT_COMPLETED start).
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacks(poll)
        super.onDestroy()
    }

    private fun enforceOnce() {
        val prefs = getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)
        val enforced = (prefs.getString(GameTimePrefs.ENFORCED_PACKAGES, null) ?: "")
            .split(',').filter { it.isNotBlank() }.toMutableSet()
        prefs.getString(GameTimePrefs.TARGET_PACKAGE, null)?.let { if (it.isNotBlank()) enforced.add(it) }
        if (enforced.isEmpty()) return

        val fg = currentForegroundPackage(this) ?: return
        if (fg !in enforced) return
        if (isSessionValid(prefs)) return // a paid session is running -- allow

        // The game is in the foreground with no valid session -- redirect home.
        val now = System.currentTimeMillis()
        if (now - lastKickAtMs < KICK_COOLDOWN_MS) return
        lastKickAtMs = now
        Log.d(TAG, "Blocked foreground of $fg -- no active paid session; sending home")
        try {
            val home = Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            startActivity(home)
            Toast.makeText(
                applicationContext,
                "אין לך זמן משחק כרגע 🪙 — פתח את כספת המטבעות כדי לקנות זמן",
                Toast.LENGTH_LONG
            ).show()
        } catch (e: Exception) {
            Log.w(TAG, "Could not send home", e)
        }
    }

    private fun isSessionValid(prefs: android.content.SharedPreferences): Boolean {
        if (!prefs.getBoolean(GameTimePrefs.SESSION_ACTIVE, false)) return false
        val endAt = prefs.getLong(GameTimePrefs.SESSION_END_AT, 0L)
        if (endAt > 0L && System.currentTimeMillis() <= endAt + DEADLINE_GRACE_MS) return true
        // Stale ACTIVE flag (overlay process died without clearing it) -- heal it.
        prefs.edit().putBoolean(GameTimePrefs.SESSION_ACTIVE, false)
            .remove(GameTimePrefs.SESSION_END_AT).apply()
        return false
    }

    private fun startForegroundWithNotification() {
        val channelId = "game_watch"
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId, "שמירה על זמן משחק", NotificationManager.IMPORTANCE_MIN
            )
            manager.createNotificationChannel(channel)
        }
        val notification = NotificationCompat.Builder(this, channelId)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("שומר על זמן המשחק")
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        private const val TAG = "CoinQuestGameWatch"
        private const val NOTIFICATION_ID = 2002
        private const val POLL_INTERVAL_MS = 1000L
        // Don't re-fire the home-redirect every single second while the child
        // keeps tapping the game -- one nudge, then a short cooldown, so it's a
        // calm redirect (matching the app's zero-punishment design) rather than
        // a frantic bounce loop.
        private const val KICK_COOLDOWN_MS = 2500L
        private const val DEADLINE_GRACE_MS = 30_000L

        /** True if the parent has granted "usage access" to this app -- the one
         *  special permission this whole watcher depends on. Family Link does
         *  NOT restrict it (unlike accessibility). */
        fun hasUsageAccess(context: Context): Boolean {
            return try {
                val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
                val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    appOps.unsafeCheckOpNoThrow(
                        AppOpsManager.OPSTR_GET_USAGE_STATS,
                        android.os.Process.myUid(), context.packageName
                    )
                } else {
                    @Suppress("DEPRECATION")
                    appOps.checkOpNoThrow(
                        AppOpsManager.OPSTR_GET_USAGE_STATS,
                        android.os.Process.myUid(), context.packageName
                    )
                }
                mode == AppOpsManager.MODE_ALLOWED
            } catch (e: Exception) { false }
        }

        /** The current foreground app package via UsageStatsManager, or null if
         *  unknown / no usage access. Reads the most recent MOVE_TO_FOREGROUND
         *  event in a short trailing window -- reliable across OEMs (unlike the
         *  accessibility "left the app" event that was dropped on Samsung), and
         *  the single foreground source for both the block loop here and the
         *  overlay's away-detection. */
        fun currentForegroundPackage(context: Context): String? {
            if (!hasUsageAccess(context)) return null
            return try {
                val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
                val now = System.currentTimeMillis()
                val events = usm.queryEvents(now - LOOKBACK_MS, now)
                val ev = android.app.usage.UsageEvents.Event()
                var last: String? = null
                while (events.hasNextEvent()) {
                    events.getNextEvent(ev)
                    if (ev.eventType == android.app.usage.UsageEvents.Event.MOVE_TO_FOREGROUND) {
                        last = ev.packageName
                    }
                }
                last
            } catch (e: Exception) { null }
        }

        private const val LOOKBACK_MS = 10_000L
    }
}
