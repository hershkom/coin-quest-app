package com.coinquest.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import java.util.Calendar

/**
 * AN5 (ANDROID-APP-PLAN.md): a once-daily "don't forget your chores today"
 * notification at a parent-chosen time, called from app.js via
 * NativeGameBridge.scheduleChoreReminder()/cancelChoreReminder(). Persisted
 * to SharedPreferences (not just the in-memory AlarmManager registration)
 * because ALL alarms are cleared on device reboot -- ReminderReceiver's
 * BOOT_COMPLETED handler reads these prefs to re-register automatically.
 */
object ChoreReminderScheduler {
    const val PREFS_NAME = "coinquest_reminder"
    const val KEY_ENABLED = "enabled"
    const val KEY_HOUR = "hour"
    const val KEY_MINUTE = "minute"
    private const val REQUEST_CODE = 3001

    private fun pendingIntent(context: Context): PendingIntent {
        val intent = Intent(context, ReminderReceiver::class.java).setAction(ReminderReceiver.ACTION_FIRE)
        return PendingIntent.getBroadcast(
            context, REQUEST_CODE, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    fun schedule(context: Context, hour: Int, minute: Int) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_ENABLED, true).putInt(KEY_HOUR, hour).putInt(KEY_MINUTE, minute).apply()
        armAlarm(context, hour, minute)
    }

    fun cancel(context: Context) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_ENABLED, false).apply()
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.cancel(pendingIntent(context))
    }

    /** Called by ReminderReceiver on BOOT_COMPLETED to restore a
     *  previously-scheduled reminder that survived the reboot in prefs but
     *  not in AlarmManager. No-op if none was ever enabled. */
    fun rescheduleIfEnabled(context: Context) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_ENABLED, false)) return
        armAlarm(context, prefs.getInt(KEY_HOUR, 8), prefs.getInt(KEY_MINUTE, 0))
    }

    /** Inexact daily repeat -- being off by a few minutes is fine for "don't
     *  forget your chores today" and, unlike an exact alarm, needs no special
     *  runtime permission on Android 12+. */
    private fun armAlarm(context: Context, hour: Int, minute: Int) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val trigger = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, hour)
            set(Calendar.MINUTE, minute)
            set(Calendar.SECOND, 0)
            if (before(Calendar.getInstance())) add(Calendar.DAY_OF_YEAR, 1)
        }
        am.setInexactRepeating(
            AlarmManager.RTC, trigger.timeInMillis, AlarmManager.INTERVAL_DAY, pendingIntent(context)
        )
    }
}
