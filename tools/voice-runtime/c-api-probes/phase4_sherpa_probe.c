#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sherpa-onnx/c-api/c-api.h"

typedef struct Options {
  const char *mode;
  const char *moonshine_dir;
  const char *kws_dir;
  const char *tts_dir;
  const char *silero_model;
  const char *vad_wav;
  const char *kws_wav;
  const char *text;
  int32_t cancel_after_callbacks;
} Options;

typedef struct CancelState {
  int32_t calls;
  int32_t stop_after_calls;
  int32_t total_callback_samples;
  int32_t last_callback_samples;
  float last_progress;
} CancelState;

static int streq(const char *a, const char *b) {
  return a != NULL && b != NULL && strcmp(a, b) == 0;
}

static void print_json_string(const char *value) {
  putchar('"');
  if (value != NULL) {
    for (const unsigned char *p = (const unsigned char *)value; *p != 0; ++p) {
      switch (*p) {
        case '"':
          fputs("\\\"", stdout);
          break;
        case '\\':
          fputs("\\\\", stdout);
          break;
        case '\b':
          fputs("\\b", stdout);
          break;
        case '\f':
          fputs("\\f", stdout);
          break;
        case '\n':
          fputs("\\n", stdout);
          break;
        case '\r':
          fputs("\\r", stdout);
          break;
        case '\t':
          fputs("\\t", stdout);
          break;
        default:
          if (*p < 0x20) {
            printf("\\u%04x", *p);
          } else {
            putchar(*p);
          }
      }
    }
  }
  putchar('"');
}

