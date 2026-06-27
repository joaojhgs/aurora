package dev.aurora.tauri.nativeplugin

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log

class AuroraEntrypointActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AuroraEntrypointStore.record(intent, "entrypoint_activity")
        launchMainActivity()
        finish()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        AuroraEntrypointStore.record(intent, "entrypoint_activity_new_intent")
        launchMainActivity()
        finish()
    }

    private fun launchMainActivity() {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        if (launchIntent == null) {
            Log.w("AuroraEntrypoint", "Aurora launch intent unavailable after native entrypoint")
            return
        }
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        startActivity(launchIntent)
    }
}
