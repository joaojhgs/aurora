#include <jni.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct AuroraAudioState AuroraAudioState;

typedef struct AuroraAudioStats {
  uint64_t accepted_chunks;
  uint64_t accepted_samples;
  uint64_t dropped_chunks;
  uint64_t discontinuities;
  uint32_t queued_chunks;
  uint32_t closed;
} AuroraAudioStats;

extern AuroraAudioState *aurora_audio_state_new(size_t capacity_chunks, size_t max_chunk_samples);
extern void aurora_audio_state_free(AuroraAudioState *state);
extern int32_t aurora_audio_state_push_pcm_i16(
    AuroraAudioState *state,
    const int16_t *samples,
    size_t sample_count,
    uint64_t sequence);
extern size_t aurora_audio_state_drain_one(AuroraAudioState *state);
extern void aurora_audio_state_close(AuroraAudioState *state);
extern int32_t aurora_audio_state_stats(AuroraAudioState *state, AuroraAudioStats *out_stats);

JNIEXPORT jlong JNICALL Java_dev_aurora_voice_audiospike_NativeAudioBridge_nativeCreate(
    JNIEnv *env,
    jobject self,
    jint capacity_chunks,
    jint max_chunk_samples) {
  (void)env;
  (void)self;
  AuroraAudioState *state =
      aurora_audio_state_new((size_t)capacity_chunks, (size_t)max_chunk_samples);
  return (jlong)(uintptr_t)state;
}

JNIEXPORT void JNICALL Java_dev_aurora_voice_audiospike_NativeAudioBridge_nativeClose(
    JNIEnv *env,
    jobject self,
    jlong handle) {
  (void)env;
  (void)self;
  AuroraAudioState *state = (AuroraAudioState *)(uintptr_t)handle;
  aurora_audio_state_close(state);
}

JNIEXPORT void JNICALL Java_dev_aurora_voice_audiospike_NativeAudioBridge_nativeFree(
    JNIEnv *env,
    jobject self,
    jlong handle) {
  (void)env;
  (void)self;
  AuroraAudioState *state = (AuroraAudioState *)(uintptr_t)handle;
  aurora_audio_state_free(state);
}

JNIEXPORT jint JNICALL Java_dev_aurora_voice_audiospike_NativeAudioBridge_nativePushPcm(
    JNIEnv *env,
    jobject self,
    jlong handle,
    jshortArray samples,
    jint sample_count,
    jlong sequence) {
  (void)self;
  if (handle == 0 || samples == NULL || sample_count <= 0) {
    return -1;
  }

  jsize array_len = (*env)->GetArrayLength(env, samples);
  if (sample_count > array_len) {
    return -1;
  }

  jboolean is_copy = JNI_FALSE;
  jshort *elements = (*env)->GetShortArrayElements(env, samples, &is_copy);
  if (elements == NULL) {
    return -1;
  }

  AuroraAudioState *state = (AuroraAudioState *)(uintptr_t)handle;
  int32_t result = aurora_audio_state_push_pcm_i16(
      state,
      (const int16_t *)elements,
      (size_t)sample_count,
      (uint64_t)sequence);
  (*env)->ReleaseShortArrayElements(env, samples, elements, JNI_ABORT);
  return result;
}

JNIEXPORT jint JNICALL Java_dev_aurora_voice_audiospike_NativeAudioBridge_nativeDrainOne(
    JNIEnv *env,
    jobject self,
    jlong handle) {
  (void)env;
  (void)self;
  AuroraAudioState *state = (AuroraAudioState *)(uintptr_t)handle;
  return (jint)aurora_audio_state_drain_one(state);
}

JNIEXPORT jlongArray JNICALL Java_dev_aurora_voice_audiospike_NativeAudioBridge_nativeStats(
    JNIEnv *env,
    jobject self,
    jlong handle) {
  (void)self;
  AuroraAudioStats stats = {0};
  AuroraAudioState *state = (AuroraAudioState *)(uintptr_t)handle;
  int32_t result = aurora_audio_state_stats(state, &stats);
  jlong values[6] = {
      (jlong)stats.accepted_chunks,
      (jlong)stats.accepted_samples,
      (jlong)stats.dropped_chunks,
      (jlong)stats.discontinuities,
      (jlong)stats.queued_chunks,
      (jlong)stats.closed,
  };
  if (result != 0) {
    values[5] = 1;
  }
  jlongArray array = (*env)->NewLongArray(env, 6);
  if (array != NULL) {
    (*env)->SetLongArrayRegion(env, array, 0, 6, values);
  }
  return array;
}
