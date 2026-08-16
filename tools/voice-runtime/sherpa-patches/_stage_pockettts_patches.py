#!/usr/bin/env python3
"""One-shot helper: edit a staged sherpa-onnx v1.13.5 tree and emit unified diffs.

This script is not part of the apply path. The durable queue lives in series +
the committed .patch files and apply_sherpa_patches.py.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SRC = REPO / ".artifacts/sherpa-onnx/sherpa-onnx-1.13.5"
STAGED = REPO / ".artifacts/sherpa-onnx/staged-patched"
PATCH_DIR = Path(__file__).resolve().parent

CREATE_ZERO_OLD = """static Ort::Value CreateZeroTensorLike(Ort::Session &sess, int32_t input_index,
                                       OrtAllocator *allocator) {
  auto type_info = sess.GetInputTypeInfo(input_index);
  auto tensor_info = type_info.GetTensorTypeAndShapeInfo();
  ONNXTensorElementDataType elem_type = tensor_info.GetElementType();
  std::vector<int64_t> shape = tensor_info.GetShape();

  // 3. Replace dynamic dims (-1) with 1
  for (auto &d : shape) {
    if (d < 0) {
      d = 1;
    }
  }

  Ort::Value v{nullptr};
  switch (elem_type) {
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT:
      v = Ort::Value::CreateTensor<float>(allocator, shape.data(),
                                          shape.size());
      Fill<float>(&v, 0);
      break;
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL:
      v = Ort::Value::CreateTensor<bool>(allocator, shape.data(), shape.size());
      Fill<bool>(&v, 0);
      break;
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64:
      v = Ort::Value::CreateTensor<int64_t>(allocator, shape.data(),
                                            shape.size());
      Fill<int64_t>(&v, 0);
      break;
    default:
      SHERPA_ONNX_LOGE("Unsupported tensor element type: %d", elem_type);
      SHERPA_ONNX_EXIT(-1);
  }

  return v;
}
"""

CREATE_ZERO_NEW = """static std::string PocketParentDir(const std::string &path) {
  auto pos = path.find_last_of("/\\\\");
  if (pos == std::string::npos) {
    return ".";
  }
  if (pos == 0) {
    return "/";
  }
  return path.substr(0, pos);
}

static size_t PocketElementSize(ONNXTensorElementDataType type) {
  switch (type) {
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT:
      return sizeof(float);
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16:
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_BFLOAT16:
      return sizeof(uint16_t);
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64:
      return sizeof(int64_t);
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32:
      return sizeof(int32_t);
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT8:
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_UINT8:
    case ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL:
      return 1;
    default:
      SHERPA_ONNX_LOGE("Unsupported tensor element type: %d",
                       static_cast<int>(type));
      SHERPA_ONNX_EXIT(-1);
  }
}

static void ZeroRawTensor(Ort::Value *v) {
  auto info = v->GetTensorTypeAndShapeInfo();
  auto n = info.GetElementCount();
  auto type = info.GetElementType();
  std::memset(v->GetTensorMutableRawData(), 0, n * PocketElementSize(type));
}

static Ort::Value CreateZeroTensorLike(Ort::Session &sess, int32_t input_index,
                                       OrtAllocator *allocator,
                                       int64_t empty_kv_seq_len) {
  auto type_info = sess.GetInputTypeInfo(input_index);
  auto tensor_info = type_info.GetTensorTypeAndShapeInfo();
  ONNXTensorElementDataType elem_type = tensor_info.GetElementType();
  std::vector<int64_t> shape = tensor_info.GetShape();

  // First dynamic dim is batch (1). Remaining dynamic dims are empty KV
  // sequence length: 1 for legacy English 2026-01 packs, 0 for current
  // multilingual Kyutai packs.
  bool first_dynamic = true;
  for (auto &d : shape) {
    if (d < 0) {
      if (first_dynamic) {
        d = 1;
        first_dynamic = false;
      } else {
        d = empty_kv_seq_len;
      }
    }
  }

  Ort::Value v = Ort::Value::CreateTensor(allocator, shape.data(), shape.size(),
                                          elem_type);
  ZeroRawTensor(&v);
  return v;
}