static void fail_json(const char *mode, const char *reason) {
  printf("{\"ok\":false,\"mode\":");
  print_json_string(mode);
  printf(",\"reason\":");
  print_json_string(reason);
  printf("}\n");
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

static int parse_args(int argc, char **argv, Options *opts) {
  memset(opts, 0, sizeof(*opts));
  opts->text = "Aurora local voice probe.";
  opts->cancel_after_callbacks = 1;

  for (int i = 1; i < argc; ++i) {
    const char *arg = argv[i];
    const char **target = NULL;
    if (streq(arg, "--mode")) {
      target = &opts->mode;
    } else if (streq(arg, "--moonshine-dir")) {
      target = &opts->moonshine_dir;
    } else if (streq(arg, "--kws-dir")) {
      target = &opts->kws_dir;
    } else if (streq(arg, "--tts-dir")) {
      target = &opts->tts_dir;
    } else if (streq(arg, "--silero-model")) {
      target = &opts->silero_model;
    } else if (streq(arg, "--vad-wav")) {
      target = &opts->vad_wav;
    } else if (streq(arg, "--kws-wav")) {
      target = &opts->kws_wav;
    } else if (streq(arg, "--text")) {
      target = &opts->text;
    } else if (streq(arg, "--cancel-after-callbacks")) {
      if (++i >= argc) {
        return -1;
      }
      opts->cancel_after_callbacks = atoi(argv[i]);
      continue;
    } else {
      return -1;
    }

    if (++i >= argc) {
      return -1;
    }
    *target = argv[i];
  }
  return opts->mode == NULL ? -1 : 0;
}

static int probe_stt(const Options *opts) {
  if (opts->moonshine_dir == NULL) {
    fail_json("stt", "missing --moonshine-dir");
    return 2;
  }

  char *wav = join_path(opts->moonshine_dir, "test_wavs/0.wav");
  char *encoder = join_path(opts->moonshine_dir, "encoder_model.ort");
  char *decoder = join_path(opts->moonshine_dir, "decoder_model_merged.ort");
  char *tokens = join_path(opts->moonshine_dir, "tokens.txt");
  if (!wav || !encoder || !decoder || !tokens || !has_file(wav) ||
      !has_file(encoder) || !has_file(decoder) || !has_file(tokens)) {
    fail_json("stt", "missing Moonshine model or test wav");
    free(wav);
    free(encoder);
    free(decoder);
    free(tokens);
    return 2;
  }

  const SherpaOnnxWave *wave = SherpaOnnxReadWave(wav);
  if (wave == NULL) {
    fail_json("stt", "failed to read wav");
    free(wav);
    free(encoder);
    free(decoder);
    free(tokens);
    return 3;
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
    fail_json("stt", "recognizer creation failed");
    SherpaOnnxFreeWave(wave);
    free(wav);
    free(encoder);
    free(decoder);
    free(tokens);
    return 4;
  }

  const SherpaOnnxOfflineStream *stream =
      SherpaOnnxCreateOfflineStream(recognizer);
  SherpaOnnxAcceptWaveformOffline(stream, wave->sample_rate, wave->samples,
                                  wave->num_samples);
  SherpaOnnxDecodeOfflineStream(recognizer, stream);
  const SherpaOnnxOfflineRecognizerResult *result =
      SherpaOnnxGetOfflineStreamResult(stream);

  printf("{\"ok\":true,\"mode\":\"stt\",\"sample_rate\":%d,"
         "\"input_samples\":%d,\"text\":",
         wave->sample_rate, wave->num_samples);
  print_json_string(result ? result->text : "");
  printf("}\n");

  SherpaOnnxDestroyOfflineRecognizerResult(result);
  SherpaOnnxDestroyOfflineStream(stream);
  SherpaOnnxDestroyOfflineRecognizer(recognizer);
  SherpaOnnxFreeWave(wave);
  free(wav);
  free(encoder);
  free(decoder);
  free(tokens);
  return 0;
}

static int probe_vad(const Options *opts) {
  if (opts->silero_model == NULL || opts->vad_wav == NULL) {
    fail_json("vad", "missing --silero-model or --vad-wav");
    return 2;
  }
  if (!has_file(opts->vad_wav) || !has_file(opts->silero_model)) {
    fail_json("vad", "missing Silero model or test wav");
    return 2;
  }

  const SherpaOnnxWave *wave = SherpaOnnxReadWave(opts->vad_wav);
  if (wave == NULL || wave->sample_rate != 16000) {
    fail_json("vad", "failed to read 16 kHz wav");
    if (wave != NULL) {
      SherpaOnnxFreeWave(wave);
    }
    return 3;
  }

  SherpaOnnxVadModelConfig config;
  memset(&config, 0, sizeof(config));
  config.silero_vad.model = opts->silero_model;
  config.silero_vad.threshold = 0.25f;
  config.silero_vad.min_silence_duration = 0.25f;
  config.silero_vad.min_speech_duration = 0.25f;
  config.silero_vad.max_speech_duration = 10.0f;
  config.silero_vad.window_size = 512;
  config.sample_rate = 16000;
  config.num_threads = 1;
  config.provider = "cpu";

  const SherpaOnnxVoiceActivityDetector *vad =
      SherpaOnnxCreateVoiceActivityDetector(&config, 30.0f);
  if (vad == NULL) {
    fail_json("vad", "voice activity detector creation failed");
    SherpaOnnxFreeWave(wave);
    return 4;
  }

  int32_t segments = 0;
  int32_t total_segment_samples = 0;
  for (int32_t i = 0; i < wave->num_samples; i += config.silero_vad.window_size) {
    int32_t remaining = wave->num_samples - i;
    if (remaining >= config.silero_vad.window_size) {
      SherpaOnnxVoiceActivityDetectorAcceptWaveform(
          vad, wave->samples + i, config.silero_vad.window_size);
    } else {
      SherpaOnnxVoiceActivityDetectorFlush(vad);
    }
    while (!SherpaOnnxVoiceActivityDetectorEmpty(vad)) {
      const SherpaOnnxSpeechSegment *segment =
          SherpaOnnxVoiceActivityDetectorFront(vad);
      if (segment != NULL) {
        ++segments;
        total_segment_samples += segment->n;
        SherpaOnnxDestroySpeechSegment(segment);
      }
      SherpaOnnxVoiceActivityDetectorPop(vad);
    }
  }
  SherpaOnnxVoiceActivityDetectorFlush(vad);
  while (!SherpaOnnxVoiceActivityDetectorEmpty(vad)) {
    const SherpaOnnxSpeechSegment *segment =
        SherpaOnnxVoiceActivityDetectorFront(vad);
    if (segment != NULL) {
      ++segments;
      total_segment_samples += segment->n;
      SherpaOnnxDestroySpeechSegment(segment);
    }
    SherpaOnnxVoiceActivityDetectorPop(vad);
  }

  printf("{\"ok\":true,\"mode\":\"vad\",\"sample_rate\":%d,"
         "\"segments\":%d,\"segment_samples\":%d}\n",
         wave->sample_rate, segments, total_segment_samples);
  SherpaOnnxDestroyVoiceActivityDetector(vad);
  SherpaOnnxFreeWave(wave);
  return 0;
}

static int probe_kws(const Options *opts) {
  if (opts->kws_dir == NULL) {
    fail_json("kws", "missing --kws-dir");
    return 2;
  }

  char *encoder =
      join_path(opts->kws_dir, "encoder-epoch-12-avg-2-chunk-16-left-64.onnx");
  char *decoder =
      join_path(opts->kws_dir, "decoder-epoch-12-avg-2-chunk-16-left-64.onnx");
  char *joiner =
      join_path(opts->kws_dir, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
  char *tokens = join_path(opts->kws_dir, "tokens.txt");
  char *keywords = join_path(opts->kws_dir, "test_wavs/test_keywords.txt");
  char *owned_wav = opts->kws_wav == NULL ? join_path(opts->kws_dir, "test_wavs/0.wav")
                                          : NULL;
  const char *wav = opts->kws_wav == NULL ? owned_wav : opts->kws_wav;
  if (!encoder || !decoder || !joiner || !tokens || !keywords || !wav ||
      !has_file(encoder) || !has_file(decoder) || !has_file(joiner) ||
      !has_file(tokens) || !has_file(keywords) || !has_file(wav)) {
    fail_json("kws", "missing KWS model or test data");
    free(encoder);
    free(decoder);
    free(joiner);
    free(tokens);
    free(keywords);
    free(owned_wav);
    return 2;
  }

  SherpaOnnxKeywordSpotterConfig config;
  memset(&config, 0, sizeof(config));
  config.model_config.transducer.encoder = encoder;
  config.model_config.transducer.decoder = decoder;
  config.model_config.transducer.joiner = joiner;
  config.model_config.tokens = tokens;
  config.model_config.provider = "cpu";
  config.model_config.num_threads = 1;
  config.keywords_file = keywords;
  config.max_active_paths = 4;
  config.keywords_score = 3.0f;
  config.keywords_threshold = 0.1f;

  const SherpaOnnxKeywordSpotter *kws = SherpaOnnxCreateKeywordSpotter(&config);
  if (kws == NULL) {
    fail_json("kws", "keyword spotter creation failed");
    free(encoder);
    free(decoder);
    free(joiner);
    free(tokens);
    free(keywords);
    free(owned_wav);
    return 3;
  }

  const SherpaOnnxWave *wave = SherpaOnnxReadWave(wav);
  const SherpaOnnxOnlineStream *stream = SherpaOnnxCreateKeywordStream(kws);
  if (wave == NULL || stream == NULL) {
    fail_json("kws", "failed to load KWS wav or stream");
    if (wave != NULL) {
      SherpaOnnxFreeWave(wave);
    }
    if (stream != NULL) {
      SherpaOnnxDestroyOnlineStream(stream);
    }
    SherpaOnnxDestroyKeywordSpotter(kws);
    free(encoder);
    free(decoder);
    free(joiner);
    free(tokens);
    free(keywords);
    free(owned_wav);
    return 4;
  }

  float tail_paddings[8000] = {0};
  int32_t detections = 0;
  char last_keyword[256] = {0};
  const int32_t chunk = 1600;
  for (int32_t i = 0; i < wave->num_samples; i += chunk) {
    int32_t n = wave->num_samples - i;
    if (n > chunk) {
      n = chunk;
    }
    SherpaOnnxOnlineStreamAcceptWaveform(stream, wave->sample_rate,
                                         wave->samples + i, n);
    while (SherpaOnnxIsKeywordStreamReady(kws, stream)) {
      SherpaOnnxDecodeKeywordStream(kws, stream);
      const SherpaOnnxKeywordResult *result =
          SherpaOnnxGetKeywordResult(kws, stream);
      if (result != NULL && result->keyword != NULL &&
          strlen(result->keyword) > 0) {
        ++detections;
        snprintf(last_keyword, sizeof(last_keyword), "%s", result->keyword);
        SherpaOnnxResetKeywordStream(kws, stream);
      }
      SherpaOnnxDestroyKeywordResult(result);
    }
  }
  SherpaOnnxOnlineStreamAcceptWaveform(stream, wave->sample_rate, tail_paddings,
                                       8000);
  SherpaOnnxOnlineStreamInputFinished(stream);
  while (SherpaOnnxIsKeywordStreamReady(kws, stream)) {
    SherpaOnnxDecodeKeywordStream(kws, stream);
    const SherpaOnnxKeywordResult *result =
        SherpaOnnxGetKeywordResult(kws, stream);
    if (result != NULL && result->keyword != NULL &&
        strlen(result->keyword) > 0) {
      ++detections;
      snprintf(last_keyword, sizeof(last_keyword), "%s", result->keyword);
      SherpaOnnxResetKeywordStream(kws, stream);
    }
    SherpaOnnxDestroyKeywordResult(result);
  }

  printf("{\"ok\":true,\"mode\":\"kws\",\"sample_rate\":%d,"
         "\"detections\":%d,\"last_keyword\":",
         wave->sample_rate, detections);
  print_json_string(last_keyword);
  printf("}\n");

  SherpaOnnxDestroyOnlineStream(stream);
  SherpaOnnxFreeWave(wave);
  SherpaOnnxDestroyKeywordSpotter(kws);
  free(encoder);
  free(decoder);
  free(joiner);
  free(tokens);
  free(keywords);
  free(owned_wav);
  return 0;
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

static int probe_tts(const Options *opts, int cancel) {
  if (opts->tts_dir == NULL) {
    fail_json(cancel ? "tts_cancel" : "tts", "missing --tts-dir");
    return 2;
  }
  char *model = join_path(opts->tts_dir, "en_US-ljspeech-medium.onnx");
  char *tokens = join_path(opts->tts_dir, "tokens.txt");
  char *data_dir = join_path(opts->tts_dir, "espeak-ng-data");
  if (!model || !tokens || !data_dir || !has_file(model) || !has_file(tokens)) {
    fail_json(cancel ? "tts_cancel" : "tts", "missing VITS/Piper model files");
    free(model);
    free(tokens);
    free(data_dir);
    return 2;
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
    fail_json(cancel ? "tts_cancel" : "tts", "TTS creation failed");
    free(model);
    free(tokens);
    free(data_dir);
    return 3;
  }

  SherpaOnnxGenerationConfig generation;
  memset(&generation, 0, sizeof(generation));
  generation.sid = 0;
  generation.speed = 1.0f;
  generation.silence_scale = 0.2f;

  CancelState state;
  memset(&state, 0, sizeof(state));
  state.stop_after_calls =
      opts->cancel_after_callbacks < 1 ? 1 : opts->cancel_after_callbacks;

  const SherpaOnnxGeneratedAudio *audio = SherpaOnnxOfflineTtsGenerateWithConfig(
      tts, opts->text, &generation, cancel ? stop_after_callback : NULL,
      cancel ? &state : NULL);

  if (audio == NULL) {
    fail_json(cancel ? "tts_cancel" : "tts", "TTS generation returned NULL");
    SherpaOnnxDestroyOfflineTts(tts);
    free(model);
    free(tokens);
    free(data_dir);
    return 4;
  }

  printf("{\"ok\":true,\"mode\":");
  print_json_string(cancel ? "tts_cancel" : "tts");
  printf(",\"sample_rate\":%d,\"num_speakers\":%d,\"audio_samples\":%d",
         audio->sample_rate, SherpaOnnxOfflineTtsNumSpeakers(tts), audio->n);
  if (cancel) {
    printf(",\"callback_calls\":%d,\"callback_samples\":%d,"
           "\"last_callback_samples\":%d,\"last_progress\":%.6f,"
           "\"cancel_requested\":true",
           state.calls, state.total_callback_samples,
           state.last_callback_samples, state.last_progress);
  }
  printf("}\n");

  SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
  SherpaOnnxDestroyOfflineTts(tts);
  free(model);
  free(tokens);
  free(data_dir);
  return 0;
}

int main(int argc, char **argv) {
  Options opts;
  if (parse_args(argc, argv, &opts) != 0) {
    fail_json("unknown", "usage: --mode MODE [--moonshine-dir DIR] "
                         "[--kws-dir DIR] [--tts-dir DIR] "
                         "[--silero-model FILE] [--vad-wav FILE] "
                         "[--kws-wav FILE] [--text TEXT]");
    return 64;
  }

  if (streq(opts.mode, "stt")) {
    return probe_stt(&opts);
  }
  if (streq(opts.mode, "vad")) {
    return probe_vad(&opts);
  }
  if (streq(opts.mode, "kws")) {
    return probe_kws(&opts);
  }
  if (streq(opts.mode, "tts")) {
    return probe_tts(&opts, 0);
  }
  if (streq(opts.mode, "tts_cancel")) {
    return probe_tts(&opts, 1);
  }

  fail_json(opts.mode, "unknown mode");
  return 64;
}
