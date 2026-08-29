#include "sherpa_probe_bridge.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sherpa-onnx/c-api/c-api.h"

typedef struct CancelState {
  int32_t calls;
  int32_t stop_after_calls;
  int32_t total_callback_samples;
  int32_t last_callback_samples;
  float last_progress;
} CancelState;

static char *copy_string(const char *value) {
  if (value == NULL) {
    value = "";
  }
  size_t n = strlen(value);
  char *out = (char *)malloc(n + 1);
  if (out == NULL) {
    return NULL;
  }
  memcpy(out, value, n + 1);
  return out;
}

static AuroraSherpaProbeResult *new_result(const char *mode) {
  AuroraSherpaProbeResult *result =
      (AuroraSherpaProbeResult *)calloc(1, sizeof(AuroraSherpaProbeResult));
  if (result == NULL) {
    return NULL;
  }
  result->mode = copy_string(mode);
  return result;
}

static AuroraSherpaProbeResult *fail_result(const char *mode,
                                            const char *reason) {
  AuroraSherpaProbeResult *result = new_result(mode);
  if (result != NULL) {
    result->ok = 0;
    result->reason = copy_string(reason);
  }
  return result;
}

static char *join_path(const char *dir, const char *leaf) {
  size_t dir_len = strlen(dir);
  size_t leaf_len = strlen(leaf);
  int needs_slash = dir_len > 0 && dir[dir_len - 1] != '/';
  char *out = (char *)malloc(dir_len + (size_t)needs_slash + leaf_len + 1);
  if (out == NULL) {
    return NULL;
  }
  memcpy(out, dir, dir_len);
  if (needs_slash) {
    out[dir_len] = '/';
  }
  memcpy(out + dir_len + (size_t)needs_slash, leaf, leaf_len);
  out[dir_len + (size_t)needs_slash + leaf_len] = 0;
  return out;
}

static int has_file(const char *path) {
  return path != NULL && SherpaOnnxFileExists(path) != 0;
}

AuroraSherpaProbeResult *aurora_sherpa_probe_stt(const char *moonshine_dir) {
  if (moonshine_dir == NULL) {
    return fail_result("rust_stt", "missing moonshine_dir");
  }

  char *wav = join_path(moonshine_dir, "test_wavs/0.wav");
  char *encoder = join_path(moonshine_dir, "encoder_model.ort");
  char *decoder = join_path(moonshine_dir, "decoder_model_merged.ort");
  char *tokens = join_path(moonshine_dir, "tokens.txt");
  if (!wav || !encoder || !decoder || !tokens || !has_file(wav) ||
      !has_file(encoder) || !has_file(decoder) || !has_file(tokens)) {
    free(wav);
    free(encoder);
    free(decoder);
    free(tokens);
    return fail_result("rust_stt", "missing Moonshine model or test wav");
  }

  const SherpaOnnxWave *wave = SherpaOnnxReadWave(wav);
  if (wave == NULL) {
    free(wav);
    free(encoder);
    free(decoder);
    free(tokens);
    return fail_result("rust_stt", "failed to read wav");
  }

  SherpaOnnxOfflineModelConfig model;
  memset(&model, 0, sizeof(model));
  model.num_threads = 1;
  model.provider = "cpu";
  model.tokens = tokens;
  model.moonshine.encoder = encoder;
  model.moonshine.merged_decoder = decoder;

  SherpaOnnxOfflineRecognizerConfig config;
  memset(&config, 0, sizeof(config));
  config.decoding_method = "greedy_search";
  config.model_config = model;

  const SherpaOnnxOfflineRecognizer *recognizer =
      SherpaOnnxCreateOfflineRecognizer(&config);
  if (recognizer == NULL) {
    SherpaOnnxFreeWave(wave);
    free(wav);
    free(encoder);
    free(decoder);
    free(tokens);
    return fail_result("rust_stt", "recognizer creation failed");
  }

  const SherpaOnnxOfflineStream *stream =
      SherpaOnnxCreateOfflineStream(recognizer);
  if (stream == NULL) {
    SherpaOnnxDestroyOfflineRecognizer(recognizer);
    SherpaOnnxFreeWave(wave);
    free(wav);
    free(encoder);
    free(decoder);
    free(tokens);
    return fail_result("rust_stt", "offline stream creation failed");
  }
  SherpaOnnxAcceptWaveformOffline(stream, wave->sample_rate, wave->samples,
                                  wave->num_samples);
  SherpaOnnxDecodeOfflineStream(recognizer, stream);
  const SherpaOnnxOfflineRecognizerResult *recognizer_result =
      SherpaOnnxGetOfflineStreamResult(stream);

  AuroraSherpaProbeResult *result = new_result("rust_stt");
  if (result != NULL) {
    result->ok = 1;
    result->sample_rate = wave->sample_rate;
    result->input_samples = wave->num_samples;
    result->text = copy_string(recognizer_result ? recognizer_result->text : "");
  }

  SherpaOnnxDestroyOfflineRecognizerResult(recognizer_result);
  SherpaOnnxDestroyOfflineStream(stream);
  SherpaOnnxDestroyOfflineRecognizer(recognizer);
  SherpaOnnxFreeWave(wave);
  free(wav);
  free(encoder);
  free(decoder);
  free(tokens);
  return result;
}

