package dev.aurora.tauri.nativeplugin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder

private const val AURORA_VOICE_CHANNEL_ID = "aurora_voice_capture"
private const val AURORA_VOICE_NOTIFICATION_ID = 4203

class AuroraVoiceForegroundService : Service() {
    override fun onCreate() {
        super.onCreate()
        running = true
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        running = true
        startForeground(AURORA_VOICE_NOTIFICATION_ID, foregroundNotification())
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            AURORA_VOICE_CHANNEL_ID,
            "Aurora voice capture",
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = "Shows when Aurora is allowed to keep voice capture controls in the foreground."
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun foregroundNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, AURORA_VOICE_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Aurora voice controls")
            .setContentText("Foreground voice capture controls are enabled.")
            .setOngoing(true)
            .build()
    }

    companion object {
        @Volatile
        var running: Boolean = false
            private set
    }
}
