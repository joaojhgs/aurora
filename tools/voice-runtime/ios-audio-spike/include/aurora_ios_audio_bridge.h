#ifndef AURORA_IOS_AUDIO_BRIDGE_H
#define AURORA_IOS_AUDIO_BRIDGE_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct AuroraIosAudioState AuroraIosAudioState;

typedef struct AuroraIosAudioStats {
  uint64_t accepted_chunks;
  uint64_t accepted_samples;
  uint64_t dropped_chunks;
  uint64_t discontinuities;
  uint32_t queued_chunks;
  uint32_t closed;
} AuroraIosAudioStats;

enum {
  AURORA_IOS_AUDIO_OK = 0,
  AURORA_IOS_AUDIO_BACKPRESSURE = 1,
  AURORA_IOS_AUDIO_CLOSED = 2,
  AURORA_IOS_AUDIO_INVALID_ARGUMENT = -1,
};

AuroraIosAudioState *aurora_ios_audio_state_new(
    uintptr_t capacity_chunks,
    uintptr_t max_chunk_samples);
void aurora_ios_audio_state_free(AuroraIosAudioState *state);
int32_t aurora_ios_audio_state_push_pcm_f32(
    AuroraIosAudioState *state,
    const float *samples,
    uintptr_t sample_count,
    uint64_t sequence,
    uint32_t sample_rate_hz);
uintptr_t aurora_ios_audio_state_drain_one(AuroraIosAudioState *state);
int32_t aurora_ios_audio_state_reset(AuroraIosAudioState *state);
void aurora_ios_audio_state_close(AuroraIosAudioState *state);
int32_t aurora_ios_audio_state_stats(
    AuroraIosAudioState *state,
    AuroraIosAudioStats *out_stats);

#ifdef __cplusplus
}
#endif

#endif