static int32_t stop_after_callback(const float *samples, int32_t n, float p,
                                   void *arg) {
  (void)samples;
  CancelState *state = (CancelState *)arg;
  state->calls += 1;
  state->total_callback_samples += n;
  state->last_callback_samples = n;
  state->last_progress = p;
  return state->calls < state->stop_after_calls ? 1 : 0;
}

AuroraSherpaProbeResult *aurora_sherpa_probe_tts_cancel(const char *tts_dir,
                                                        const char *text,
                                                        int32_t stop_after) {
  if (tts_dir == NULL) {
    return fail_result("rust_tts_cancel", "missing tts_dir");
  }
  if (text == NULL) {
    text = "Aurora local voice probe.";
  }

  char *model = join_path(tts_dir, "en_US-ljspeech-medium.onnx");
  char *tokens = join_path(tts_dir, "tokens.txt");
  char *data_dir = join_path(tts_dir, "espeak-ng-data");
  if (!model || !tokens || !data_dir || !has_file(model) || !has_file(tokens)) {
    free(model);
    free(tokens);
    free(data_dir);
    return fail_result("rust_tts_cancel", "missing VITS/Piper model files");
  }

  SherpaOnnxOfflineTtsConfig config;
  memset(&config, 0, sizeof(config));
  config.model.vits.model = model;
  config.model.vits.tokens = tokens;
  config.model.vits.data_dir = data_dir;
  config.model.vits.noise_scale = 0.667f;
  config.model.vits.noise_scale_w = 0.8f;
  config.model.vits.length_scale = 1.0f;
  config.model.num_threads = 1;
  config.model.provider = "cpu";
  config.max_num_sentences = 1;

  const SherpaOnnxOfflineTts *tts = SherpaOnnxCreateOfflineTts(&config);
  if (tts == NULL) {
    free(model);
    free(tokens);
    free(data_dir);
    return fail_result("rust_tts_cancel", "TTS creation failed");
  }

  SherpaOnnxGenerationConfig generation;
  memset(&generation, 0, sizeof(generation));
  generation.sid = 0;
  generation.speed = 1.0f;
  generation.silence_scale = 0.2f;

  CancelState state;
  memset(&state, 0, sizeof(state));
  state.stop_after_calls = stop_after < 1 ? 1 : stop_after;

  const SherpaOnnxGeneratedAudio *audio = SherpaOnnxOfflineTtsGenerateWithConfig(
      tts, text, &generation, stop_after_callback, &state);
  if (audio == NULL) {
    SherpaOnnxDestroyOfflineTts(tts);
    free(model);
    free(tokens);
    free(data_dir);
    return fail_result("rust_tts_cancel", "TTS generation returned NULL");
  }

  AuroraSherpaProbeResult *result = new_result("rust_tts_cancel");
  if (result != NULL) {
    result->ok = 1;
    result->sample_rate = audio->sample_rate;
    result->audio_samples = audio->n;
    result->num_speakers = SherpaOnnxOfflineTtsNumSpeakers(tts);
    result->callback_calls = state.calls;
    result->callback_samples = state.total_callback_samples;
    result->last_callback_samples = state.last_callback_samples;
    result->last_progress = state.last_progress;
  }

  SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
  SherpaOnnxDestroyOfflineTts(tts);
  free(model);
  free(tokens);
  free(data_dir);
  return result;
}

void aurora_sherpa_probe_free_result(AuroraSherpaProbeResult *result) {
  if (result == NULL) {
    return;
  }
  free(result->mode);
  free(result->reason);
  free(result->text);
  free(result);
}
