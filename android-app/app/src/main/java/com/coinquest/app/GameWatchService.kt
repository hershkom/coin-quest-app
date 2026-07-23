package com.coinquest.app

import android.app.AppOpsManager
import android.app.PendingIntent
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat

/**
 * The always-on enforcement wall that gates the purchased native game
 * (Minecraft) WITHOUT an AccessibilityService, so it coexists with Google
 * Family Link (which force-disables accessibility services but does NOT touch
 * usage access or the overlay permission).
 *
 * How it blocks: it reads the foreground app from UsageStatsManager and, while
 * the enforced game is in the foreground with no valid coin-bought session,
 * draws a FULL-SCREEN blocking overlay over it (a "buy time in CoinQuest"
 * screen). Drawing an overlay from the background is allowed with
 * SYSTEM_ALERT_WINDOW -- unlike startActivity()/GLOBAL_ACTION_HOME, which MIUI
 * silently blocks from the background (that was why an earlier "send home"
 * attempt showed the toast but never actually stopped play). The child can
 * still press Home to leave; they just can't play the game underneath the
 * cover. The overlay is removed the instant a session starts or the game is no
 * longer foreground.
 *
 * Foreground detection is stateful (see pollForeground): the last
 * MOVE_TO_FOREGROUND package is remembered across polls, so it never "ages out"
 * of a short query window while the child sits inside the game (the second bug
 * from the first on-device test). This is also the single foreground source for
 * GameTimeOverlayService's away-detection.
 */
