package com.coinquest.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.os.Build
import android.os.CountDownTimer
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.core.app.NotificationCompat

/**
 * Floating countdown shown over a native game session (real purchased
 * Minecraft, launched via an Intent from NativeGameBridge), fronting the
 * enforced end-of-session action. Core countdown/overlay/foreground-service
 * mechanics mirror the proven ScreenTimeSpike project; new here: duration and
 * target package are passed in per-session (the spike hardcoded both), and
 * ending a session -- by timeout OR by the child tapping the close button --
 * always reports exactly how many seconds were actually consumed back to the
 * web app via NativeGameBridge, so the coin-bought wallet is debited only for
 * real usage (see app.js's own "exit banks unused time" behavior for web
 * games, which this mirrors for native ones).
 */
class GameTimeOverlayService : Service() {

    private lateinit var windowManager: WindowManager
    private var overlayView: View? = null
    private var countDownTimer: CountDownTimer? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    private var sessionDurationMs: Long = 0L
    private var remainingMsAtStop: Long = 0L
    private var targetPackage: String = ""
    private var ended = false // guards against double-reporting/double-goHome

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val seconds = intent?.getIntExtra(EXTRA_SECONDS, 0) ?: 0
        targetPackage = intent?.getStringExtra(EXTRA_PACKAGE) ?: ""
        if (seconds <= 0 || targetPackage.isEmpty()) {
            Log.w(TAG, "Missing/invalid session extras -- refusing to start")
            stopSelf()
            return START_NOT_STICKY
        }
        sessionDurationMs = seconds * 1000L
        remainingMsAtStop = sessionDurationMs

        val prefs = getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)
        prefs.edit()
            .putString(GameTimePrefs.TARGET_PACKAGE, targetPackage)
            .putBoolean(GameTimePrefs.SESSION_ACTIVE, true)
            .apply()

        startForegroundWithNotification()
        addOverlayView()
        startCountdown()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        countDownTimer?.cancel()
        removeOverlayView()
        super.onDestroy()
    }

    private fun startForegroundWithNotification() {
        val channelId = "game_time_session"
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId, "זמן משחק", NotificationManager.IMPORTANCE_LOW
            )
            manager.createNotificationChannel(channel)
        }
        val notification = NotificationCompat.Builder(this, channelId)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("זמן משחק פעיל")
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setOngoing(true)
            .build()

        // specialUse FGS type only exists on API 34+; older releases use the
        // plain two-arg overload (matches the proven spike code exactly).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun addOverlayView() {
        val view = LayoutInflater.from(this).inflate(R.layout.overlay_game_timer, null)
        overlayView = view

        // Tapping the close button means "I'm done now" -- it ends the
        // session for real (forces home, reports consumed time), it does
        // NOT just dismiss the overlay while the game keeps running. A
        // dismiss-only close would let the child keep playing with no
        // countdown and no enforcement, defeating the entire feature.
        view.findViewById<View>(R.id.btnOverlayClose).setOnClickListener {
            Log.d(TAG, "Child ended the session early via the overlay")
            endSession(showCalmMessage = false)
        }

        val type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        )
        params.gravity = Gravity.TOP or Gravity.END
        params.x = 24
        params.y = 96
        windowManager.addView(view, params)
    }

    private fun removeOverlayView() {
        overlayView?.let {
            try { windowManager.removeView(it) } catch (e: IllegalArgumentException) { /* already removed */ }
        }
        overlayView = null
    }

    private fun startCountdown() {
        countDownTimer = object : CountDownTimer(sessionDurationMs, 1000) {
            override fun onTick(millisUntilFinished: Long) {
                remainingMsAtStop = millisUntilFinished
                updateTimerDisplay(millisUntilFinished)
            }
            override fun onFinish() {
                remainingMsAtStop = 0L
                endSession(showCalmMessage = true)
            }
        }.start()
    }

    private fun updateTimerDisplay(millisRemaining: Long) {
        val view = overlayView ?: return
        val totalSeconds = (millisRemaining / 1000).toInt()
        val minutes = totalSeconds / 60
        val seconds = totalSeconds % 60
        view.findViewById<TextView>(R.id.txtOverlayTimer).text = String.format("%02d:%02d", minutes, seconds)

        val colorRes = when {
            millisRemaining > FIVE_MINUTES_MS -> R.color.game_timer_green
            millisRemaining > ONE_MINUTE_MS -> R.color.game_timer_amber
            else -> R.color.game_timer_red
        }
        view.findViewById<View>(R.id.overlayRoot).setBackgroundColor(getColor(colorRes))
    }

    /** Single exit path for both timeout and manual early-stop -- always goes
     *  home, always reports real elapsed seconds, and only ever runs once. */
    private fun endSession(showCalmMessage: Boolean) {
        if (ended) return
        ended = true
        countDownTimer?.cancel()

        val consumedSeconds = ((sessionDurationMs - remainingMsAtStop) / 1000L).toInt()
        val prefs = getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)

        val finish = Runnable {
            // Flip session_active off right before actually forcing home (not
            // earlier), so the accessibility service's re-block guard can't
            // spuriously fire a redundant extra toast+home while the calm
            // message is still on screen over the game.
            prefs.edit().putBoolean(GameTimePrefs.SESSION_ACTIVE, false).apply()
            val svc = GameTimeAccessibilityService.instance
            if (svc != null) svc.goHome()
            else Log.w(TAG, "Accessibility service not connected -- cannot force home")
            NativeGameBridge.notifySessionEnded(consumedSeconds)
            stopSelf()
        }

        if (showCalmMessage) {
            val view = overlayView
            if (view != null) {
                view.findViewById<TextView>(R.id.txtOverlayTimer).text = "הזמן נגמר! כל הכבוד 🎉"
                view.findViewById<View>(R.id.overlayRoot).setBackgroundColor(getColor(R.color.game_timer_red))
                view.findViewById<View>(R.id.btnOverlayClose).visibility = View.GONE
            }
            // Main-thread Handler (not View.postDelayed) so this still fires
            // even if the overlay view is somehow already gone -- the forced
            // home action must never silently no-op.
            mainHandler.postDelayed(finish, CALM_MESSAGE_DISPLAY_MS)
        } else {
            finish.run()
        }
    }

    companion object {
        private const val TAG = "CoinQuestGameTime"
        private const val NOTIFICATION_ID = 2001

        const val EXTRA_SECONDS = "seconds"
        const val EXTRA_PACKAGE = "package"

        private const val FIVE_MINUTES_MS = 5 * 60 * 1000L
        private const val ONE_MINUTE_MS = 60 * 1000L
        // A2 (ANDROID-APP-PLAN.md): "never an abrupt cutoff" -- was 1800ms,
        // barely enough to read the message before being forced home. A full
        // 10s calm buffer (during which the close button is hidden, so this
        // is a genuine pause, not skippable) matches the plan's explicit
        // "time's up, that was fun!" spec and the same principle behind the
        // graduated GT_WARN_STEPS warnings on the web side.
        private const val CALM_MESSAGE_DISPLAY_MS = 10000L
    }
}
