#ifndef AURORA_SHERPA_PROBE_BRIDGE_H_
#define AURORA_SHERPA_PROBE_BRIDGE_H_

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct AuroraSherpaProbeResult {
  int32_t ok;
  char *mode;
  char *reason;
  char *text;
  int32_t sample_rate;
  int32_t input_samples;
  int32_t audio_samples;
  int32_t num_speakers;
  int32_t callback_calls;
  int32_t callback_samples;
  int32_t last_callback_samples;
  float last_progress;
} AuroraSherpaProbeResult;

AuroraSherpaProbeResult *aurora_sherpa_probe_stt(const char *moonshine_dir);

AuroraSherpaProbeResult *aurora_sherpa_probe_tts_cancel(const char *tts_dir,
                                                        const char *text,
                                                        int32_t stop_after);

void aurora_sherpa_probe_free_result(AuroraSherpaProbeResult *result);

#ifdef __cplusplus
}
#endif

#endif