static PocketTtsProtocol LoadPocketProtocolFromDir(const std::string &dir) {
  PocketTtsProtocol protocol;
  std::string proto_path = dir + "/pocket_protocol.json";
  if (!FileExists(proto_path)) {
    return protocol;
  }

  std::ifstream ifs(proto_path);
  if (!ifs) {
    return protocol;
  }
  nlohmann::json j = nlohmann::json::parse(ifs, nullptr, false);
  if (j.is_discarded() || !j.is_object()) {
    SHERPA_ONNX_LOGE("Failed to parse PocketTTS protocol sidecar: %s",
                     proto_path.c_str());
    return protocol;
  }

  protocol.insert_bos_before_voice =
      j.value("insert_bos_before_voice", protocol.insert_bos_before_voice);
  protocol.frames_after_eos =
      j.value("frames_after_eos", protocol.frames_after_eos);
  protocol.eos_threshold = j.value("eos_threshold", protocol.eos_threshold);
  protocol.empty_kv_seq_len =
      j.value("empty_kv_seq_len", protocol.empty_kv_seq_len);
  protocol.latent_dim = j.value("latent_dim", protocol.latent_dim);
  protocol.pad_with_spaces_for_short_inputs = j.value(
      "pad_with_spaces_for_short_inputs",
      protocol.pad_with_spaces_for_short_inputs);
  protocol.remove_semicolons =
      j.value("remove_semicolons", protocol.remove_semicolons);

  std::string bos_file;
  if (j.contains("bos_before_voice") && j["bos_before_voice"].is_string()) {
    bos_file = j["bos_before_voice"].get<std::string>();
  }
  if (bos_file.empty() && j.contains("bos_before_voice") &&
      j["bos_before_voice"].is_object()) {
    bos_file = j["bos_before_voice"].value("file", std::string());
    if (j["bos_before_voice"].contains("shape") &&
        j["bos_before_voice"]["shape"].is_array()) {
      protocol.bos_shape.clear();
      for (const auto &dim : j["bos_before_voice"]["shape"]) {
        protocol.bos_shape.push_back(dim.get<int64_t>());
      }
    }
  }
  if (bos_file.empty()) {
    return protocol;
  }
  if (bos_file.find('/') != std::string::npos ||
      bos_file.find('\\\\') != std::string::npos) {
    SHERPA_ONNX_LOGE("Rejecting PocketTTS bos sidecar path: %s",
                     bos_file.c_str());
    return protocol;
  }
  std::string bos_path = dir + "/" + bos_file;
  std::ifstream bos(bos_path, std::ios::binary);
  if (!bos) {
    SHERPA_ONNX_LOGE("Missing PocketTTS bos sidecar: %s", bos_path.c_str());
    return protocol;
  }
  std::vector<char> raw((std::istreambuf_iterator<char>(bos)),
                        std::istreambuf_iterator<char>());
  if (raw.size() % sizeof(float) != 0 || raw.empty()) {
    SHERPA_ONNX_LOGE("Invalid PocketTTS bos sidecar size: %s", bos_path.c_str());
    return protocol;
  }
  protocol.bos_before_voice.resize(raw.size() / sizeof(float));
  std::memcpy(protocol.bos_before_voice.data(), raw.data(), raw.size());
  if (protocol.bos_shape.empty()) {
    protocol.bos_shape = {1, 1, 1024};
  }
  int64_t expected = 1;
  for (auto d : protocol.bos_shape) {
    expected *= d;
  }
  if (expected != static_cast<int64_t>(protocol.bos_before_voice.size())) {
    SHERPA_ONNX_LOGE("PocketTTS bos sidecar shape mismatch: %s",
                     bos_path.c_str());
    protocol.bos_before_voice.clear();
    protocol.bos_shape.clear();
  }
  return protocol;
}
"""


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing fragment: {label}")
    return text.replace(old, new, 1)


def write_diff(relpath: str, original: Path, updated: Path, patch_name: str, append: bool) -> None:
    result = subprocess.run(
        [
            "diff",
            "-u",
            "-N",
            "--label",
            f"a/{relpath}",
            "--label",
            f"b/{relpath}",
            str(original),
            str(updated),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode not in (0, 1):
        raise SystemExit(f"diff failed for {relpath}: {result.stderr}")
    patch_path = PATCH_DIR / patch_name
    mode = "a" if append else "w"
    with patch_path.open(mode, encoding="utf-8") as handle:
        handle.write(result.stdout)
        if not result.stdout.endswith("\n"):
            handle.write("\n")


def main() -> None:
    if not SRC.is_dir():
        raise SystemExit(f"missing staged source: {SRC}")
    if STAGED.exists():
        shutil.rmtree(STAGED)
    shutil.copytree(SRC, STAGED, symlinks=True)

    model_h = STAGED / "sherpa-onnx/csrc/offline-tts-pocket-model.h"
    model_cc = STAGED / "sherpa-onnx/csrc/offline-tts-pocket-model.cc"
    impl_h = STAGED / "sherpa-onnx/csrc/offline-tts-pocket-impl.h"
    wasm_cmake = STAGED / "wasm/tts/CMakeLists.txt"

    orig_h = SRC / "sherpa-onnx/csrc/offline-tts-pocket-model.h"
    orig_cc = SRC / "sherpa-onnx/csrc/offline-tts-pocket-model.cc"
    orig_impl = SRC / "sherpa-onnx/csrc/offline-tts-pocket-impl.h"
    orig_wasm = SRC / "wasm/tts/CMakeLists.txt"

    text = model_h.read_text(encoding="utf-8")
    text = replace_once(
        text,
        """#include <memory>
