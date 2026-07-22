package com.coinquest.app

import android.app.admin.DeviceAdminReceiver
import android.content.ComponentName
import android.content.Context

/**
 * The DeviceAdmin component CoinQuest is provisioned against as DEVICE OWNER
 * (via `adb shell dpm set-device-owner com.coinquest.app.debug/com.coinquest.app.CoinQuestDeviceAdminReceiver`
 * on a freshly factory-reset device with no accounts). Being device owner is
 * what lets GamePolicyManager call DevicePolicyManager.setPackagesSuspended to
 * hard-block the purchased native game (Minecraft) at the OS level unless a
 * coin-bought session is active -- a mechanism that, unlike the previous
 * AccessibilityService, Google Family Link cannot silently disable (Family
 * Link blocks third-party accessibility services but is not present at all on a
 * device-owner-provisioned profile).
 *
 * The receiver itself needs no callback overrides for the suspend feature; its
 * mere existence + device-owner provisioning is what grants the capability.
 */
class CoinQuestDeviceAdminReceiver : DeviceAdminReceiver() {
    companion object {
        fun componentName(context: Context): ComponentName =
            ComponentName(context.applicationContext, CoinQuestDeviceAdminReceiver::class.java)
    }
}
