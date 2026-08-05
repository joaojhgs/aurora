"""Deterministic speech-runtime dependency and ABI checker.

The checker intentionally never installs dependencies. Use ``uv run`` or an
already-created virtual environment to decide which packages are present, then
run the probe command inside that environment.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import textwrap
import time
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
        redacted = value.replace(home, "$HOME").replace(cwd, "$REPO")
        redacted = re.sub(r"(?i)(token|secret|password|api[_-]?key)=([^\\s,;]+)", r"\\1=<redacted>", redacted)
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
    return extra in {"all", "gateway", "runtime", "container"} or extra.startswith(RELEASE_EXTRA_PREFIXES)


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
    status = "abi_failure" if "numpy.dtype size changed" in stderr or "_ARRAY_API" in stderr else "runtime_failure"
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


def run_probes(probe_ids: set[str] | None, timeout: float, expected_numpy: str) -> list[CheckResult]:
    selected = [spec for spec in PROBES if probe_ids is None or spec["id"] in probe_ids]
    return [run_probe(spec, timeout=timeout, expected_numpy=expected_numpy) for spec in selected]


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

    scan_parser = subparsers.add_parser("scan", help="Scan pyproject and uv.lock dependency graphs.")
    scan_parser.set_defaults(command="scan")

    probe_parser = subparsers.add_parser("probe", help="Probe imports/runtime paths in the current interpreter.")
    probe_parser.add_argument("--probe", action="append", choices=[spec["id"] for spec in PROBES])
    probe_parser.add_argument("--timeout", type=float, default=20.0)
    probe_parser.add_argument("--expected-numpy", default=DEFAULT_NUMPY_VERSION)
    probe_parser.set_defaults(command="probe")

    args = parser.parse_args(argv)
    root = args.root.resolve()
    if args.command == "scan":
        results = scan_manifests(root)
        report = build_report("manifest_scan", results, root)
    else:
        probe_ids = set(args.probe) if args.probe else None
        results = run_probes(probe_ids, timeout=args.timeout, expected_numpy=args.expected_numpy)
        report = build_report("interpreter_probe", results, root)
    write_report(report, args.output)
    return exit_code(results)
