package com.coinquest.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native, OS-level reminders for parent-scheduled daily events (doctor, school
 * trip, etc.). Without this, event reminders only fired while the app was
 * actually open on screen (app.js's checkEventReminders polling) -- useless for
 * the one thing a reminder is for: getting the family's attention when they are
 * NOT already looking at the app. Especially important here, where the visual
 * daily schedule is a core support for a child on the spectrum.
 *
 * app.js owns the source of truth (state.events, synced across devices) and
 * pushes the full upcoming list here via NativeGameBridge.syncEventReminders()
 * on launch and after any add/delete/remote-change. This object just diffs that
 * list against what's currently armed: cancel what's gone, (re)arm what's here.
 *
 * Alarms are inexact one-shots (AlarmManager.set) -- being a few minutes off is
 * fine for "get ready for X", and unlike exact alarms it needs no special
 * runtime permission on Android 12+ (same tradeoff as ChoreReminderScheduler).
 * The list is persisted so ReminderReceiver's BOOT_COMPLETED handler can re-arm
 * future events after a reboot clears all AlarmManager registrations.
 */
object EventReminderScheduler {
    const val PREFS_NAME = "coinquest_event_reminders"
    private const val KEY_EVENTS = "events" // JSON array of {id, at, title, emoji}
    private const val REQUEST_BASE = 5000

    private fun requestCode(id: String): Int = REQUEST_BASE + (id.hashCode() and 0xFFFF)

    private fun pendingIntent(context: Context, id: String, title: String, emoji: String): PendingIntent {
        val intent = Intent(context, ReminderReceiver::class.java)
            .setAction(ReminderReceiver.ACTION_EVENT_FIRE)
            .putExtra(ReminderReceiver.EXTRA_EVENT_ID, id)
            .putExtra(ReminderReceiver.EXTRA_EVENT_TITLE, title)
            .putExtra(ReminderReceiver.EXTRA_EVENT_EMOJI, emoji)
        return PendingIntent.getBroadcast(
            context, requestCode(id), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun cancelOne(context: Context, id: String) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        // Extras don't affect PendingIntent equality (only requestCode + intent
        // action/component/data do), so empty strings here still match the armed one.
        am.cancel(pendingIntent(context, id, "", ""))
    }

    private fun armOne(context: Context, id: String, at: Long, title: String, emoji: String) {
        if (at <= System.currentTimeMillis()) return // already past -- nothing to fire
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.set(AlarmManager.RTC_WAKEUP, at, pendingIntent(context, id, title, emoji))
    }

    /** Replace the full armed set with [json] (a JSON array of {id, at, title,
     *  emoji}). Cancels alarms for ids no longer present, (re)arms the rest. */
    fun syncAll(context: Context, json: String) {
        val incoming = try { JSONArray(json) } catch (e: Exception) { JSONArray() }
        val newIds = HashSet<String>()
        for (i in 0 until incoming.length()) {
            incoming.optJSONObject(i)?.optString("id")?.let { if (it.isNotEmpty()) newIds.add(it) }
        }
        // Cancel anything previously armed that isn't in the new list.
        val prev = try { JSONArray(context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_EVENTS, "[]")) } catch (e: Exception) { JSONArray() }
        for (i in 0 until prev.length()) {
            val id = prev.optJSONObject(i)?.optString("id") ?: continue
            if (id.isNotEmpty() && id !in newIds) cancelOne(context, id)
        }
        // Arm (FLAG_UPDATE_CURRENT replaces an existing alarm for the same id, so
        // a changed time just overwrites cleanly).
        for (i in 0 until incoming.length()) {
            val o = incoming.optJSONObject(i) ?: continue
            val id = o.optString("id"); if (id.isEmpty()) continue
            armOne(context, id, o.optLong("at"), o.optString("title"), o.optString("emoji", "📅"))
        }
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString(KEY_EVENTS, incoming.toString()).apply()
    }

    /** BOOT_COMPLETED: re-arm every still-future event from the persisted list. */
    fun rescheduleAll(context: Context) {
        val stored = try { JSONArray(context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_EVENTS, "[]")) } catch (e: Exception) { return }
        for (i in 0 until stored.length()) {
            val o = stored.optJSONObject(i) ?: continue
            val id = o.optString("id"); if (id.isEmpty()) continue
            armOne(context, id, o.optLong("at"), o.optString("title"), o.optString("emoji", "📅"))
        }
    }
}
