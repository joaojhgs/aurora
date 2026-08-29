"""Deterministic speech-runtime dependency and ABI checker.

The checker intentionally never installs dependencies. Use ``uv run`` or an
already-created virtual environment to decide which packages are present, then
run the probe command inside that environment.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.util
import io
import json
import os
import platform
import re
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import time
import traceback
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - exercised on Python 3.10.
    import tomli as tomllib

SCHEMA_VERSION = "aurora.speech_runtime_abi.v1"
DEFAULT_ARTIFACT_DIR = Path(".artifacts/pockettts/w0-numpy-abi")
DEFAULT_NUMPY_VERSION = "2.2.6"
EXPECTED_POCKET_TTS_CONFIG_FILES = {
    "english.yaml",
    "english_2026-01.yaml",
    "english_2026-04.yaml",
    "french_24l.yaml",
    "german.yaml",
    "german_24l.yaml",
    "italian.yaml",
    "italian_24l.yaml",
    "portuguese.yaml",
    "portuguese_24l.yaml",
    "spanish.yaml",
    "spanish_24l.yaml",
}

ROOT_ABSENT_PACKAGES = {
    "realtimestt",
    "realtime-stt",
    "openrecall",
    "easyocr",
    "pytesseract",
    "paddleocr",
    "ocrmypdf",
    "opencv-python",
    "opencv-contrib-python",
    "tesseract",
}

BENCHMARK_OR_TRAINING_ONLY_PACKAGES = {
    "pytest-benchmark": {"dev", "test", "test-all", "test-performance"},
    "sherpa-onnx": set(),
    "livekit": set(),
    "livekit-wakeword": set(),
    "torch-audiomentations": set(),
    "audiomentations": set(),
    "torchao": set(),
}

RELEASE_EXTRA_PREFIXES = (
    "runtime",
    "service-",
    "sidecar-",
    "mode-",
    "gateway",
    "all-services",
    "container",
    "cuda",
    "rocm",
    "metal",
    "vulkan",
    "sycl",
    "rpc",
    "torch-cpu",
    "openai",
    "embeddings-local",
    "local-",
    "full-local-",
    "all",
)

ARCHIVE_SUFFIXES = (
    ".zip",
    ".whl",
    ".jar",
    ".apk",
    ".aab",
    ".ipa",
    ".tar",
    ".tgz",
    ".tar.gz",
    ".tar.bz2",
    ".tbz2",
    ".tar.xz",
    ".txz",
)


def _artifact_package_rule(package: str) -> dict[str, Any]:
    normalized = package.lower().replace("_", "-")
    rule_name = normalized.replace("-", "_")
    return {
        "id": f"dependency.{rule_name}",
        "category": "benchmark_or_training_only_dependency",
        "needles": tuple(sorted({normalized, normalized.replace("-", "_")})),
    }


ARTIFACT_PACKAGE_BLOCK_RULES: tuple[dict[str, Any], ...] = tuple(
    _artifact_package_rule(package) for package in sorted(BENCHMARK_OR_TRAINING_ONLY_PACKAGES)
)

ARTIFACT_BLOCK_RULES: tuple[dict[str, Any], ...] = (
    *ARTIFACT_PACKAGE_BLOCK_RULES,
    {
        "id": "secret.release_credentials",
        "category": "secret_or_credential",
        "content_regexes": (
            (
                "openai_api_key",
                re.compile(rb"(?i)\bOPENAI_API_KEY\s*=\s*['\"]?[^ \r\n'\"]{8,}"),
            ),
            (
                "authorization_bearer",
                re.compile(rb"(?i)\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}"),
            ),
            (
                "bearer_token",
                re.compile(rb"(?i)\bBearer\s+(?:sk-[A-Za-z0-9._-]{8,}|[A-Za-z0-9._~+/=-]{20,})"),
            ),
            (
                "github_token",
                re.compile(
                    rb"(?i)(?:^|[\s{,;])['\"]?[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*['\"]?"
                    rb"\s*(?:=|:)\s*['\"]?"
                    rb"(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})"
                ),
            ),
            (
                "private_key",
                re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
            ),
            (
                "named_credential_assignment",
                re.compile(
                    rb"(?:^|[\s{,;])['\"]?"
                    rb"[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|KEY)[A-Z0-9_]*"
                    rb"['\"]?\s*(?:=|:)\s*['\"]?"
                    rb"(?=[A-Za-z0-9/+_=-]{24,})(?=[A-Za-z0-9/+_=-]*[A-Z])"
                    rb"(?=[A-Za-z0-9/+_=-]*[a-z])(?=[A-Za-z0-9/+_=-]*[0-9+/=])"
                    rb"[A-Za-z0-9/+_=-]{24,}(?=$|[\s,;}\]'\"])"
                ),
            ),
            (
                "generic_secret_assignment",
                re.compile(
                    rb"(?i)(?:^|[\s{,;])(?:token|secret|api[_-]?key)\s*=\s*['\"]?"
                    rb"(?=[A-Za-z0-9._~+/=-]{16,})(?=[A-Za-z0-9._~+/=-]*\d)"
                    rb"[A-Za-z0-9._~+/=-]{16,}"
                ),
            ),
        ),
    },
    {
        "id": "runtime.python_sidecar_marker",
        "category": "python_sidecar_runtime_marker",
        "allow_path_regexes": (re.compile(r"^scripts/build\.py$"),),
        "path_regexes": (
            (
                "aurora_sidecar_path",
                re.compile(r"(?i)(^|[/_.-])aurora-sidecar($|[/_.-])"),
            ),
        ),
        "content_regexes": (
            ("python_sidecar_staged", re.compile(rb'"pythonSidecarStaged"\s*:\s*true')),
            ("non_empty_external_bin", re.compile(rb'"externalBin"\s*:\s*\[[^\]]*[A-Za-z0-9_]')),
        ),
    },
    {
        "id": "asset.raven_or_kws",
        "category": "raven_kws_asset_or_input",
        "needles": (
            "raven",
            "kws-",
            "kws_",
            "/kws/",
            "keyword-spotting",
            "keyword_spotting",
            "wakeword-training",
            "wakeword_training",
        ),
    },
    {
        "id": "asset.training_dataset",
        "category": "training_dataset_or_benchmark_input",
        "needles": (
            "librispeech",
            "common_voice",
            "common-voice",
            "voxpopuli",
            "training-data",
            "training_data",
            "benchmark-data",
            "benchmark_data",
            "sherpa-benchmark",
            "sherpa_benchmark",
        ),
    },
    {
        "id": "asset.model_or_voice_weight_extension",
        "category": "model_or_voice_weight",
        "path_regex": re.compile(
            r"(?i)(\.safetensors|\.pt|\.pth|\.ckpt|\.onnx|\.tflite|\.gguf|\.model)$"
        ),
    },
    {
        "id": "asset.model_or_voice_binary",
        "category": "model_or_voice_weight",
        "path_regex": re.compile(
            r"(?i)(^|[/_.-])("
            r"model|weights?|checkpoint|voice|embedding|speaker|tokenizer"
            r")([/_.-]|$).*\.bin$"
        ),
    },
    {
        "id": "asset.audio_dataset_input",
        "category": "training_audio_dataset_or_prompt_input",
        "path_regex": re.compile(r"(?i)(\.wav|\.flac|\.mp3|\.ogg|\.opus|\.m4a|\.aac|\.webm)$"),
    },
)

PROBES: tuple[dict[str, Any], ...] = (
    {
        "id": "numpy",
        "kind": "runtime",
        "module": "numpy",
        "required": True,
        "code": """
