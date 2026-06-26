package dev.aurora.tauri.nativeplugin

import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

class AuroraQuickSettingsTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        qsTile?.state = Tile.STATE_INACTIVE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            qsTile?.subtitle = "Open Aurora"
        }
        qsTile?.updateTile()
    }

    override fun onClick() {
        super.onClick()
        AuroraEntrypointStore.record(Intent("dev.aurora.intent.QUICK_TILE"), "quick_settings_tile")
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        launchIntent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (launchIntent != null) {
            startActivityAndCollapse(launchIntent)
        }
    }
}
