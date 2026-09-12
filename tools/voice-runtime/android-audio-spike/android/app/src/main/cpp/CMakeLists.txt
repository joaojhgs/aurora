cmake_minimum_required(VERSION 3.22.1)
project(aurora_android_audio_spike_jni LANGUAGES C)

set(RUST_TARGET_DIR "${RUST_TARGET_DIR}" CACHE PATH "Cargo target directory")

if("${ANDROID_ABI}" STREQUAL "arm64-v8a")
  set(RUST_TARGET "aarch64-linux-android")
elseif("${ANDROID_ABI}" STREQUAL "x86_64")
  set(RUST_TARGET "x86_64-linux-android")
else()
  message(FATAL_ERROR "Unsupported ABI for this spike: ${ANDROID_ABI}")
endif()

set(RUST_STATIC_LIB "${RUST_TARGET_DIR}/${RUST_TARGET}/debug/libaurora_android_audio_spike.a")
if(NOT EXISTS "${RUST_STATIC_LIB}")
  message(FATAL_ERROR "Missing Rust static library: ${RUST_STATIC_LIB}")
endif()

add_library(aurora_android_audio_spike STATIC IMPORTED)
set_target_properties(
  aurora_android_audio_spike
  PROPERTIES IMPORTED_LOCATION "${RUST_STATIC_LIB}"
)

add_library(aurora_android_audio_jni SHARED native_bridge.c)
target_link_libraries(
  aurora_android_audio_jni
  aurora_android_audio_spike
  android
)
