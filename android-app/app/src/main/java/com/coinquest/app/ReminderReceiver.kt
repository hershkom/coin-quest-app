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
            ACTION_EVENT_FIRE -> showEventNotification(
                context,
                intent.getStringExtra(EXTRA_EVENT_ID) ?: "",
                intent.getStringExtra(EXTRA_EVENT_TITLE) ?: "",
                intent.getStringExtra(EXTRA_EVENT_EMOJI) ?: "📅"
            )
            Intent.ACTION_BOOT_COMPLETED -> {
                ChoreReminderScheduler.rescheduleIfEnabled(context)
                EventReminderScheduler.rescheduleAll(context)
                // Bring the always-on game wall back up after a reboot (only if
                // usage access is granted and a game is actually enforced, so we
                // don't run an idle foreground service for nothing) -- and never
                // on a parent's own device, which has no child to enforce against.
                val prefs = context.getSharedPreferences(GameTimePrefs.NAME, Context.MODE_PRIVATE)
                val hasGames = (prefs.getString(GameTimePrefs.ENFORCED_PACKAGES, null) ?: "").isNotBlank()
                val isParentDevice = prefs.getBoolean(GameTimePrefs.PARENT_DEVICE_MODE, false)
                if (hasGames && !isParentDevice && GameWatchService.hasUsageAccess(context)) {
                    NativeGameBridge.startWatch(context)
                }
            }
        }
    }

    private fun showEventNotification(context: Context, id: String, title: String, emoji: String) {
        val channelId = "event_reminder"
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(channelId, "תזכורת אירועים", NotificationManager.IMPORTANCE_HIGH)
            manager.createNotificationChannel(channel)
        }
        val openApp = Intent(context, MainActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val contentIntent = PendingIntent.getActivity(
            context, id.hashCode(), openApp, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, channelId)
            .setContentTitle("$emoji ${if (title.isNotEmpty()) title else "אירוע קרוב"}")
            .setContentText("בקרוב! זמן להתכונן 😊")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .build()
        // Distinct id per event so several reminders can coexist (the single
        // chore reminder deliberately reuses one fixed id and replaces itself).
        manager.notify(EVENT_NOTIFICATION_BASE + (id.hashCode() and 0xFFFF), notification)
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
        const val ACTION_EVENT_FIRE = "com.coinquest.app.EVENT_REMINDER_FIRE"
        const val EXTRA_EVENT_ID = "event_id"
        const val EXTRA_EVENT_TITLE = "event_title"
        const val EXTRA_EVENT_EMOJI = "event_emoji"
        private const val NOTIFICATION_ID = 4001
        private const val EVENT_NOTIFICATION_BASE = 40000
    }
}
