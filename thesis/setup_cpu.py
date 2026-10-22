"""Manually prepare one Linux CPU condition from existing source/env/models.

No installs, downloads, inference or service startup. A held Aurora build lock
refuses preparation before any run-directory writes or model reads.
"""

from __future__ import annotations

import argparse
import datetime
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
HARNESSES = (
    "controller.py",
    "runner.py",
    "bootstrap.py",
    "bindings.py",
    "hook/observer.py",
    "hook/aurora_voice_telemetry_v430.py",
)


def file_binding(path: Path) -> dict:
    with path.open("rb") as stream:
        size = os.fstat(stream.fileno()).st_size
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"path": str(path), "bytes": size, "sha256": digest}


def put(path: Path, value: object) -> None:
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def inspect_python(executable: Path) -> dict:
    code = """import importlib.metadata,json,platform,sys
print(json.dumps({'version':list(sys.version_info[:3]),'prefix':sys.prefix,
'executable':sys.executable,'platform':platform.platform(),
'machine':platform.machine(),'packages':{d.metadata['Name']:d.version
for d in importlib.metadata.distributions() if d.metadata['Name']}}))
"""
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    result = subprocess.run(
        [str(executable), "-c", code], env=env, capture_output=True, text=True, timeout=15
    )
    if result.returncode:
        raise ValueError("The provided existing Python environment could not be inspected.")
    try:
        value = json.loads(result.stdout)
    except ValueError:
        raise ValueError("Python environment inspection did not return metadata JSON.") from None
    if value["version"][:2] != [3, 11]:
        raise ValueError("The pinned workload requires Python3.11.")
    if Path(value["prefix"]).resolve() != executable.parent.parent.resolve():
        raise ValueError("Provide the existing virtual environment's bin/python path.")
    normalized = {
        name.casefold().replace("_", "-"): version for name, version in value["packages"].items()
    }
    expected = json.loads((BASE / "profiles/padded-capital-v1.json").read_text())["backendVersions"]
    if any(normalized.get(name) != version for name, version in expected.items()):
        raise ValueError("Provided backend versions differ from the pinned profile.")
    return value


