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

typedef struct AuroraIosVoiceTaskPackBinding {
  // 1=kws, 2=wakeword, 3=vad, 4=stt, 5=tts.
  int32_t task;
  // Optional NUL-terminated UTF-8 slot id. Null means the default slot.
  const char *slot_id;
  // Required NUL-terminated UTF-8 exact pack id selected from the catalog.
  const char *pack_id;
  // Required NUL-terminated UTF-8 active pack path selected by Swift.
  const char *pack_path;
  // Required NUL-terminated lowercase hex SHA-256 selected from the catalog.
  const char *expected_sha256;
  // Required exact byte size selected from the catalog.
  uint64_t expected_size_bytes;
  // Required NUL-terminated runtime/catalog revision selected from the catalog.
  const char *runtime_revision;
  // Required NUL-terminated JSON array of exact local files selected from the catalog.
  const char *files_json;
  // Required NUL-terminated BCP-47 language selected from the catalog.
  const char *language;
  // Required audio sample rate selected from the catalog.
  uint32_t sample_rate_hz;
  // Required provider frame size selected from the catalog.
  uint32_t frame_size;
  // Required catalog model family, for example vits_piper or pockettts.
  const char *model_family;
  // Optional private PocketTTS reference-audio file selected by the user.
  const char *reference_audio_path;
  // Optional lowercase SHA-256 for the private reference-audio file.
  const char *reference_audio_sha256;
  // Optional exact byte size for the private reference-audio file.
  uint64_t reference_audio_size_bytes;
  // Optional reference-audio sample rate.
  uint32_t reference_audio_sample_rate_hz;
  // Optional user-provided reference text paired with the audio.
  const char *reference_text;
  // Optional user-managed revision for the reference profile.
  const char *reference_revision;
} AuroraIosVoiceTaskPackBinding;

enum {
  AURORA_IOS_VOICE_OK = 0,
  AURORA_IOS_VOICE_INVALID_ARGUMENT = -1,
  AURORA_IOS_VOICE_UNAVAILABLE = 1,
  AURORA_IOS_VOICE_ALREADY_ACTIVE = 2,
  AURORA_IOS_VOICE_NOT_ACTIVE = 3,
  AURORA_IOS_VOICE_CLOSED = 4,
};

enum {
  AURORA_IOS_VOICE_PACK_OK = 0,
  AURORA_IOS_VOICE_PACK_INVALID_ARGUMENT = -1,
  AURORA_IOS_VOICE_PACK_UNAVAILABLE = 1,
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
AuroraIosVoiceSession *aurora_ios_voice_session_new_with_pack_bindings(
    const char *gateway,
    const char *bearer,
    uint32_t remote_audio_consent,
    const AuroraIosVoiceTaskPackBinding *bindings,
    uintptr_t bindings_len);
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

int32_t aurora_ios_voice_pack_install(
    const char *root,
    const char *pack_id,
    int32_t task);
char *aurora_ios_voice_pack_resolve_json(
    const char *root,
    const char *pack_id,
    int32_t task);
char *aurora_ios_voice_pack_embedded_catalog_json(void);
int32_t aurora_ios_voice_pack_remove(
    const char *root,
    const char *pack_id,
    int32_t task);
void aurora_ios_voice_pack_string_free(char *value);

#endif