class GameWatchService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var windowManager: WindowManager? = null
    private var blockView: View? = null

    private val poll = object : Runnable {
        override fun run() {
            try { enforceOnce() } catch (e: Exception) { Log.w(TAG, "poll error", e) }
            handler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        startForegroundWithNotification()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        handler.removeCallbacks(poll)
        handler.post(poll)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacks(poll)
        hideBlockOverlay()
        // Self-heal: if we're being torn down while a game is still meant to be
        // guarded, schedule a restart. On MIUI + Family Link we can't set the
        // Autostart/battery exceptions that would keep us alive (Family Link
        // locks those settings), so an AlarmManager-driven restart is the only
        // way to survive being killed.
        scheduleRestartIfEnforcing()
        super.onDestroy()
    }

    /** Called when the user swipes CoinQuest away from Recents -- the exact
     *  bypass found on-device (kill the app, the wall disappears, the game is
     *  free). Schedule an almost-immediate restart so the wall comes back on
     *  its own within ~1s and re-covers the game. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        scheduleRestartIfEnforcing()
        super.onTaskRemoved(rootIntent)
    }

    private fun scheduleRestartIfEnforcing() {
        // Only bother if a game is actually configured for enforcement.
        val enforced = getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)
            .getString(GameTimePrefs.ENFORCED_PACKAGES, null) ?: ""
        if (enforced.isBlank()) return
        try {
            val restart = Intent(applicationContext, GameWatchService::class.java)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            val pi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                PendingIntent.getForegroundService(this, 42, restart, flags)
            else
                PendingIntent.getService(this, 42, restart, flags)
            val am = getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
            // ~1s later; RTC_WAKEUP so it fires even if the process was killed.
            am.set(android.app.AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + 1200, pi)
            Log.d(TAG, "Scheduled self-restart in ~1.2s")
        } catch (e: Exception) {
            Log.w(TAG, "Could not schedule restart", e)
        }
    }

    private fun enforceOnce() {
        val prefs = getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)
        val enforced = (prefs.getString(GameTimePrefs.ENFORCED_PACKAGES, null) ?: "")
            .split(',').filter { it.isNotBlank() }.toMutableSet()
        prefs.getString(GameTimePrefs.TARGET_PACKAGE, null)?.let { if (it.isNotBlank()) enforced.add(it) }
        if (enforced.isEmpty()) { hideBlockOverlay(); return }

        val fg = pollForeground(this)
        val shouldBlock = fg != null && fg in enforced && !isSessionValid(prefs)
        if (shouldBlock) showBlockOverlay() else hideBlockOverlay()
    }

    private fun isSessionValid(prefs: android.content.SharedPreferences): Boolean {
        if (!prefs.getBoolean(GameTimePrefs.SESSION_ACTIVE, false)) return false
        val endAt = prefs.getLong(GameTimePrefs.SESSION_END_AT, 0L)
        if (endAt > 0L && System.currentTimeMillis() <= endAt + DEADLINE_GRACE_MS) return true
        prefs.edit().putBoolean(GameTimePrefs.SESSION_ACTIVE, false)
            .remove(GameTimePrefs.SESSION_END_AT).apply()
        return false
    }

    /** Full-screen cover over the game. Consumes touches (the game underneath
     *  can't be played), shows a calm "buy time" message + a button that opens
     *  CoinQuest. Idempotent: only one view is ever added. */
    private fun showBlockOverlay() {
        if (blockView != null) return
        val wm = windowManager ?: return

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#111825")) // deep calm navy, opaque cover
        }
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
        }
        val emoji = TextView(this).apply {
            text = "🪙"
            textSize = 64f
            gravity = Gravity.CENTER
        }
        val title = TextView(this).apply {
            text = "אין לך זמן משחק כרגע"
            setTextColor(Color.WHITE)
            textSize = 24f
            gravity = Gravity.CENTER
            setPadding(0, dp(16), 0, dp(8))
        }
        val sub = TextView(this).apply {
            text = "כדי לשחק צריך לקנות זמן בכספת המטבעות 🎮"
            setTextColor(Color.parseColor("#CFE0FF"))
            textSize = 17f
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(28))
        }
        val open = Button(this).apply {
            text = "פתח את כספת המטבעות"
            setOnClickListener { openCoinQuest() }
        }
        col.addView(emoji); col.addView(title); col.addView(sub); col.addView(open)
        root.addView(col, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER
        ))

        val type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            type,
            // NOT FLAG_NOT_TOUCHABLE: we WANT to eat touches so the game can't be
            // played. NOT_FOCUSABLE so hardware Back/Home still let the child
            // leave the game entirely (leaving is fine -- playing isn't).
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            android.graphics.PixelFormat.OPAQUE
        )
        try {
            wm.addView(root, params)
            blockView = root
            Log.d(TAG, "Block overlay shown over the game")
        } catch (e: Exception) {
            Log.w(TAG, "Could not add block overlay", e)
        }
    }

    private fun hideBlockOverlay() {
        val v = blockView ?: return
        try { windowManager?.removeView(v) } catch (e: Exception) { /* already gone */ }
        blockView = null
    }

    private fun openCoinQuest() {
        try {
            startActivity(Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        } catch (e: Exception) { Log.w(TAG, "open CoinQuest failed", e) }
    }

    private fun dp(v: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    ).toInt()

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
        private const val DEADLINE_GRACE_MS = 30_000L

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

        // Stateful foreground tracking: the last app seen moving to the
        // foreground, remembered across polls so it never ages out of the query
        // window while the child stays inside one app.
        @Volatile private var cachedForeground: String? = null
        @Volatile private var lastQueryMs: Long = 0L

        /** Current foreground package via UsageStatsManager, retained across
         *  calls. Returns null only if usage access isn't granted. Any caller
         *  (the watcher's poll, or the overlay's away-detection) advances the
         *  shared state. */
        fun currentForegroundPackage(context: Context): String? = pollForeground(context)

        @Synchronized
        fun pollForeground(context: Context): String? {
            if (!hasUsageAccess(context)) return null
            return try {
                val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
                val now = System.currentTimeMillis()
                val begin = if (lastQueryMs == 0L) now - INITIAL_LOOKBACK_MS else lastQueryMs - 500L
                val events = usm.queryEvents(begin, now)
                val ev = android.app.usage.UsageEvents.Event()
                while (events.hasNextEvent()) {
                    events.getNextEvent(ev)
                    if (ev.eventType == android.app.usage.UsageEvents.Event.MOVE_TO_FOREGROUND) {
                        cachedForeground = ev.packageName
                    }
                }
                lastQueryMs = now
                cachedForeground
            } catch (e: Exception) { cachedForeground }
        }

        private const val INITIAL_LOOKBACK_MS = 15_000L
    }
}
