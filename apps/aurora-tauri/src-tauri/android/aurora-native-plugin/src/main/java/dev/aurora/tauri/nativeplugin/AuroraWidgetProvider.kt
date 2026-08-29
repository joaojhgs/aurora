package dev.aurora.tauri.nativeplugin

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

class AuroraWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val widgetLayout = context.resources.getIdentifier("aurora_widget", "layout", context.packageName)
        val widgetRoot = context.resources.getIdentifier("aurora_widget_root", "id", context.packageName)
        if (widgetLayout == 0 || widgetRoot == 0) return

        for (appWidgetId in appWidgetIds) {
            val intent = Intent(context, AuroraEntrypointActivity::class.java).apply {
                action = "dev.aurora.intent.WIDGET_OPEN"
            }
            val pendingIntent = PendingIntent.getActivity(
                context,
                appWidgetId,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val views = RemoteViews(context.packageName, widgetLayout)
            views.setOnClickPendingIntent(widgetRoot, pendingIntent)
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }
}
