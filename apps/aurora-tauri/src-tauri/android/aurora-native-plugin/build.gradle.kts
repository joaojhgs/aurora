plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.aurora.tauri.nativeplugin"
    compileSdk = 35

    defaultConfig {
        minSdk = 23
        consumerProguardFiles("consumer-rules.pro")
    }
}

dependencies {
    compileOnly("app.tauri:tauri-android")
    implementation("androidx.core:core-ktx:1.13.1")
}