def prepare(args: argparse.Namespace) -> dict:
    started = time.monotonic()
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    source = args.source.resolve(strict=True)
    # Preserve the venv entrypoint: resolving bin/python itself loses venv identity.
    executable = Path(os.path.abspath(args.python))
    if executable.name != "python" or not executable.is_file():
        raise ValueError("Provide an existing virtual environment's bin/python.")
    python_info = inspect_python(executable)
    profile_path = BASE / "profiles/padded-capital-v1.json"
    profile = json.loads(profile_path.read_text())
    count = profile["measurement"]
    if (
        count["measuredPerApplicableCondition"],
        count["excludedWarmups"],
        count["requestDeadlineSeconds"],
        count["cpuConditionCapSeconds"],
        count["cpuOuterCapSeconds"],
    ) != (900, 15, 180, 57600, 57840):
        raise ValueError("Manual CPU allocation/caps differ from the retained profile.")
    fixture_path = (profile_path.parent / profile["fixture"]).resolve(strict=True)
    fixture = json.loads(fixture_path.read_text())
    audio_path = (fixture_path.parent / fixture["audio"]).resolve(strict=True)
    audio = file_binding(audio_path)
    if (audio["bytes"], audio["sha256"]) != (fixture["bytes"], fixture["sha256"]):
        raise ValueError("Fixed audio bytes/hash differ from the qualified fixture.")
    if (
        hashlib.sha256(fixture["referenceTranscript"].encode()).hexdigest()
        != fixture["referenceTranscriptSHA256"]
    ):
        raise ValueError("Qualified reference transcript drift.")

    lock_path = BASE / "models/weight-lock-v1.json"
    weight_lock = json.loads(lock_path.read_text())
    stt = args.stt_dir.resolve(strict=True)
    llm = args.llm.resolve(strict=True)
    tts = args.tts.resolve(strict=True)
    tts_config = args.tts_config.resolve(strict=True)
    model_files = []
    for expected in weight_lock["files"]:
        if expected["role"] == "stt":
            path = stt / expected["name"]
        elif expected["role"] == "llm":
            path = llm
        else:
            path = tts_config if expected["name"].endswith(".json") else tts
        actual = file_binding(path)
        if (actual["bytes"], actual["sha256"]) != (expected["bytes"], expected["sha256"]):
            raise ValueError(
                "A provided model file differs from the pinned weights: " + expected["name"]
            )
        model_files.append({**actual, "role": expected["role"]})
    if len(model_files) != 7:
        raise ValueError("Expected exactly seven model/config file bindings.")
    piper = Path(os.path.abspath(args.piper))
    if not piper.is_file() or not os.access(piper, os.X_OK):
        raise ValueError("Provide the existing Piper executable.")

    # Extract only existing isolated fixture identity; never create credentials.
    existing = json.loads(args.fixture_config.read_text())
    keys = existing["services"]["auth"]["api_keys"]
    secret = existing["services"]["gateway"]["api"]["token_secret"]
    if not isinstance(keys, list) or not keys or not all(isinstance(k, str) and k for k in keys):
        raise ValueError("Existing isolated fixture API keys are required.")
    if not isinstance(secret, str) or not secret:
        raise ValueError("Existing isolated fixture token secret is required.")

    root = Path(os.path.abspath(args.run_dir))
    if root.exists() or root.is_symlink():
        raise FileExistsError("Keep previous attempts; select a fresh run directory.")
    root.mkdir(mode=0o700, parents=True)
    (root / "models").mkdir(mode=0o700)
    source_receipt = root / "source-verification.json"
    verified = subprocess.run(
        [
            sys.executable,
            str(BASE / "verify_source.py"),
            "--source",
            str(source),
            "--output",
            str(source_receipt),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if verified.returncode:
        raise ValueError("Production source differs from the400-file lock; receipt retained.")
    source_lock_path = BASE / "source/production-lock-v1.json"
    source_lock = json.loads(source_lock_path.read_text())
    files = {
        row["path"]: {"bytes": row["bytes"], "sha256": row["sha256"]}
        for row in source_lock["sourceFiles"]
    }
    if len(files) != 400:
        raise ValueError("Production lock must contain the qualified400 files.")
    put(
        root / "source-inventory.json",
        {
            "sourceRoot": str(source),
            "sourceFiles": files,
            "canonicalLock": file_binding(source_lock_path),
            "verification": file_binding(source_receipt),
        },
    )
    for relative in HARNESSES:
        target = root / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write((BASE / "harness/python-cpu-v1" / relative).read_bytes())
    shutil.copyfile(audio_path, root / "input.wav")
    put(
        root / "pilot-input.json",
        {
            "wavSHA256": fixture["sha256"],
            "referenceTranscript": fixture["referenceTranscript"],
            "expectedReplyWords": fixture["expectedReplyWords"],
        },
    )
    put(root / "candidate-manifest.json", {"wavPath": "input.wav", "wavSHA256": fixture["sha256"]})
    put(root / "fixture-auth.private.json", {"apiKeys": keys, "tokenSecret": secret})
    extra = {}
    if args.library_dir:
        extra["LD_LIBRARY_PATH"] = os.pathsep.join(
            str(p.resolve(strict=True)) for p in args.library_dir
        )
    if args.nltk_data:
        extra["NLTK_DATA"] = str(args.nltk_data.resolve(strict=True))
    attempt = args.attempt_id or "manual-cpu-" + datetime.datetime.now(
        datetime.timezone.utc
    ).strftime("%Y%m%dT%H%M%S%fZ")
    setup = {
        "sourceRoot": str(source),
        "pythonExecutable": str(executable),
        "sttDirectory": str(stt),
        "llmModel": str(llm),
        "ttsModel": str(tts),
        "ttsConfig": str(tts_config),
        "piperExecutable": str(piper),
        "attemptId": attempt,
        "extraEnvironment": extra,
    }
    put(root / "setup.json", setup)
    put(root / "profile.json", profile)
    put(root / "weight-lock.json", weight_lock)
    options = {
        "model_path": str(llm),
        **profile["models"]["llm"]["options"],
        "n_gpu_layers": 0,
        "verbose": True,
    }
    model_declarations = json.loads(json.dumps(profile["models"]))
    model_declarations["llm"]["actualConstructor"] = options
    model_declarations["stt"]["directory"] = str(stt)
    model_declarations["tts"].update(modelPath=str(tts), configPath=str(tts_config))
    manifest = {
        "schema": "aurora.thesis.manual-cpu-condition.v1",
        "status": "FROZEN_SETUP_NOT_EXECUTED",
        "attemptId": attempt,
        "frozenAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "measurementPlan": {
            "plannedMeasured": 900,
            "excludedWarmups": 15,
            "requestDeadlineSeconds": 180,
            "conditionOverallCapSeconds": 57600,
            "outerCapSeconds": 57840,
        },
        "implementation": {
            "runnerSha256": file_binding(root / "runner.py")["sha256"],
            "controllerSha256": file_binding(root / "controller.py")["sha256"],
        },
        "harnessFiles": {relative: file_binding(root / relative) for relative in HARNESSES},
        "sourceFiles": files,
        "modelFiles": model_files,
        "sourceClosure": {
            "equivalenceVerified": True,
            "cpuSourceInventorySha256": file_binding(root / "source-inventory.json")["sha256"],
            "scope": "All400 selected production files match the qualified common-source lock; not hardware/build equivalence.",
        },
        "models": model_declarations,
        "setupSHA256": file_binding(root / "setup.json")["sha256"],
        "fixtureAuthSHA256": file_binding(root / "fixture-auth.private.json")["sha256"],
        "pilotInput": file_binding(root / "pilot-input.json"),
        "pythonEnvironment": {
            **python_info,
            "resolvedInterpreterSHA256": file_binding(executable.resolve(strict=True))["sha256"],
        },
        "piperExecutable": file_binding(piper),
        "profile": file_binding(root / "profile.json"),
        "weightLock": file_binding(root / "weight-lock.json"),
        "hardware": {
            "host": os.uname().nodename,
            "machine": os.uname().machine,
            "osVisibleCpuCount": os.cpu_count(),
            "osVisibleMemory": Path("/proc/meminfo").read_text(),
            "llmGpuLayers": 0,
            "threads": 2,
            "gpuClaim": False,
            "physicalIsolationAdmitted": False,
        },
        "nativeBuildCaveat": "Package versions do not prove native source/build flags; record platform/native-library provenance separately.",
        "execution": "Manual opt-in launch only; normal15warmups must prove real providers and stages before measured1.",
        "newMeasuredRequests": 0,
    }
    put(root / "measurement-admission.json", manifest)
    receipt = {
        "schema": "aurora.thesis.cpu-prepared.v1",
        "attemptId": attempt,
        "runDirectory": str(root),
        "source": file_binding(Path(__file__).resolve()),
        "manifest": file_binding(root / "measurement-admission.json"),
        "newMeasuredRequests": 0,
        "modelsOrServicesLoaded": False,
        "sourceFilesVerified": 400,
        "modelFilesVerified": 7,
        "command": [sys.executable, *sys.argv],
        "python": sys.version,
        "startedAt": started_at,
        "durationSeconds": time.monotonic() - started,
        "exitCode": 0,
    }
    put(root / "PREPARED.json", receipt)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "source",
        "python",
        "stt-dir",
        "llm",
        "tts",
        "tts-config",
        "piper",
        "fixture-config",
        "run-dir",
    ):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--library-dir", type=Path, action="append")
    parser.add_argument("--nltk-data", type=Path)
    parser.add_argument("--attempt-id")
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 11) or sys.platform != "linux":
        parser.error("This adapter requires Linux and Python3.11.")
    os.umask(0o077)
    with Path("/tmp/aurora-global-build.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(
                "Aurora's build/measurement reservation is active; preparation refused.",
                file=sys.stderr,
            )
            return 2
        try:
            result = prepare(args)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
            print(
                json.dumps(
                    {
                        "status": "preparation_failed",
                        "errorClass": type(exc).__name__,
                        "error": str(exc),
                        "newMeasuredRequests": 0,
                    }
                ),
                file=sys.stderr,
            )
            return 1
    print(
        json.dumps(
            {
                "status": "prepared_not_executed",
                "runDirectory": result["runDirectory"],
                "manifestSHA256": result["manifest"]["sha256"],
                "newMeasuredRequests": 0,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