import numpy as np
assert np.__version__ == expected_numpy, f"expected numpy {expected_numpy}, got {np.__version__}"
arr = np.asarray([1.0, 2.0, 3.0], dtype=np.float64)
detail = {"version": np.__version__, "sum": float(arr.sum())}
""",
    },
    {
        "id": "scipy",
        "kind": "runtime",
        "module": "scipy",
        "required": False,
        "code": """
import numpy as np
import scipy
from scipy import signal
resampled = signal.resample(np.asarray([0.0, 1.0, 0.0, -1.0]), 8)
detail = {"version": scipy.__version__, "resampled_len": int(resampled.shape[0])}
""",
    },
    {
        "id": "onnxruntime",
        "kind": "runtime",
        "module": "onnxruntime",
        "required": False,
        "code": """
import onnxruntime as ort
providers = ort.get_available_providers()
detail = {"version": ort.__version__, "providers": providers}
""",
    },
    {
        "id": "tflite_runtime",
        "kind": "optional_platform",
        "module": "tflite_runtime.interpreter",
        "required": False,
        "code": """
from tflite_runtime.interpreter import Interpreter
detail = {"interpreter": Interpreter.__name__}
""",
    },
    {
        "id": "faster_whisper",
        "kind": "runtime",
        "module": "faster_whisper",
        "required": False,
        "code": """
import faster_whisper
detail = {"version": getattr(faster_whisper, "__version__", "unknown")}
""",
    },
    {
        "id": "openwakeword",
        "kind": "runtime",
        "module": "openwakeword",
        "required": False,
        "code": """
import openwakeword
from openwakeword.model import Model
detail = {"version": getattr(openwakeword, "__version__", "unknown"), "model_class": Model.__name__}
""",
    },
    {
        "id": "ctranslate2",
        "kind": "runtime",
        "module": "ctranslate2",
        "required": False,
        "code": """
import ctranslate2
detail = {
    "version": ctranslate2.__version__,
    "cpu_compute_types": sorted(ctranslate2.get_supported_compute_types("cpu")),
}
""",
    },
    {
        "id": "piper",
        "kind": "runtime",
        "module": "piper",
        "required": False,
        "code": """
import piper
from piper.voice import PiperVoice
detail = {"module": getattr(piper, "__file__", None), "voice_class": PiperVoice.__name__}
""",
    },
    {
        "id": "realtimetts",
        "kind": "retained_runtime",
        "module": "RealtimeTTS",
        "required": False,
        "code": """
import RealtimeTTS
detail = {"module": getattr(RealtimeTTS, "__file__", None)}
""",
    },
    {
        "id": "numba",
        "kind": "retained_runtime",
        "module": "numba",
        "required": False,
        "code": """
import numba
@numba.njit
def add_one(value):
    return value + 1
detail = {"version": numba.__version__, "compiled_result": int(add_one(1))}
""",
    },
    {
        "id": "sqlite_vec",
        "kind": "runtime",
        "module": "sqlite_vec",
        "required": False,
        "code": """
import sqlite3
import sqlite_vec
conn = sqlite3.connect(":memory:")
conn.enable_load_extension(True)
sqlite_vec.load(conn)
version = conn.execute("select vec_version()").fetchone()[0]
conn.close()
detail = {"version": version}
""",
    },
    {
        "id": "pocket_tts",
        "kind": "candidate_runtime",
        "module": "pocket_tts",
        "required": False,
        "code": """
