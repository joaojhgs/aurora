plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// The installer aligns the generated app's Kotlin compiler with LiteRT-LM metadata.
val auroraKotlinGradlePluginVersion = "2.4.0"

android {
    namespace = "dev.aurora.tauri.nativeplugin"
    compileSdk = 35

    defaultConfig {
        minSdk = 23
        consumerProguardFiles("consumer-rules.pro")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8)
    }
}

dependencies {
    compileOnly("app.tauri:tauri-android")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("com.google.ai.edge.litertlm:litertlm-android:0.18.0")
}
