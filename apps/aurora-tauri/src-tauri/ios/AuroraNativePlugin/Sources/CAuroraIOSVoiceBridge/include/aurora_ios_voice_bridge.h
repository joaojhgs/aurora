#ifndef AURORA_IOS_VOICE_BRIDGE_H
#define AURORA_IOS_VOICE_BRIDGE_H

#include <stdint.h>
#include <stddef.h>

typedef struct AuroraIosAudioState AuroraIosAudioState;
typedef struct AuroraIosAudioOutput AuroraIosAudioOutput;
typedef struct AuroraIosVoiceSession AuroraIosVoiceSession;

typedef struct AuroraIosVoiceSessionStatus {
  uint32_t active;
  int64_t phase;
  uint32_t has_generation;
  uint64_t generation;
  uint64_t completed_turns;
  uint64_t failed_turns;
} AuroraIosVoiceSessionStatus;

enum {
  AURORA_IOS_VOICE_OK = 0,
  AURORA_IOS_VOICE_INVALID_ARGUMENT = -1,
  AURORA_IOS_VOICE_UNAVAILABLE = 1,
  AURORA_IOS_VOICE_ALREADY_ACTIVE = 2,
  AURORA_IOS_VOICE_NOT_ACTIVE = 3,
  AURORA_IOS_VOICE_CLOSED = 4,
};

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
  AURORA_IOS_AUDIO_EMPTY = 3,
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

// `gateway` and `bearer` are copied during this call. The returned session
// owns its audio queues; borrowed state/output pointers remain valid only
// until `aurora_ios_voice_session_free` is called.
AuroraIosVoiceSession *aurora_ios_voice_session_new(
    const char *gateway,
    const char *bearer,
    uint32_t remote_audio_consent);
void aurora_ios_voice_session_free(AuroraIosVoiceSession *session);
AuroraIosAudioState *aurora_ios_voice_session_audio_state(
    AuroraIosVoiceSession *session);
AuroraIosAudioOutput *aurora_ios_voice_session_output(
    AuroraIosVoiceSession *session);
int32_t aurora_ios_voice_session_start(
    AuroraIosVoiceSession *session,
    uint64_t *out_generation);
int32_t aurora_ios_voice_session_start_background(
    AuroraIosVoiceSession *session,
    uint64_t *out_generation);
int32_t aurora_ios_voice_session_finish(
    AuroraIosVoiceSession *session,
    uint64_t generation);
int32_t aurora_ios_voice_session_cancel(
    AuroraIosVoiceSession *session,
    uint64_t generation);
int32_t aurora_ios_voice_session_status(
    AuroraIosVoiceSession *session,
    AuroraIosVoiceSessionStatus *out_status);
void aurora_ios_voice_session_close(AuroraIosVoiceSession *session);

#endif