#include <tuple>
#include <utility>
#include <vector>
""",
        """#include <cstdint>
#include <memory>
#include <string>
#include <tuple>
#include <utility>
#include <vector>
""",
        "model.h includes",
    )
    text = replace_once(
        text,
        """namespace sherpa_onnx {

struct PocketLmMainState {
""",
        """namespace sherpa_onnx {

struct PocketTtsProtocol {
  bool insert_bos_before_voice = false;
  int32_t frames_after_eos = 3;
  float eos_threshold = -4.0f;
  int64_t empty_kv_seq_len = 1;
  int64_t latent_dim = 32;
  bool pad_with_spaces_for_short_inputs = false;
  bool remove_semicolons = false;
  std::vector<float> bos_before_voice;
  std::vector<int64_t> bos_shape;
};

struct PocketLmMainState {
""",
        "protocol struct",
    )
    text = replace_once(
        text,
        """  OrtAllocator *Allocator() const;

 private:
""",
        """  OrtAllocator *Allocator() const;

  const PocketTtsProtocol &Protocol() const;

  Ort::Value MaybeConcatBosBeforeVoice(Ort::Value encoder_out) const;

 private:
""",
        "protocol getters",
    )
    model_h.write_text(text, encoding="utf-8")

    text = model_cc.read_text(encoding="utf-8")
    text = replace_once(
        text,
        """#include <memory>
#include <string>
#include <tuple>
#include <utility>
#include <vector>
""",
        """#include <cstdint>
#include <cstring>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <tuple>
#include <utility>
#include <vector>
""",
        "model.cc includes",
    )
    text = replace_once(
        text,
        """#include "sherpa-onnx/csrc/macros.h"
#include "sherpa-onnx/csrc/onnx-utils.h"
#include "sherpa-onnx/csrc/session.h"
#include "sherpa-onnx/csrc/text-utils.h"
#include "sherpa-onnx/csrc/file-utils.h"
""",
        """#include "nlohmann/json.hpp"
#include "sherpa-onnx/csrc/macros.h"
#include "sherpa-onnx/csrc/onnx-utils.h"
#include "sherpa-onnx/csrc/session.h"
#include "sherpa-onnx/csrc/text-utils.h"
#include "sherpa-onnx/csrc/file-utils.h"
""",
        "nlohmann include",
    )
    text = replace_once(text, CREATE_ZERO_OLD, CREATE_ZERO_NEW, "CreateZeroTensorLike")
    text = replace_once(
        text,
        """  explicit Impl(const OfflineTtsModelConfig &config)
      : config_(config),
        env_(ORT_LOGGING_LEVEL_ERROR),
        sess_opts_(GetSessionOptions(config)) {
    lm_flow_sess_ = std::make_unique<Ort::Session>(
""",
        """  explicit Impl(const OfflineTtsModelConfig &config)
      : config_(config),
        env_(ORT_LOGGING_LEVEL_ERROR),
        sess_opts_(GetSessionOptions(config)) {
    protocol_ = LoadPocketProtocolFromDir(
        PocketParentDir(config_.pocket.vocab_json));
    lm_flow_sess_ = std::make_unique<Ort::Session>(
""",
        "ctor load protocol",
    )
    text = replace_once(
        text,
        """        sess_opts_(GetSessionOptions(config)) {
    {
      auto buf = ReadFile(mgr, config.pocket.lm_flow);
""",
        """        sess_opts_(GetSessionOptions(config)) {
    protocol_ = LoadPocketProtocolFromDir(
        PocketParentDir(config_.pocket.vocab_json));
    {
      auto buf = ReadFile(mgr, config.pocket.lm_flow);
""",
        "mgr ctor load protocol",
    )
    text = replace_once(
        text,
        """          CreateZeroTensorLike(*lm_main_sess_, i, allocator_));
""",
        """          CreateZeroTensorLike(*lm_main_sess_, i, allocator_,
                               protocol_.empty_kv_seq_len));
""",
        "lm main zeros",
    )
    text = replace_once(
        text,
        """          CreateZeroTensorLike(*mimi_decoder_sess_, i, allocator_));
""",
        """          CreateZeroTensorLike(*mimi_decoder_sess_, i, allocator_,
                               protocol_.empty_kv_seq_len));
""",
        "decoder zeros",
    )
    text = replace_once(
        text,
        """  OrtAllocator *Allocator() { return allocator_; }
""",
        """  OrtAllocator *Allocator() { return allocator_; }

  const PocketTtsProtocol &Protocol() const { return protocol_; }

  Ort::Value MaybeConcatBosBeforeVoice(Ort::Value encoder_out) const {
    if (!protocol_.insert_bos_before_voice) {
      return encoder_out;
    }
    if (protocol_.bos_before_voice.empty() || protocol_.bos_shape.size() != 3) {
      SHERPA_ONNX_LOGE(
          "insert_bos_before_voice is set but bos_before_voice sidecar is "
          "missing");
      return Ort::Value{nullptr};
    }
    auto info = encoder_out.GetTensorTypeAndShapeInfo();
    auto shape = info.GetShape();
    if (shape.size() != 3 || shape[0] != 1 ||
        shape[2] != protocol_.bos_shape[2]) {
      SHERPA_ONNX_LOGE("encoder output shape is incompatible with bos sidecar");
      return Ort::Value{nullptr};
    }
    int64_t bos_frames = protocol_.bos_shape[1];
    int64_t enc_frames = shape[1];
    int64_t dim = shape[2];
    std::vector<int64_t> out_shape = {1, bos_frames + enc_frames, dim};
    Ort::Value out = Ort::Value::CreateTensor<float>(
        const_cast<Impl *>(this)->Allocator(), out_shape.data(),
        out_shape.size());
    float *dst = out.GetTensorMutableData<float>();
    std::memcpy(dst, protocol_.bos_before_voice.data(),
                static_cast<size_t>(bos_frames * dim) * sizeof(float));
    std::memcpy(dst + bos_frames * dim, encoder_out.GetTensorData<float>(),
                static_cast<size_t>(enc_frames * dim) * sizeof(float));
    return out;
  }
""",
        "protocol methods",
    )
    text = replace_once(
        text,
        """  PocketLmMainState lm_main_init_states_;
  PocketMimiDecoderState mimi_decoder_init_states_;
};
""",
        """  PocketLmMainState lm_main_init_states_;
  PocketMimiDecoderState mimi_decoder_init_states_;
  PocketTtsProtocol protocol_;
};
""",
        "protocol member",
    )
    text = replace_once(
        text,
        """OrtAllocator *OfflineTtsPocketModel::Allocator() const {
  return impl_->Allocator();
}
""",
        """OrtAllocator *OfflineTtsPocketModel::Allocator() const {
  return impl_->Allocator();
}

const PocketTtsProtocol &OfflineTtsPocketModel::Protocol() const {
  return impl_->Protocol();
}

Ort::Value OfflineTtsPocketModel::MaybeConcatBosBeforeVoice(
    Ort::Value encoder_out) const {
  return impl_->MaybeConcatBosBeforeVoice(std::move(encoder_out));
}
""",
        "model wrappers",
    )
    model_cc.write_text(text, encoding="utf-8")

    text = impl_h.read_text(encoding="utf-8")
    text = replace_once(
        text,
        """    std::string text = _text;
    if (config_.model.debug) {
""",
        """    std::string text = _text;
    const auto &protocol = model_->Protocol();
    if (protocol.remove_semicolons) {
      for (char &ch : text) {
        if (ch == ';') {
          ch = ' ';
        }
      }
    }
    if (protocol.pad_with_spaces_for_short_inputs && text.size() < 8) {
      text.append(8 - text.size(), ' ');
    }
    if (config_.model.debug) {
""",
        "text preprocess",
    )
    text = replace_once(
        text,
        """      std::array<int64_t, 3> empty_seq_shape = {1, 0, 32};
""",
        """      int64_t latent_dim = model_->Protocol().latent_dim;
      std::array<int64_t, 3> empty_seq_shape = {1, 0, latent_dim};
""",
        "empty seq latent",
    )
    text = replace_once(
        text,
        """    std::vector<float> cur(1 * 1 * 32, std::numeric_limits<float>::quiet_NaN());
    std::array<int64_t, 3> cur_shape = {1, 1, 32};

    int32_t num_steps = gen_config.num_steps;
    int32_t max_frames = gen_config.GetExtraInt("max_frames", 500);
    int32_t frames_after_eos = gen_config.GetExtraInt("frames_after_eos", 3);
    float temperature = gen_config.GetExtraFloat("temperature", 0.7f);
    float stddev = std::sqrt(temperature);
    int32_t seed = gen_config.GetExtraInt("seed", -1);

    NormalDataGenerator normal_gen(0, stddev, seed);
    std::vector<float> noise(32, 0);
    std::array<int64_t, 2> noise_shape = {1, 32};
""",
        """    int64_t latent_dim = model_->Protocol().latent_dim;
    std::vector<float> cur(static_cast<size_t>(1 * 1 * latent_dim),
                           std::numeric_limits<float>::quiet_NaN());
    std::array<int64_t, 3> cur_shape = {1, 1, latent_dim};

    int32_t num_steps = gen_config.num_steps;
    int32_t max_frames = gen_config.GetExtraInt("max_frames", 500);
    int32_t frames_after_eos = gen_config.GetExtraInt(
        "frames_after_eos", model_->Protocol().frames_after_eos);
    float eos_threshold = gen_config.GetExtraFloat(
        "eos_threshold", model_->Protocol().eos_threshold);
    float temperature = gen_config.GetExtraFloat("temperature", 0.7f);
    float stddev = std::sqrt(temperature);
    int32_t seed = gen_config.GetExtraInt("seed", -1);

    NormalDataGenerator normal_gen(0, stddev, seed);
    std::vector<float> noise(static_cast<size_t>(latent_dim), 0);
    std::array<int64_t, 2> noise_shape = {1, latent_dim};
""",
        "eos and latent",
    )
    text = replace_once(
        text,
        """      if (eos_step < 0 && p_logit[0] > -4) {
        eos_step = step;
      }
""",
        """      if (eos_step < 0 && p_logit[0] > eos_threshold) {
        eos_step = step;
      }
""",
        "eos threshold",
    )
    text = replace_once(
        text,
        """    Ort::Value result = model_->RunMimiEncoder(std::move(x));

    auto info = result.GetTensorTypeAndShapeInfo();
""",
        """    Ort::Value result = model_->RunMimiEncoder(std::move(x));
    result = model_->MaybeConcatBosBeforeVoice(std::move(result));
    if (!result) {
      return Ort::Value{nullptr};
    }

    auto info = result.GetTensorTypeAndShapeInfo();
""",
        "bos concat",
    )
    impl_h.write_text(text, encoding="utf-8")

    text = wasm_cmake.read_text(encoding="utf-8")
    text = replace_once(
        text,
        """if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/assets/tokens.txt" AND
   NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/assets/lm_flow.int8.onnx")
  message(FATAL_ERROR "Please read ${CMAKE_CURRENT_SOURCE_DIR}/assets/README.md before you continue")
endif()
""",
        """set(_aurora_wasm_tts_neutral "$ENV{AURORA_SHERPA_WASM_TTS_NEUTRAL}")
if(NOT _aurora_wasm_tts_neutral STREQUAL "1")
  if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/assets/tokens.txt" AND
     NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/assets/lm_flow.int8.onnx")
    message(FATAL_ERROR "Please read ${CMAKE_CURRENT_SOURCE_DIR}/assets/README.md before you continue")
  endif()
endif()

set(_aurora_wasm_tts_helper "")
if(_aurora_wasm_tts_neutral STREQUAL "1")
  set(_aurora_wasm_tts_helper "${CMAKE_CURRENT_BINARY_DIR}/sherpa-onnx-tts.esm.js")
  configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/sherpa-onnx-tts.js"
    "${_aurora_wasm_tts_helper}"
    COPYONLY
  )
  file(APPEND
    "${_aurora_wasm_tts_helper}"
    "\\nexport { createOfflineTts, getDefaultOfflineTtsModelType };\\n"
  )
endif()
""",
        "wasm asset check",
    )
    text = replace_once(
        text,
        """string(APPEND MY_FLAGS "--preload-file ${CMAKE_CURRENT_SOURCE_DIR}/assets@. ")
string(APPEND MY_FLAGS " -sEXPORTED_RUNTIME_METHODS=['ccall','stringToUTF8','setValue','getValue','lengthBytesUTF8','UTF8ToString','HEAPU8','HEAP16','HEAP32','HEAPU32','HEAPF32','HEAPF64','addFunction','removeFunction'] ")
""",
        """if(_aurora_wasm_tts_neutral STREQUAL "1")
  string(APPEND MY_FLAGS " -sMODULARIZE=1 -sEXPORT_ES6=1 -sINCOMING_MODULE_JS_API=locateFile,noInitialRun,print,printErr ")
  string(APPEND MY_FLAGS " -sEXPORTED_RUNTIME_METHODS=['ccall','stringToUTF8','setValue','getValue','lengthBytesUTF8','UTF8ToString','HEAPU8','HEAP16','HEAP32','HEAPU32','HEAPF32','HEAPF64','addFunction','removeFunction','FS'] ")
else()
  string(APPEND MY_FLAGS "--preload-file ${CMAKE_CURRENT_SOURCE_DIR}/assets@. ")
  string(APPEND MY_FLAGS " -sEXPORTED_RUNTIME_METHODS=['ccall','stringToUTF8','setValue','getValue','lengthBytesUTF8','UTF8ToString','HEAPU8','HEAP16','HEAP32','HEAPU32','HEAPF32','HEAPF64','addFunction','removeFunction'] ")
endif()
""",
        "wasm preload",
    )
    text = replace_once(
        text,
        """install(
  FILES
    "$<TARGET_FILE_DIR:sherpa-onnx-wasm-main-tts>/sherpa-onnx-wasm-main-tts.js"
    "index.html"
    "sherpa-onnx-tts.js"
    "sherpa-onnx-tts.worker.js"
    "app-tts.js"
    "$<TARGET_FILE_DIR:sherpa-onnx-wasm-main-tts>/sherpa-onnx-wasm-main-tts.wasm"
    "$<TARGET_FILE_DIR:sherpa-onnx-wasm-main-tts>/sherpa-onnx-wasm-main-tts.data"
  DESTINATION
    bin/wasm/tts
)
""",
        """if(_aurora_wasm_tts_neutral STREQUAL "1")
  install(
    FILES
      "$<TARGET_FILE_DIR:sherpa-onnx-wasm-main-tts>/sherpa-onnx-wasm-main-tts.js"
      "index.html"
      "sherpa-onnx-tts.worker.js"
      "app-tts.js"
      "$<TARGET_FILE_DIR:sherpa-onnx-wasm-main-tts>/sherpa-onnx-wasm-main-tts.wasm"
    DESTINATION
      bin/wasm/tts
  )
  install(
    FILES "${_aurora_wasm_tts_helper}"
    DESTINATION bin/wasm/tts
    RENAME "sherpa-onnx-tts.js"
  )
else()
  install(
    FILES
      "$<TARGET_FILE_DIR:sherpa-onnx-wasm-main-tts>/sherpa-onnx-wasm-main-tts.js"
      "index.html"
      "sherpa-onnx-tts.js"
      "sherpa-onnx-tts.worker.js"
      "app-tts.js"
      "$<TARGET_FILE_DIR:sherpa-onnx-wasm-main-tts>/sherpa-onnx-wasm-main-tts.wasm"
      "$<TARGET_FILE_DIR:sherpa-onnx-wasm-main-tts>/sherpa-onnx-wasm-main-tts.data"
    DESTINATION
      bin/wasm/tts
  )
endif()
""",
        "wasm install",
    )
    wasm_cmake.write_text(text, encoding="utf-8")

    write_diff(
        "sherpa-onnx/csrc/offline-tts-pocket-model.h",
        orig_h,
        model_h,
        "0001-pockettts-multilingual-protocol.patch",
        append=False,
    )
    write_diff(
        "sherpa-onnx/csrc/offline-tts-pocket-model.cc",
        orig_cc,
        model_cc,
        "0001-pockettts-multilingual-protocol.patch",
        append=True,
    )
    write_diff(
        "sherpa-onnx/csrc/offline-tts-pocket-impl.h",
        orig_impl,
        impl_h,
        "0001-pockettts-multilingual-protocol.patch",
        append=True,
    )
    write_diff(
        "wasm/tts/CMakeLists.txt",
        orig_wasm,
        wasm_cmake,
        "0002-wasm-tts-neutral-no-preload.patch",
        append=False,
    )
    print("wrote patches")


if __name__ == "__main__":
    main()
