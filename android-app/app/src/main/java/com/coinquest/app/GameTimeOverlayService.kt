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
import android.os.SystemClock
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
    private var childId: String = ""
    private var ended = false // guards against double-reporting/double-goHome
    // elapsedRealtime when the game first stopped being the foreground app in
    // this away-streak; 0 = currently in the game (or foreground unknown). See
    // checkForegroundAway().
    private var awaySinceMs: Long = 0L
    // Away-detection only arms AFTER the game has actually been the foreground
    // app at least once -- so the ~1s between launching the game and its window
    // first reporting (when the stale previous foreground could still be
    // showing) never counts as "left the game" and ends the session at birth.
    private var seenTargetForeground = false

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Guard against a second session being started while one is already
        // running (e.g. the child tapping "play" again, or a stray re-launch):
        // a second onStartCommand would otherwise add a SECOND floating overlay
        // + countdown over the first, which is exactly the "two timers, wrong
        // time" bug reported on-device. One live overlay means a session is
        // already in flight -- ignore the new start and keep the existing one.
        if (overlayView != null) {
            Log.d(TAG, "Session already active -- ignoring duplicate start")
            return START_NOT_STICKY
        }
        val seconds = intent?.getIntExtra(EXTRA_SECONDS, 0) ?: 0
        targetPackage = intent?.getStringExtra(EXTRA_PACKAGE) ?: ""
        childId = intent?.getStringExtra(EXTRA_CHILD_ID) ?: ""
        if (seconds <= 0 || targetPackage.isEmpty()) {
            Log.w(TAG, "Missing/invalid session extras -- refusing to start")
            stopSelf()
            return START_NOT_STICKY
        }
        sessionDurationMs = seconds * 1000L
        remainingMsAtStop = sessionDurationMs

        val prefs = getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)
        // SESSION_END_AT is the crash backstop: if this process dies before
        // endSession() flips SESSION_ACTIVE off, the accessibility service
        // treats an expired deadline as "no session" instead of allowing the
        // game forever. Also fold the target into ENFORCED_PACKAGES here as
        // defense in depth, in case the app-launch arming call never ran.
        val enforced = (prefs.getString(GameTimePrefs.ENFORCED_PACKAGES, null) ?: "")
            .split(',').filter { it.isNotBlank() }.toMutableSet()
        enforced.add(targetPackage)
        prefs.edit()
            .putString(GameTimePrefs.TARGET_PACKAGE, targetPackage)
            .putString(GameTimePrefs.ENFORCED_PACKAGES, enforced.joinToString(","))
            .putBoolean(GameTimePrefs.SESSION_ACTIVE, true)
            .putLong(GameTimePrefs.SESSION_END_AT, System.currentTimeMillis() + sessionDurationMs)
            .putString(GameTimePrefs.SESSION_CHILD_ID, childId)
            // Seed the crash-safe consumed record at 0 for this child; onTick
            // advances it every second so a mid-game process kill still leaves
            // an accurate "time already spent" for the web app to debit later.
            .putString(GameTimePrefs.CONSUMED_PENDING_CHILD, childId)
            .putInt(GameTimePrefs.CONSUMED_PENDING_SECONDS, 0)
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
                // Persist consumed-so-far every tick as the crash backstop.
                val consumed = ((sessionDurationMs - millisUntilFinished) / 1000L).toInt()
                getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)
                    .edit().putInt(GameTimePrefs.CONSUMED_PENDING_SECONDS, consumed).apply()
                checkForegroundAway()
            }
            override fun onFinish() {
                remainingMsAtStop = 0L
                endSession(showCalmMessage = true)
            }
        }.start()
    }

    /** Polled once a second from the countdown tick: if the game is no longer
     *  the foreground app, end the session so the floating timer can't keep
     *  running (and draining purchased minutes) after the child has left the
     *  game -- the entire point of the fix. Actively polling the foreground
     *  package the accessibility service tracks is far more reliable than
     *  waiting to be told about one specific "left the game" transition event,
     *  which was being missed on real devices.
     *
     *  A short grace (AWAY_GRACE_MS) tolerates the game momentarily not being
     *  "foreground" -- pulling down the notification shade, an incoming system
     *  dialog, the app briefly not yet reporting after launch -- without
     *  killing an active session over a one-second blip.
     *
     *  foregroundPackage == null means "not known yet" (no window event seen):
     *  treat that as NOT-away, so a session is never ended just because the
     *  accessibility service hasn't reported anything yet. */
    private fun checkForegroundAway() {
        // Foreground source is UsageStatsManager (via GameWatchService) -- the
        // Family-Link-compatible, cross-OEM-reliable path. Fall back to the
        // accessibility service's reading only if usage access isn't granted
        // (legacy/non-Family-Link setups), so away-detection still works there.
        val fg = GameWatchService.currentForegroundPackage(this)
            ?: GameTimeAccessibilityService.instance?.activeWindowPackage()
            ?: GameTimeAccessibilityService.foregroundPackage
        if (fg == targetPackage) {
            seenTargetForeground = true
            awaySinceMs = 0L
            return
        }
        // Don't arm until the game has genuinely been foreground once (guards
        // the launch window) and only when we actually know the foreground app.
        if (!seenTargetForeground || fg == null) { awaySinceMs = 0L; return }
        if (awaySinceMs == 0L) awaySinceMs = SystemClock.elapsedRealtime()
        if (SystemClock.elapsedRealtime() - awaySinceMs >= AWAY_GRACE_MS) {
            Log.d(TAG, "Foreground is '$fg' (not '$targetPackage') for >${AWAY_GRACE_MS}ms -- ending session")
            endEarlyDueToAppSwitch()
        }
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

    /** Single exit path for timeout, manual early-stop (the ✖ button), AND the
     *  child having switched away from the game (endEarlyDueToAppSwitch) --
     *  always reports real elapsed seconds and only ever runs once.
     *  `returnToApp`: true for timeout / tapping the ✖ (bring CoinQuest back to
     *  the front, so ending the timer lands the child on THIS app -- showing
     *  their updated coins/time -- instead of the phone's home screen, which
     *  read as "the app closed"); false when they've ALREADY navigated away on
     *  their own (Home/another app) -- yanking them into CoinQuest there would
     *  interrupt whatever they chose to do next. */
    private fun endSession(showCalmMessage: Boolean, returnToApp: Boolean = true) {
        if (ended) return
        ended = true
        countDownTimer?.cancel()

        val consumedSeconds = ((sessionDurationMs - remainingMsAtStop) / 1000L).toInt()
        val prefs = getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)

        val finish = Runnable {
            // Flip session_active off right before actually switching away (not
            // earlier), so the accessibility service's re-block guard can't
            // spuriously fire a redundant extra toast+home while the calm
            // message is still on screen over the game.
            // Write the final consumed count before reporting, so the crash
            // backstop pref is exact even if the WebView callback below is what
            // ends up (rarely) not delivering. The web side clears it via
            // clearPendingConsumed() once it has applied the debit.
            prefs.edit().putBoolean(GameTimePrefs.SESSION_ACTIVE, false)
                .remove(GameTimePrefs.SESSION_END_AT)
                .putInt(GameTimePrefs.CONSUMED_PENDING_SECONDS, consumedSeconds)
                .apply()
            // Re-assert the device-owner block: with SESSION_ACTIVE now false,
            // block() will suspend the game again so it can't be reopened
            // without buying another session. This is the hard stop that makes
            // "time's up" real -- if the child is still inside the game, the
            // suspend backgrounds it; bringCoinQuestToFront then lands them here.
            GamePolicyManager.block(this@GameTimeOverlayService, listOf(targetPackage))
            if (returnToApp) bringCoinQuestToFront()
            NativeGameBridge.notifySessionEnded(consumedSeconds, childId)
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
            // even if the overlay view is somehow already gone -- ending the
            // session (report + return to app + stopSelf) must never silently
            // no-op just because the overlay view went away.
            mainHandler.postDelayed(finish, CALM_MESSAGE_DISPLAY_MS)
        } else {
            finish.run()
        }
    }

    /** Ends the session because the child has left the game (checkForegroundAway
     *  saw the game stop being the foreground app for AWAY_GRACE_MS). This is
     *  the whole point of the fix: previously, leaving via Home/Back left the
     *  floating countdown running and draining purchased minutes in the
     *  background, with no way to stop it short of waiting it out or going back
     *  in just to tap the overlay's own close button. No calm message (the
     *  child isn't looking at the overlay) and don't pull CoinQuest to the
     *  front (see endSession's returnToApp doc -- they already chose to go
     *  somewhere else on their own). */
    private fun endEarlyDueToAppSwitch() {
        endSession(showCalmMessage = false, returnToApp = false)
    }

    /** Bring the CoinQuest app to the foreground, replacing the game. Used when
     *  the timer ends "in-flow" (time ran out, or the child tapped the ✖) so
     *  they land back on this app -- not the phone's home screen, which looked
     *  like "CoinQuest closed". The SYSTEM_ALERT_WINDOW (overlay) permission
     *  this feature already requires also exempts us from Android's background-
     *  activity-start restrictions, so this launch is allowed from the service. */
    private fun bringCoinQuestToFront() {
        try {
            val intent = Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            startActivity(intent)
        } catch (e: Exception) {
            Log.w(TAG, "Could not bring CoinQuest to front", e)
        }
    }

    companion object {
        private const val TAG = "CoinQuestGameTime"
        private const val NOTIFICATION_ID = 2001

        const val EXTRA_SECONDS = "seconds"
        const val EXTRA_PACKAGE = "package"
        const val EXTRA_CHILD_ID = "child_id"

        private const val FIVE_MINUTES_MS = 5 * 60 * 1000L
        private const val ONE_MINUTE_MS = 60 * 1000L
        // Grace before "game is no longer foreground" ends the session -- long
        // enough to ride out a notification-shade pull or a post-launch blip,
        // short enough that actually leaving stops the drain within seconds.
        private const val AWAY_GRACE_MS = 3_000L
        // A2 (ANDROID-APP-PLAN.md): "never an abrupt cutoff" -- was 1800ms,
        // barely enough to read the message before being forced home. A full
        // 10s calm buffer (during which the close button is hidden, so this
        // is a genuine pause, not skippable) matches the plan's explicit
        // "time's up, that was fun!" spec and the same principle behind the
        // graduated GT_WARN_STEPS warnings on the web side.
        private const val CALM_MESSAGE_DISPLAY_MS = 10000L
    }
}
