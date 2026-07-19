package com.coinquest.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * Handles two distinct events (AN5, ANDROID-APP-PLAN.md):
 *  - ACTION_FIRE: the scheduled daily-reminder alarm went off -- show the
 *    "don't forget your chores today" notification.
 *  - android.intent.action.BOOT_COMPLETED: the device just rebooted, which
 *    clears every AlarmManager registration -- re-arm from the persisted
 *    prefs if a reminder was enabled before the reboot.
 */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_FIRE -> showNotification(context)
            Intent.ACTION_BOOT_COMPLETED -> ChoreReminderScheduler.rescheduleIfEnabled(context)
        }
    }

    private fun showNotification(context: Context) {
        val channelId = "chore_reminder"
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(channelId, "תזכורת מטלות", NotificationManager.IMPORTANCE_DEFAULT)
            manager.createNotificationChannel(channel)
        }
        val openApp = Intent(context, MainActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val contentIntent = PendingIntent.getActivity(
            context, 0, openApp, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, channelId)
            .setContentTitle("כספת המטבעות 🪙")
            .setContentText("זמן לבדוק את המטלות של היום!")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }

    companion object {
        const val ACTION_FIRE = "com.coinquest.app.CHORE_REMINDER_FIRE"
        private const val NOTIFICATION_ID = 4001
    }
}