import importlib.metadata as metadata
import importlib.resources as resources
import inspect
import pkgutil
import pocket_tts
from pocket_tts import TTSModel
version = metadata.version("pocket-tts")
assert version == "2.1.0", f"expected pocket-tts 2.1.0, got {version}"
methods = {
    "load_model": str(inspect.signature(TTSModel.load_model)),
    "get_state_for_audio_prompt": str(inspect.signature(TTSModel.get_state_for_audio_prompt)),
    "generate_audio": str(inspect.signature(TTSModel.generate_audio)),
}
modules = sorted(m.name for m in pkgutil.walk_packages(pocket_tts.__path__, pocket_tts.__name__ + "."))
config_modules = [m for m in modules if "config" in m or "language" in m]
config_files = sorted(
    item.name for item in resources.files("pocket_tts.config").iterdir()
    if item.name.endswith((".yaml", ".yml"))
)
expected_config_files = {
    "english.yaml",
    "english_2026-01.yaml",
    "english_2026-04.yaml",
    "french_24l.yaml",
    "german.yaml",
    "german_24l.yaml",
    "italian.yaml",
    "italian_24l.yaml",
    "portuguese.yaml",
    "portuguese_24l.yaml",
    "spanish.yaml",
    "spanish_24l.yaml",
}
assert set(config_files) == expected_config_files, (
    f"unexpected PocketTTS config set: {config_files}"
)
detail = {
    "version": version,
    "methods": methods,
    "config_modules": config_modules[:40],
    "config_files": config_files,
}
""",
    },
)


@dataclass(frozen=True)
class CheckResult:
    id: str
    status: str
    detail: dict[str, Any] = field(default_factory=dict)


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _redact(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    if isinstance(value, tuple):
        return [_redact(v) for v in value]
    if isinstance(value, str):
        home = str(Path.home())
        cwd = os.getcwd()
        redacted = value.replace(cwd, "$REPO").replace(home, "$HOME")
        redacted = re.sub(
            r"(?i)(token|secret|password|api[_-]?key)=([^\\s,;]+)", r"\\1=<redacted>", redacted
        )
        return redacted
    return value


def _package_name(requirement: str) -> str:
    head = requirement.strip().split(";", 1)[0].strip()
    head = head.split("[", 1)[0]
    match = re.match(r"([A-Za-z0-9_.-]+)", head)
    return match.group(1).lower().replace("_", "-") if match else head.lower()


def _numpy_pin_issues(optional: dict[str, list[str]]) -> dict[str, list[str]]:
    issues: dict[str, list[str]] = {}
    for extra, requirements in optional.items():
        for requirement in requirements:
            if _package_name(requirement) != "numpy":
                continue
            direct = requirement.strip().split(";", 1)[0].strip()
            if not re.fullmatch(r"numpy\s*==\s*2\.2\.6", direct, flags=re.I):
                issues.setdefault(extra, []).append(requirement)
    return issues


def _is_release_extra(extra: str) -> bool:
    return extra in {"all", "gateway", "runtime", "container"} or extra.startswith(
        RELEASE_EXTRA_PREFIXES
    )


def load_pyproject(root: Path) -> dict[str, Any]:
    with (root / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)


def load_uv_lock(root: Path) -> dict[str, Any] | None:
    lock_path = root / "uv.lock"
    if not lock_path.exists():
        return None
    with lock_path.open("rb") as handle:
        return tomllib.load(handle)


def scan_manifests(root: Path) -> list[CheckResult]:
    pyproject = load_pyproject(root)
    optional = pyproject["project"].get("optional-dependencies", {})
    all_extra_names = sorted(optional)
    release_extras = sorted(extra for extra in all_extra_names if _is_release_extra(extra))

    by_extra: dict[str, set[str]] = {
        extra: {_package_name(req) for req in requirements}
        for extra, requirements in optional.items()
    }
    all_pyproject_packages = set().union(*by_extra.values()) if by_extra else set()

    root_absent_hits = sorted(all_pyproject_packages & ROOT_ABSENT_PACKAGES)
    results = [
        CheckResult(
            id="pyproject.supported_extras",
            status="pass",
            detail={"count": len(all_extra_names), "extras": all_extra_names},
        ),
        CheckResult(
            id="pyproject.release_extras",
            status="pass",
            detail={"count": len(release_extras), "extras": release_extras},
        ),
        CheckResult(
            id="pyproject.realtimestt_openrecall_ocr_absent",
            status="pass" if not root_absent_hits else "failure",
            detail={"matches": root_absent_hits},
        ),
    ]

    numpy_extras = sorted(extra for extra, names in by_extra.items() if "numpy" in names)
    numpy_pin_issues = _numpy_pin_issues(optional)
    results.append(
        CheckResult(
            id="pyproject.numpy_2_2_6_pin",
            status="pass" if not numpy_pin_issues else "failure",
            detail={
                "extras_with_numpy": numpy_extras,
                "expected": DEFAULT_NUMPY_VERSION,
                "issues": numpy_pin_issues,
            },
        )
    )

    leaked: dict[str, list[str]] = {}
    for package, allowed_extras in BENCHMARK_OR_TRAINING_ONLY_PACKAGES.items():
        package_extras = sorted(extra for extra, names in by_extra.items() if package in names)
        bad = [
            extra
            for extra in package_extras
            if _is_release_extra(extra) and extra not in allowed_extras
        ]
        if bad:
            leaked[package] = bad
    results.append(
        CheckResult(
            id="pyproject.benchmark_training_release_leak",
            status="pass" if not leaked else "failure",
            detail={"leaks": leaked},
        )
    )

    lock = load_uv_lock(root)
    if lock is None:
        results.append(CheckResult(id="uv_lock.present", status="missing_optional"))
        return results

    packages = lock.get("package", [])
    locked_names = sorted({pkg.get("name", "").lower().replace("_", "-") for pkg in packages})
    lock_absent_hits = sorted(set(locked_names) & ROOT_ABSENT_PACKAGES)
    results.append(
        CheckResult(
            id="uv_lock.transitive_realtimestt_openrecall_ocr_presence",
            status="informational",
            detail={"matches": lock_absent_hits},
        )
    )
    aurora = next((pkg for pkg in packages if pkg.get("name") == "aurora"), None)
    if aurora:
        lock_optional = aurora.get("optional-dependencies", {})
        locked_root_names = {
            dep.get("name", "").lower().replace("_", "-")
            for deps in lock_optional.values()
            for dep in deps
        }
        lock_optional_absent_hits = sorted(locked_root_names & ROOT_ABSENT_PACKAGES)
        results.append(
            CheckResult(
                id="uv_lock.optional_realtimestt_openrecall_ocr_absent",
                status="pass" if not lock_optional_absent_hits else "failure",
                detail={"matches": lock_optional_absent_hits},
            )
        )
        lock_release = sorted(extra for extra in lock_optional if _is_release_extra(extra))
        lock_leaked: dict[str, list[str]] = {}
        for package, allowed_extras in BENCHMARK_OR_TRAINING_ONLY_PACKAGES.items():
            package_extras = sorted(
                extra
                for extra, deps in lock_optional.items()
                if any(dep.get("name", "").lower().replace("_", "-") == package for dep in deps)
            )
            bad = [
                extra
                for extra in package_extras
                if _is_release_extra(extra) and extra not in allowed_extras
            ]
            if bad:
                lock_leaked[package] = bad
        results.append(
            CheckResult(
                id="uv_lock.benchmark_training_release_leak",
                status="pass" if not lock_leaked else "failure",
                detail={"release_extras": lock_release, "leaks": lock_leaked},
            )
        )

    return results


def _module_available(module_name: str) -> bool:
    parts = module_name.split(".")
    spec = importlib.util.find_spec(parts[0])
    if spec is None:
        return False
    if len(parts) == 1:
        return True
    return importlib.util.find_spec(module_name) is not None


def _probe_status(returncode: int, stdout: str, stderr: str, required: bool) -> CheckResult:
    last_json = None
    for line in reversed(stdout.splitlines()):
        try:
            last_json = json.loads(line)
            break
        except json.JSONDecodeError:
            continue
    if last_json is not None:
        return CheckResult(
            id=last_json["id"],
            status=last_json["status"],
            detail=last_json.get("detail", {}),
        )
    status = (
        "abi_failure"
        if "numpy.dtype size changed" in stderr or "_ARRAY_API" in stderr
        else "runtime_failure"
    )
    if returncode != 0 and required:
        status = "abi_failure" if status == "abi_failure" else "import_failure"
    return CheckResult(id="unknown", status=status, detail={"stderr_tail": stderr[-1200:]})


def run_probe(spec: dict[str, Any], timeout: float, expected_numpy: str) -> CheckResult:
    module_name = spec["module"]
    if not _module_available(module_name):
        return CheckResult(
            id=spec["id"],
            status="missing_optional" if not spec.get("required") else "import_failure",
            detail={"module": module_name},
        )

    body = textwrap.indent(textwrap.dedent(spec["code"]).strip(), "    ")
    probe_code = (
        "import json\n"
        "import traceback\n"
        f"expected_numpy = {expected_numpy!r}\n"
        "detail = {}\n"
        "try:\n"
        f"{body}\n"
        "    print(json.dumps("
        f'{{"id": {spec["id"]!r}, "status": "pass", "detail": detail}}, '
        "sort_keys=True))\n"
        "except Exception as exc:\n"
        "    tb = traceback.format_exc()\n"
        '    status = "abi_failure" if "numpy.dtype size changed" in tb '
        'or "_ARRAY_API" in tb else "runtime_failure"\n'
        "    print(json.dumps("
        f'{{"id": {spec["id"]!r}, "status": status, "detail": '
        '{"error_type": type(exc).__name__, "error": str(exc), '
        '"traceback_tail": tb[-1600:]}}, sort_keys=True))\n'
        "    raise\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as handle:
        handle.write(probe_code)
        probe_path = handle.name
    try:
        completed = subprocess.run(
            [sys.executable, probe_path],
            capture_output=True,
            check=False,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        return CheckResult(
            id=spec["id"],
            status="runtime_failure",
            detail={"timeout_seconds": timeout, "stdout": exc.stdout, "stderr": exc.stderr},
        )
    finally:
        Path(probe_path).unlink(missing_ok=True)

    result = _probe_status(
        completed.returncode,
        completed.stdout,
        completed.stderr,
        bool(spec.get("required")),
    )
    if result.id == "unknown":
        return CheckResult(
            id=spec["id"],
            status=result.status,
            detail={**result.detail, "returncode": completed.returncode},
        )
    return result


def run_probes(
    probe_ids: set[str] | None, timeout: float, expected_numpy: str
) -> list[CheckResult]:
    selected = [spec for spec in PROBES if probe_ids is None or spec["id"] in probe_ids]
    return [run_probe(spec, timeout=timeout, expected_numpy=expected_numpy) for spec in selected]


def _max_rss_kib() -> int | None:
    try:
        import resource
    except ImportError:  # pragma: no cover - non-Unix fallback.
        return None
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _hf_reference(ref: str) -> dict[str, str] | None:
    if not ref.startswith("hf://"):
        return None
    value = ref.removeprefix("hf://")
    parts = value.split("/")
    if len(parts) < 3:
        return None
    filename = "/".join(parts[2:])
    revision = None
    if "@" in filename:
        filename, revision = filename.rsplit("@", 1)
    return {
        "repo_id": "/".join(parts[:2]),
        "filename": filename,
        "revision": revision or "main",
    }


def _downloaded_ref_detail(name: str, ref: str) -> dict[str, Any]:
    detail: dict[str, Any] = {"name": name, "ref": ref}
    hf_ref = _hf_reference(ref)
    if hf_ref is not None:
        detail.update(hf_ref)
    try:
        if hf_ref is not None:
            from huggingface_hub import hf_hub_download

            path = Path(
                hf_hub_download(
                    repo_id=hf_ref["repo_id"],
                    filename=hf_ref["filename"],
                    revision=hf_ref["revision"],
                )
            )
        else:
            path = Path(ref)
        detail.update(
            {
                "path": str(path),
                "size_bytes": path.stat().st_size,
                "sha256": _sha256_file(path),
            }
        )
    except Exception as exc:  # pragma: no cover - exercised by integration probes.
        detail.update(
            {
                "download_status": "failure",
                "error_type": type(exc).__name__,
                "error": str(exc),
            }
        )
    return detail


def _pockettts_model_refs(model: Any, voice: str | None) -> dict[str, str]:
    refs: dict[str, str] = {}
    config = getattr(model, "config", None)
    if config is None:
        return refs
    for name in ("weights_path", "weights_path_without_voice_cloning"):
        value = getattr(config, name, None)
        if isinstance(value, str):
            refs[f"config.{name}"] = value
    flow_lm = getattr(config, "flow_lm", None)
    lookup_table = getattr(flow_lm, "lookup_table", None)
    tokenizer_path = getattr(lookup_table, "tokenizer_path", None)
    if isinstance(tokenizer_path, str):
        refs["config.flow_lm.lookup_table.tokenizer_path"] = tokenizer_path
    origin = getattr(model, "origin", None)
    if voice and origin is not None:
        try:
            from pocket_tts.utils.utils import get_predefined_voice

            refs[f"voice.{voice}"] = get_predefined_voice(language=origin.stem, name=voice)
        except Exception:
            pass
    return refs


def _tensor_detail(tensor: Any, sample_rate: int | None = None) -> dict[str, Any]:
    import torch

    cpu = tensor.detach().cpu()
    detail: dict[str, Any] = {
        "shape": list(cpu.shape),
        "dtype": str(cpu.dtype),
        "numel": int(cpu.numel()),
        "finite": bool(torch.isfinite(cpu).all()),
        "mean_abs": float(cpu.abs().mean()) if cpu.numel() else 0.0,
        "peak_abs": float(cpu.abs().max()) if cpu.numel() else 0.0,
    }
    if sample_rate and cpu.numel():
        detail["duration_seconds"] = float(cpu.numel() / sample_rate)
    return detail


def _duration(start: float) -> float:
    return round(time.perf_counter() - start, 6)


def _failure(stage: str, exc: BaseException) -> dict[str, Any]:
    return {
        "stage": stage,
        "error_type": type(exc).__name__,
        "error": str(exc),
        "traceback_tail": traceback.format_exc()[-1000:],
    }


def _pockettts_validation_failure(detail: dict[str, Any]) -> dict[str, Any] | None:
    finite = detail.get("finite_audio", {})
    if not finite.get("finite") or int(finite.get("numel", 0)) <= 0:
        return {
            "stage": "finite_audio_validation",
            "error": "finite audio must be non-empty and entirely finite",
            "finite_audio": finite,
        }
    stream = detail.get("stream_audio", {})
    if int(stream.get("chunk_count", 0)) <= 0 or int(stream.get("total_numel", 0)) <= 0:
        return {
            "stage": "stream_audio_validation",
            "error": "streaming audio must emit at least one non-empty chunk",
            "stream_audio": stream,
        }
    if not stream.get("all_finite"):
        return {
            "stage": "stream_audio_validation",
            "error": "all streaming chunks must be finite",
            "stream_audio": stream,
        }
    failed_configs = [
        item.get("language")
        for item in detail.get("config_smoke", [])
        if item.get("status") != "pass"
    ]
    if failed_configs:
        return {
            "stage": "config_smoke_validation",
            "error": "all requested PocketTTS configs must load",
            "failed_configs": failed_configs,
        }
    return None


def run_pockettts_inference(
    language: str,
    voice: str,
    text: str,
    stream_text: str,
    max_tokens: int,
    frames_after_eos: int,
    smoke_configs: bool,
) -> list[CheckResult]:
    detail: dict[str, Any] = {
        "language": language,
        "voice": voice,
        "text_length": len(text),
        "stream_text_length": len(stream_text),
        "max_tokens": max_tokens,
        "frames_after_eos": frames_after_eos,
        "quantize": False,
        "max_rss_kib_at_start": _max_rss_kib(),
    }
    timings: dict[str, float] = {}
    try:
        import importlib.metadata as metadata

        import numpy as np
        import torch
        from pocket_tts import TTSModel

        detail["versions"] = {
            "numpy": np.__version__,
            "pocket_tts": metadata.version("pocket-tts"),
            "torch": torch.__version__,
        }
        detail["audio_extra_modules_available"] = {
            "soundfile": _module_available("soundfile"),
        }
    except Exception as exc:
        detail["first_failure"] = _failure("import", exc)
        return [CheckResult(id="pockettts.inference", status="import_failure", detail=detail)]

    if detail["versions"]["numpy"] != DEFAULT_NUMPY_VERSION:
        detail["first_failure"] = {
            "stage": "version_check",
            "error": f"expected numpy {DEFAULT_NUMPY_VERSION}, got {detail['versions']['numpy']}",
        }
        return [CheckResult(id="pockettts.inference", status="abi_failure", detail=detail)]
    if detail["versions"]["pocket_tts"] != "2.1.0":
        detail["first_failure"] = {
            "stage": "version_check",
            "error": f"expected pocket-tts 2.1.0, got {detail['versions']['pocket_tts']}",
        }
        return [CheckResult(id="pockettts.inference", status="runtime_failure", detail=detail)]

    try:
        started = time.perf_counter()
        model = TTSModel.load_model(language=language, quantize=False)
        timings["load_model_seconds"] = _duration(started)
        sample_rate = getattr(model, "sample_rate", None)
        detail.update(
            {
                "sample_rate": sample_rate,
                "has_voice_cloning": bool(getattr(model, "has_voice_cloning", False)),
                "origin": str(getattr(model, "origin", "")),
                "max_rss_kib_after_load": _max_rss_kib(),
            }
        )
        refs = _pockettts_model_refs(model, voice)
        detail["downloaded_refs"] = [
            _downloaded_ref_detail(name, ref) for name, ref in sorted(refs.items())
        ]
    except Exception as exc:
        detail["timings"] = timings
        detail["first_failure"] = _failure("load_model", exc)
        return [CheckResult(id="pockettts.inference", status="runtime_failure", detail=detail)]

    try:
        started = time.perf_counter()
        state = model.get_state_for_audio_prompt(voice)
        timings["get_state_seconds"] = _duration(started)
        detail["state_keys"] = sorted(str(key) for key in state)
        detail["max_rss_kib_after_state"] = _max_rss_kib()
    except Exception as exc:
        detail["timings"] = timings
        detail["first_failure"] = _failure("get_state_for_audio_prompt", exc)
        return [CheckResult(id="pockettts.inference", status="runtime_failure", detail=detail)]

    try:
        started = time.perf_counter()
        audio = model.generate_audio(
            state,
            text,
            max_tokens=max_tokens,
            frames_after_eos=frames_after_eos,
            copy_state=True,
        )
        timings["generate_audio_seconds"] = _duration(started)
        detail["finite_audio"] = _tensor_detail(audio, sample_rate)
        detail["max_rss_kib_after_generate_audio"] = _max_rss_kib()
    except Exception as exc:
        detail["timings"] = timings
        detail["first_failure"] = _failure("generate_audio", exc)
        return [CheckResult(id="pockettts.inference", status="runtime_failure", detail=detail)]

    try:
        started = time.perf_counter()
        chunks = [
            _tensor_detail(chunk, sample_rate)
            for chunk in model.generate_audio_stream(
                state,
                stream_text,
                max_tokens=max_tokens,
                frames_after_eos=frames_after_eos,
                copy_state=True,
            )
        ]
        timings["generate_audio_stream_seconds"] = _duration(started)
        detail["stream_audio"] = {
            "chunk_count": len(chunks),
            "chunks": chunks,
            "total_numel": sum(int(chunk["numel"]) for chunk in chunks),
            "all_finite": all(bool(chunk["finite"]) for chunk in chunks),
        }
        detail["max_rss_kib_after_stream"] = _max_rss_kib()
    except Exception as exc:
        detail["timings"] = timings
        detail["first_failure"] = _failure("generate_audio_stream", exc)
        return [CheckResult(id="pockettts.inference", status="runtime_failure", detail=detail)]

    if smoke_configs:
        detail["config_smoke"] = _smoke_pockettts_configs(TTSModel)

    detail["timings"] = timings
    detail["max_rss_kib_at_end"] = _max_rss_kib()
    validation_failure = _pockettts_validation_failure(detail)
    if validation_failure is not None:
        detail["first_failure"] = validation_failure
        return [CheckResult(id="pockettts.inference", status="runtime_failure", detail=detail)]
    return [CheckResult(id="pockettts.inference", status="pass", detail=detail)]


def _smoke_pockettts_configs(tts_model_class: Any) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for config_name in sorted(EXPECTED_POCKET_TTS_CONFIG_FILES):
        language = config_name.removesuffix(".yaml")
        started = time.perf_counter()
        result: dict[str, Any] = {"language": language, "config_file": config_name}
        try:
            model = tts_model_class.load_model(language=language, quantize=False)
            result.update(
                {
                    "status": "pass",
                    "seconds": _duration(started),
                    "sample_rate": getattr(model, "sample_rate", None),
                    "has_voice_cloning": bool(getattr(model, "has_voice_cloning", False)),
                    "refs": [
                        _downloaded_ref_detail(name, ref)
                        for name, ref in sorted(_pockettts_model_refs(model, None).items())
                    ],
                    "max_rss_kib": _max_rss_kib(),
                }
            )
            del model
            gc.collect()
        except Exception as exc:  # pragma: no cover - integration probe path.
            result.update({"status": "failure", "seconds": _duration(started)})
            result["first_failure"] = _failure(f"load_model:{language}", exc)
        results.append(result)
    return results


@dataclass(frozen=True)
class ArtifactScanLimits:
    max_file_bytes: int = 128 * 1024 * 1024
    max_member_bytes: int = 128 * 1024 * 1024
    max_content_scan_bytes: int = 8 * 1024 * 1024
    max_archive_members: int = 20000
    max_nested_depth: int = 3


def _is_archive_name(name: str) -> bool:
    lowered = name.lower()
    return lowered.endswith(ARCHIVE_SUFFIXES)


def _safe_archive_member_name(name: str) -> bool:
    normalized = name.replace("\\", "/")
    path = Path(normalized)
    return not path.is_absolute() and ".." not in path.parts and not normalized.startswith("/")


def _display_path(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _rule_matches(rule: dict[str, Any], virtual_path: str, data: bytes) -> list[str]:
    matches: list[str] = []
    if any(pattern.search(virtual_path) for pattern in rule.get("allow_path_regexes", ())):
        return matches
    lowered_path = virtual_path.lower()
    content = data.lower()
    for needle in rule.get("needles", ()):
        encoded = str(needle).lower().encode()
        if str(needle).lower() in lowered_path or encoded in content:
            matches.append(str(needle))
    path_regex = rule.get("path_regex")
    if path_regex is not None and path_regex.search(virtual_path):
        matches.append("path_regex")
    for path_label, path_regex in rule.get("path_regexes", ()):
        if path_regex.search(virtual_path):
            matches.append(str(path_label))
    for content_label, content_regex in rule.get("content_regexes", ()):
        if content_regex.search(data):
            matches.append(str(content_label))
    return sorted(set(matches))


def _scan_record(
    records: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    virtual_path: str,
    size_bytes: int,
    sha256: str,
    content: bytes,
    source_kind: str,
) -> None:
    records.append(
        {
            "path": virtual_path,
            "source_kind": source_kind,
            "size_bytes": size_bytes,
            "sha256": sha256,
        }
    )
    for rule in ARTIFACT_BLOCK_RULES:
        matches = _rule_matches(rule, virtual_path, content)
        if matches:
            findings.append(
                {
                    "rule_id": rule["id"],
                    "category": rule["category"],
                    "path": virtual_path,
                    "matches": matches[:12],
                    "size_bytes": size_bytes,
                    "sha256": sha256,
                }
            )


def _read_limited(handle: Any, limit: int) -> tuple[bytes, bool]:
    data = handle.read(limit + 1)
    return data[:limit], len(data) > limit


def _scan_regular_file(
    path: Path,
    root: Path,
    limits: ArtifactScanLimits,
    records: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    limit_failures: list[dict[str, Any]],
) -> None:
    stat = path.stat()
    virtual_path = _display_path(path, root)
    sha256 = _sha256_file(path)
    if stat.st_size > limits.max_file_bytes:
        limit_failures.append(
            {
                "path": virtual_path,
                "reason": "file_size_exceeds_limit",
                "size_bytes": stat.st_size,
                "limit_bytes": limits.max_file_bytes,
                "sha256": sha256,
            }
        )
        content = b""
    else:
        with path.open("rb") as handle:
            content, truncated = _read_limited(handle, limits.max_content_scan_bytes)
        if truncated:
            limit_failures.append(
                {
                    "path": virtual_path,
                    "reason": "content_scan_truncated",
                    "size_bytes": stat.st_size,
                    "limit_bytes": limits.max_content_scan_bytes,
                    "sha256": sha256,
                }
            )
    _scan_record(records, findings, virtual_path, stat.st_size, sha256, content, "file")

    if _is_archive_name(path.name):
        _scan_archive_path(path, virtual_path, limits, records, findings, limit_failures, depth=0)


def _scan_zip_bytes(
    data: bytes,
    virtual_path: str,
    limits: ArtifactScanLimits,
    records: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    limit_failures: list[dict[str, Any]],
    depth: int,
) -> None:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        _scan_zip_archive(archive, virtual_path, limits, records, findings, limit_failures, depth)


def _scan_zip_archive(
    archive: zipfile.ZipFile,
    virtual_path: str,
    limits: ArtifactScanLimits,
    records: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    limit_failures: list[dict[str, Any]],
    depth: int,
) -> None:
    infos = archive.infolist()
    if len(infos) > limits.max_archive_members:
        limit_failures.append(
            {
                "path": virtual_path,
                "reason": "archive_member_count_exceeds_limit",
                "member_count": len(infos),
                "limit_members": limits.max_archive_members,
            }
        )
        return
    for info in infos:
        if info.is_dir():
            continue
        member_name = info.filename
        member_path = f"{virtual_path}!{member_name}"
        if not _safe_archive_member_name(member_name):
            limit_failures.append({"path": member_path, "reason": "unsafe_archive_member_path"})
            continue
        if info.file_size > limits.max_member_bytes:
            limit_failures.append(
                {
                    "path": member_path,
                    "reason": "archive_member_size_exceeds_limit",
                    "size_bytes": info.file_size,
                    "limit_bytes": limits.max_member_bytes,
                }
            )
            content = b""
            sha256 = ""
        else:
            with archive.open(info, "r") as handle:
                content, truncated = _read_limited(handle, limits.max_content_scan_bytes)
            sha256 = _digest_bytes(content) if info.file_size <= len(content) else ""
            if truncated:
                limit_failures.append(
                    {
                        "path": member_path,
                        "reason": "archive_member_content_scan_truncated",
                        "size_bytes": info.file_size,
                        "limit_bytes": limits.max_content_scan_bytes,
                    }
                )
        _scan_record(
            records,
            findings,
            member_path,
            int(info.file_size),
            sha256,
            content,
            "zip_member",
        )
        if content and _is_archive_name(member_name):
            if depth >= limits.max_nested_depth:
                limit_failures.append(
                    {
                        "path": member_path,
                        "reason": "nested_archive_depth_exceeds_limit",
                        "limit_depth": limits.max_nested_depth,
                    }
                )
                continue
            _scan_archive_bytes(
                content,
                member_path,
                limits,
                records,
                findings,
                limit_failures,
                depth + 1,
            )


def _scan_tar_bytes(
    data: bytes,
    virtual_path: str,
    limits: ArtifactScanLimits,
    records: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    limit_failures: list[dict[str, Any]],
    depth: int,
) -> None:
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
        _scan_tar_archive(archive, virtual_path, limits, records, findings, limit_failures, depth)


def _scan_tar_archive(
    archive: tarfile.TarFile,
    virtual_path: str,
    limits: ArtifactScanLimits,
    records: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    limit_failures: list[dict[str, Any]],
    depth: int,
) -> None:
    member_count = 0
    for member in archive:
        member_count += 1
        if member_count > limits.max_archive_members:
            limit_failures.append(
                {
                    "path": virtual_path,
                    "reason": "archive_member_count_exceeds_limit",
                    "member_count": member_count,
                    "limit_members": limits.max_archive_members,
                }
            )
            return
        if not member.isfile():
            continue
        member_name = member.name
        member_path = f"{virtual_path}!{member_name}"
        if not _safe_archive_member_name(member_name):
            limit_failures.append({"path": member_path, "reason": "unsafe_archive_member_path"})
            continue
        if member.size > limits.max_member_bytes:
            limit_failures.append(
                {
                    "path": member_path,
                    "reason": "archive_member_size_exceeds_limit",
                    "size_bytes": member.size,
                    "limit_bytes": limits.max_member_bytes,
                }
            )
            content = b""
        else:
            extracted = archive.extractfile(member)
            if extracted is None:
                continue
            with extracted:
                content, truncated = _read_limited(extracted, limits.max_content_scan_bytes)
            if truncated:
                limit_failures.append(
                    {
                        "path": member_path,
                        "reason": "archive_member_content_scan_truncated",
                        "size_bytes": member.size,
                        "limit_bytes": limits.max_content_scan_bytes,
                    }
                )
        sha256 = _digest_bytes(content) if member.size <= len(content) else ""
        _scan_record(
            records,
            findings,
            member_path,
            int(member.size),
            sha256,
            content,
            "tar_member",
        )
        if content and _is_archive_name(member_name):
            if depth >= limits.max_nested_depth:
                limit_failures.append(
                    {
                        "path": member_path,
                        "reason": "nested_archive_depth_exceeds_limit",
                        "limit_depth": limits.max_nested_depth,
                    }
                )
                continue
            _scan_archive_bytes(
                content,
                member_path,
                limits,
                records,
                findings,
                limit_failures,
                depth + 1,
            )


def _scan_archive_bytes(
    data: bytes,
    virtual_path: str,
    limits: ArtifactScanLimits,
    records: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    limit_failures: list[dict[str, Any]],
    depth: int,
) -> None:
    try:
        _scan_zip_bytes(data, virtual_path, limits, records, findings, limit_failures, depth)
        return
    except zipfile.BadZipFile:
        pass
    try:
        _scan_tar_bytes(data, virtual_path, limits, records, findings, limit_failures, depth)
    except tarfile.TarError:
        limit_failures.append({"path": virtual_path, "reason": "unsupported_or_corrupt_archive"})


def _scan_archive_path(
    path: Path,
    virtual_path: str,
    limits: ArtifactScanLimits,
    records: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    limit_failures: list[dict[str, Any]],
    depth: int,
) -> None:
    try:
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as archive:
                _scan_zip_archive(
                    archive, virtual_path, limits, records, findings, limit_failures, depth
                )
            return
        if tarfile.is_tarfile(path):
            with tarfile.open(path, mode="r:*") as archive:
                _scan_tar_archive(
                    archive, virtual_path, limits, records, findings, limit_failures, depth
                )
            return
        limit_failures.append({"path": virtual_path, "reason": "unsupported_or_corrupt_archive"})
    except (OSError, zipfile.BadZipFile, tarfile.TarError) as exc:
        limit_failures.append(
            {
                "path": virtual_path,
                "reason": "archive_read_failure",
                "error_type": type(exc).__name__,
                "error": str(exc),
            }
        )


def scan_artifacts(paths: list[Path], root: Path, limits: ArtifactScanLimits) -> list[CheckResult]:
    records: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    limit_failures: list[dict[str, Any]] = []
    missing: list[str] = []
    scanned_roots: list[str] = []

    for path in paths:
        candidate = path if path.is_absolute() else root / path
        if not candidate.exists():
            missing.append(_display_path(candidate, root))
            continue
        scanned_roots.append(_display_path(candidate, root))
        if candidate.is_dir():
            for file_path in sorted(item for item in candidate.rglob("*") if item.is_file()):
                _scan_regular_file(file_path, root, limits, records, findings, limit_failures)
        elif candidate.is_file():
            _scan_regular_file(candidate, root, limits, records, findings, limit_failures)

    status = "pass"
    if missing or findings or limit_failures:
        status = "failure"
    return [
        CheckResult(
            id="artifact.release_forbidden_content",
            status=status,
            detail={
                "scanned_roots": scanned_roots,
                "missing": missing,
                "file_count": len(records),
                "findings": findings,
                "limit_failures": limit_failures,
                "records": records[:5000],
                "records_truncated": len(records) > 5000,
                "limits": asdict(limits),
            },
        )
    ]


def build_report(kind: str, results: list[CheckResult], root: Path) -> dict[str, Any]:
    return {
        "schema": SCHEMA_VERSION,
        "kind": kind,
        "created_at_unix": int(time.time()),
        "root": str(root.resolve()),
        "python": {
            "executable": sys.executable,
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
            "platform": platform.platform(),
        },
        "results": [asdict(result) for result in results],
    }


def write_report(report: dict[str, Any], output: Path | None) -> None:
    redacted = _redact(report)
    payload = json.dumps(redacted, indent=2, sort_keys=True) + "\n"
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(payload, encoding="utf-8")
    else:
        sys.stdout.write(payload)


def exit_code(results: list[CheckResult]) -> int:
    hard_failures = {"failure", "import_failure", "abi_failure", "runtime_failure"}
    return 1 if any(result.status in hard_failures for result in results) else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path)
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan_parser = subparsers.add_parser(
        "scan", help="Scan pyproject and uv.lock dependency graphs."
    )
    scan_parser.set_defaults(command="scan")

    probe_parser = subparsers.add_parser(
        "probe", help="Probe imports/runtime paths in the current interpreter."
    )
    probe_parser.add_argument("--probe", action="append", choices=[spec["id"] for spec in PROBES])
    probe_parser.add_argument("--timeout", type=float, default=20.0)
    probe_parser.add_argument("--expected-numpy", default=DEFAULT_NUMPY_VERSION)
    probe_parser.set_defaults(command="probe")

    infer_parser = subparsers.add_parser(
        "pockettts-infer",
        help="Load PocketTTS 2.1.0 and run finite plus streaming inference.",
    )
    infer_parser.add_argument("--language", default="english")
    infer_parser.add_argument("--voice", default="alba")
    infer_parser.add_argument("--text", default="Hello.")
    infer_parser.add_argument("--stream-text", default="Hi.")
    infer_parser.add_argument("--max-tokens", type=int, default=12)
    infer_parser.add_argument("--frames-after-eos", type=int, default=1)
    infer_parser.add_argument("--smoke-configs", action="store_true")
    infer_parser.set_defaults(command="pockettts-infer")

    artifact_parser = subparsers.add_parser(
        "artifact-scan",
        help="Fail-closed scan of release artifacts or build inputs for forbidden speech assets.",
    )
    artifact_parser.add_argument("paths", nargs="+", type=Path)
    artifact_parser.add_argument("--max-file-bytes", type=int, default=128 * 1024 * 1024)
    artifact_parser.add_argument("--max-member-bytes", type=int, default=128 * 1024 * 1024)
    artifact_parser.add_argument("--max-content-scan-bytes", type=int, default=8 * 1024 * 1024)
    artifact_parser.add_argument("--max-archive-members", type=int, default=20000)
    artifact_parser.add_argument("--max-nested-depth", type=int, default=3)
    artifact_parser.set_defaults(command="artifact-scan")

    args = parser.parse_args(argv)
    root = args.root.resolve()
    if args.command == "scan":
        results = scan_manifests(root)
        report = build_report("manifest_scan", results, root)
    elif args.command == "probe":
        probe_ids = set(args.probe) if args.probe else None
        results = run_probes(probe_ids, timeout=args.timeout, expected_numpy=args.expected_numpy)
        report = build_report("interpreter_probe", results, root)
    elif args.command == "pockettts-infer":
        results = run_pockettts_inference(
            language=args.language,
            voice=args.voice,
            text=args.text,
            stream_text=args.stream_text,
            max_tokens=args.max_tokens,
            frames_after_eos=args.frames_after_eos,
            smoke_configs=args.smoke_configs,
        )
        report = build_report("pockettts_inference_probe", results, root)
    else:
        limits = ArtifactScanLimits(
            max_file_bytes=args.max_file_bytes,
            max_member_bytes=args.max_member_bytes,
            max_content_scan_bytes=args.max_content_scan_bytes,
            max_archive_members=args.max_archive_members,
            max_nested_depth=args.max_nested_depth,
        )
        results = scan_artifacts(args.paths, root=root, limits=limits)
        report = build_report("artifact_scan", results, root)
    write_report(report, args.output)
    return exit_code(results)
