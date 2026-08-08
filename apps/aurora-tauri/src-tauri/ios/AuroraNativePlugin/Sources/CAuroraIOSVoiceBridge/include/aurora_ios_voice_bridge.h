#ifndef AURORA_IOS_VOICE_BRIDGE_H
#define AURORA_IOS_VOICE_BRIDGE_H

#include <stdint.h>
#include <stddef.h>

typedef struct AuroraIosAudioState AuroraIosAudioState;
typedef struct AuroraIosAudioOutput AuroraIosAudioOutput;

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

AuroraIosAudioOutput *aurora_ios_audio_output_new(uintptr_t capacity_chunks);
void aurora_ios_audio_output_free(AuroraIosAudioOutput *output);
int32_t aurora_ios_audio_output_drain(
    AuroraIosAudioOutput *output,
    int16_t *samples,
    uintptr_t sample_capacity,
    uintptr_t *out_sample_count,
    uint32_t *out_sample_rate_hz,
    uint16_t *out_channels,
    uint64_t *out_sequence,
    uint32_t *out_final_chunk);
void aurora_ios_audio_output_acknowledge(AuroraIosAudioOutput *output);
void aurora_ios_audio_output_close(AuroraIosAudioOutput *output);

#endif
