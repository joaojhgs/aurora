"""Manual Linux CPU condition; staged by setup_cpu.py, never automatic."""

from __future__ import annotations

import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import shutil
import signal
import socket
import subprocess
import time


def main() -> int:
    os.umask(0o077)

    root = pathlib.Path(__file__).resolve().parent
    setup = json.loads((root / "setup.json").read_text())
    source = pathlib.Path(setup["sourceRoot"])
    runner = root / "runner.py"
    python = pathlib.Path(setup["pythonExecutable"])
    venv_bin = python.parent
    venv_root = venv_bin.parent.resolve(strict=True)
    resolved_python = python.resolve(strict=True)
    expected_runner_sha = os.environ.get("AURORA_THESIS_RUNNER_SHA256", "")
    expected_controller_sha = os.environ.get("AURORA_THESIS_CONTROLLER_SHA256", "")
    assert (
        len(expected_runner_sha) == 64
        and hashlib.sha256(runner.read_bytes()).hexdigest() == expected_runner_sha
    ), "frozen manual CPU runner pin missing or drifted"
    assert (
        len(expected_controller_sha) == 64
        and hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
        == expected_controller_sha
    ), "frozen manual CPU controller pin missing or drifted"
    condition_manifest = root / "measurement-admission.json"
    condition_manifest_sha = os.environ.get("AURORA_THESIS_CONDITION_MANIFEST_SHA256", "")
    assert condition_manifest.is_file() and not condition_manifest.is_symlink(), (
        "frozen manual CPU condition manifest unavailable"
    )
    condition_manifest_bytes = condition_manifest.read_bytes()
    assert (
        len(condition_manifest_sha) == 64
        and hashlib.sha256(condition_manifest_bytes).hexdigest() == condition_manifest_sha
    ), "frozen manual CPU condition manifest missing or drifted"
    condition_data = json.loads(condition_manifest_bytes)
    assert (
        hashlib.sha256((root / "setup.json").read_bytes()).hexdigest()
        == condition_data["setupSHA256"]
    ), "setup data drift"
    assert (
        hashlib.sha256((root / "fixture-auth.private.json").read_bytes()).hexdigest()
        == condition_data["fixtureAuthSHA256"]
    ), "existing fixture data drift"
    for relative, item in condition_data["harnessFiles"].items():
        path = root / relative
        assert path.stat().st_size == item["bytes"], "harness size drift:" + relative
        assert hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"], (
            "harness source drift:" + relative
        )
    implementation = condition_data.get("implementation", {})
    assert implementation.get("runnerSha256") == expected_runner_sha, (
        "frozen manual CPU runner pin mismatch"
    )
    assert implementation.get("controllerSha256") == expected_controller_sha, (
        "frozen manual CPU controller pin mismatch"
    )
    assert condition_data.get("measurementPlan", {}).get("conditionOverallCapSeconds") == 57600, (
        "frozen manual CPU condition cap mismatch"
    )
    source_inventory = root / "source-inventory.json"
    source_inventory_sha = hashlib.sha256(source_inventory.read_bytes()).hexdigest()
    source_closure = condition_data.get("sourceClosure", {})
    assert source_closure.get("equivalenceVerified") is True, (
        "full cross-platform source equivalence not admitted"
    )
    assert source_closure.get("cpuSourceInventorySha256") == source_inventory_sha, (
        "frozen CPU source inventory mismatch"
    )
    assert python.is_file() and resolved_python.is_file(), (
        "admitted shared Python environment unavailable"
    )
    with resolved_python.open("rb") as file:
        assert (
            hashlib.file_digest(file, "sha256").hexdigest()
            == condition_data["pythonEnvironment"]["resolvedInterpreterSHA256"]
        ), "admitted Python interpreter drift"
    with pathlib.Path("/tmp/aurora-global-build.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run = root / "runtime"
        run.mkdir(mode=0o700, exist_ok=False)

        start = time.monotonic()
        child: subprocess.Popen | None = None
        counter_errors: list[dict[str, object]] = []
        clock_ticks = os.sysconf("SC_CLK_TCK")

        def mem_available() -> int:
            for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
            raise RuntimeError("MemAvailable unavailable")

        def put(name: str, value: object) -> None:
            (run / name).write_text(json.dumps(value, indent=2) + "\n")

        def read_counter(path: pathlib.Path) -> str | None:
            try:
                return path.read_text().strip() if path.exists() else None
            except OSError as exc:
                item = {"path": str(path), "errorClass": type(exc).__name__, "errno": exc.errno}
                if item not in counter_errors and len(counter_errors) < 16:
                    counter_errors.append(item)
                return None

        def process_cpu_ticks(pid: int) -> int | None:
            try:
                fields = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
                return int(fields[11]) + int(fields[12])
            except (FileNotFoundError, IndexError, ValueError):
                return None

        def terminate(signum: int, frame: object) -> None:
            raise SystemExit(128 + signum)

        signal.signal(signal.SIGTERM, terminate)

        def stop_owned() -> None:
            if child is None or child.poll() is not None:
                return
            for sig, cap in ((signal.SIGINT, 20), (signal.SIGTERM, 8), (signal.SIGKILL, 3)):
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(child.pid, sig)
                try:
                    child.wait(timeout=cap)
                    return
                except subprocess.TimeoutExpired:
                    continue

        record: dict[str, object] = {
            "kind": "individual_linux_cpu_full_audio_localbus_900_condition",
            "controllerPid": os.getpid(),
            "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "host": os.uname().nodename,
            "capSeconds": 57840,
            "flowCapSeconds": 180,
            "plannedMeasuredPerCondition": 900,
            "excludedWarmups": 15,
            "conditionCapSeconds": 57600,
            "cohortId": setup["attemptId"],
            "measurementStarted": False,
            "measuredRequests": 0,
            "cohort": "cpu-n_gpu_layers-0-n_threads-2",
            "gpuReservation": False,
            "globalBuildLockHeld": True,
            "sourceRoot": str(source),
            "venvExecutable": str(python),
            "venvRoot": str(venv_root),
            "resolvedInterpreter": str(resolved_python),
            "resolvedInterpreterSha256": hashlib.file_digest(
                resolved_python.open("rb"), "sha256"
            ).hexdigest(),
            "surface": "headless production Python local bus; native/web/Android separate",
            "physicalPlaybackVerified": False,
        }

        try:
            assert source.is_dir(), "private source snapshot missing"
            assert shutil.disk_usage(root).free >= 500_000_000, (
                "less than 500 MB free on candidate volume"
            )
            assert mem_available() >= 2_500_000_000, "less than 2.5 GB MemAvailable"

            stt_model = pathlib.Path(setup["sttDirectory"])
            llm_model = pathlib.Path(setup["llmModel"])
            piper_model = pathlib.Path(setup["ttsModel"])
            piper_config = pathlib.Path(setup["ttsConfig"])
            for required_path in (stt_model, llm_model, piper_model, piper_config):
                assert required_path.exists(), (
                    f"required cached model artifact missing: {required_path.name}"
                )

            candidate = json.loads((root / "candidate-manifest.json").read_text())
            wav = pathlib.Path(candidate["wavPath"])
            if not wav.is_absolute():
                wav = root / wav
            assert wav.is_file(), "frozen candidate WAV missing"
            assert hashlib.sha256(wav.read_bytes()).hexdigest() == candidate["wavSHA256"], (
                "frozen candidate WAV hash mismatch"
            )

            frozen = condition_data
            for name, item in frozen["sourceFiles"].items():
                path = source / name
                assert path.stat().st_size == item["bytes"], "pinned source size drift:" + name
                with path.open("rb") as file:
                    assert hashlib.file_digest(file, "sha256").hexdigest() == item["sha256"], (
                        "pinned source drift:" + name
                    )
            model_files = frozen["modelFiles"]
            for item in model_files:
                path = pathlib.Path(item["path"])
                assert path.stat().st_size == item["bytes"], "pinned weight size drift:" + path.name
                with path.open("rb") as file:
                    assert hashlib.file_digest(file, "sha256").hexdigest() == item["sha256"], (
                        "pinned weight drift:" + path.name
                    )
            pilot_sha = hashlib.sha256((root / "pilot-input.json").read_bytes()).hexdigest()
            assert pilot_sha == frozen["pilotInput"]["sha256"], "pilot input drift"
            record["matchedSourceFiles"] = len(frozen["sourceFiles"])
            record["matchedModelFiles"] = len(model_files)
            record["frozenCohortManifestSHA256"] = condition_manifest_sha
            piper_binding = frozen["piperExecutable"]
            with pathlib.Path(setup["piperExecutable"]).open("rb") as file:
                assert hashlib.file_digest(file, "sha256").hexdigest() == piper_binding["sha256"], (
                    "Piper executable drift"
                )

            record["initialResources"] = {
                "candidateVolumeFree": shutil.disk_usage(root).free,
                "memAvailable": mem_available(),
            }
            record["inputWavBytes"] = wav.stat().st_size
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]

            cfg = json.loads((source / "app/services/config/config_defaults.json").read_text())
            svc = cfg["services"]
            cfg["ui"]["activate"] = False
            cfg["system"].update(
                primary_language="en-US", voice_language="en-US", models_dir=str(root / "models")
            )
            for name in ("tooling", "scheduler"):
                svc[name]["enabled"] = False
            svc["db"]["enabled"] = True
            svc["db"]["embeddings"]["use_local"] = False
            fixture = json.loads((root / "fixture-auth.private.json").read_text())
            svc["auth"].update(enabled=True, api_keys=fixture["apiKeys"])
            svc["gateway"]["enabled"] = True
            svc["gateway"]["api"].update(
                host="127.0.0.1",
                port=port,
                request_timeout_s=180.0,
                token_secret=fixture["tokenSecret"],
            )
            svc["gateway"]["api"]["cors"].update(origins=[f"http://127.0.0.1:{port}"])
            svc["gateway"]["webrtc"]["enabled"] = False
            svc["gateway"]["mesh_network"]["enabled"] = False
            svc["stt"]["coordinator"]["enabled"] = False
            svc["stt"]["wakeword"]["enabled"] = False
            svc["stt"]["language"] = "en-US"
            stt = svc["stt"]["transcription"]
            stt.update(enabled=True, vad_enabled=False)
            stt["realtime_model"]["enabled"] = False
            stt["accurate_model"].update(
                enabled=True,
                model_size="base",
                model_size_or_path=str(stt_model),
                device="cpu",
                compute_type="int8",
            )

            tts = svc["tts"]
            tts.update(
                enabled=True,
                provider="piper",
                hardware_acceleration=False,
                default_voice_id=None,
                model_file_path=str(piper_model),
                model_config_file_path=str(piper_config),
                model_sample_rate=22050,
                piper_path=setup["piperExecutable"],
            )
            tts["providers"]["piper"].update(
                model_file_path=str(piper_model),
                model_config_file_path=str(piper_config),
                model_sample_rate=22050,
                executable_path=setup["piperExecutable"],
                cache_dir=str(root / "models/piper-cache"),
            )

            opts = {
                "model_path": str(llm_model),
                "temperature": 0.0,
                "max_tokens": 128,
                "n_ctx": 4096,
                "n_gpu_layers": 0,
                "n_batch": 64,
                "seed": 42,
                "n_threads": 2,
                "top_p": 1.0,
                "top_k": 1,
                "repeat_penalty": 1.0,
                "min_p": 0.0,
                "chat_format": "chatml-function-calling",
                "verbose": True,
            }
            assert opts == frozen["models"]["llm"]["actualConstructor"], (
                "frozen effective LLM options drift"
            )
            svc["orchestrator"].update(enabled=True)
            svc["orchestrator"]["llm"]["provider"] = "llama_cpp"
            svc["orchestrator"]["llm"]["local"]["llama_cpp"]["options"] = opts

            config = run / "config.json"
            config.write_text(json.dumps(cfg, sort_keys=True, indent=2) + "\n")
            env = os.environ.copy()
            env.update(
                PYTHONDONTWRITEBYTECODE="1",
                VIRTUAL_ENV=str(venv_root),
                PATH=str(venv_bin) + os.pathsep + env.get("PATH", ""),
                AURORA_CONFIG_FILE=str(config),
                AURORA_DATA_DIR=str(run / "data"),
                AURORA_ENV_FILE=str(run / "absent.env"),
                AURORA_BACKUP_DIR=str(run / "backups"),
                AURORA_ARCHITECTURE_MODE="threads",
                AURORA_TOKEN_SECRET=svc["gateway"]["api"]["token_secret"],
                HF_HOME=str(root / "hf-cache"),
                HF_HUB_OFFLINE="1",
                HF_HUB_DISABLE_TELEMETRY="1",
                AURORA_STT_WHISPER_DOWNLOAD_ROOT=str(stt_model),
                UV_CACHE_DIR=str(root / "uv-cache"),
                OMP_NUM_THREADS="2",
                OPENBLAS_NUM_THREADS="2",
                MKL_NUM_THREADS="2",
            )
            for key, value in setup.get("extraEnvironment", {}).items():
                assert key in ("LD_LIBRARY_PATH", "NLTK_DATA"), (
                    "unsupported extra environment setting"
                )
                env[key] = value
            env.update(
                AURORA_THESIS_RUN_ROOT=str(root),
                AURORA_VOICE_TELEMETRY_V430="1",
                AURORA_V409_OBSERVER_PATH=str(root / "hook/observer.py"),
                AURORA_VOICE_STAGE_OUTPUT=str(run / "voice-stages.jsonl"),
                AURORA_VOICE_STAGE_HOST_ID=setup["attemptId"],
                PYTHONPATH=str(root / "hook") + os.pathsep + str(source),
                AURORA_OUTPUT_DIR=str(run / "campaign"),
                AURORA_VOICE_FIXTURE_WAV=str(wav),
                AURORA_CANDIDATE_MANIFEST=str(root / "pilot-input.json"),
                AURORA_CANDIDATE_MANIFEST_SHA256=pilot_sha,
                AURORA_FROZEN_MANIFEST=str(condition_manifest),
                AURORA_FROZEN_MANIFEST_SHA256=condition_manifest_sha,
                AURORA_THESIS_RUNNER_SHA256=expected_runner_sha,
                AURORA_THESIS_CONTROLLER_SHA256=expected_controller_sha,
                AURORA_THESIS_CONDITION_MANIFEST=str(condition_manifest),
                AURORA_THESIS_CONDITION_MANIFEST_SHA256=condition_manifest_sha,
            )
            cmd = [str(python), str(root / "bootstrap.py")]
            record.update(
                command=cmd,
                configSHA256=hashlib.sha256(config.read_bytes()).hexdigest(),
                LLMOptionsSHA256=hashlib.sha256(
                    json.dumps(opts, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest(),
            )

            with (
                (run / "backend.private.log").open("xb") as log,
                (run / "resources.jsonl").open("x") as resources,
            ):
                child = subprocess.Popen(
                    cmd,
                    cwd=source,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                record["pid"] = child.pid
                put("launch.json", record)
                previous_ticks = process_cpu_ticks(child.pid)
                previous_time = time.monotonic()
                while child.poll() is None and time.monotonic() - start < 57840:
                    now = time.monotonic()
                    ticks = process_cpu_ticks(child.pid)
                    sample = {
                        "monotonicNs": time.monotonic_ns(),
                        "memAvailable": mem_available(),
                        "hostCpuRawCounters": pathlib.Path("/proc/stat")
                        .read_text()
                        .splitlines()[0],
                        "candidateVolumeFree": shutil.disk_usage(root).free,
                        "processCpuTicks": ticks,
                        "processCpuPercent": (
                            ((ticks - previous_ticks) / clock_ticks) / (now - previous_time) * 100
                            if ticks is not None
                            and previous_ticks is not None
                            and now > previous_time
                            else None
                        ),
                        "networkNamespace": read_counter(
                            pathlib.Path(f"/proc/{child.pid}/net/dev")
                        ),
                        "hostNetwork": read_counter(pathlib.Path("/proc/net/dev")),
                    }
                    try:
                        sample["childMemory"] = {
                            line.split(":", 1)[0]: line.split(":", 1)[1].strip()
                            for line in pathlib.Path(f"/proc/{child.pid}/status")
                            .read_text()
                            .splitlines()
                            if line.split(":", 1)[0] in {"VmRSS", "VmHWM", "VmSize", "Threads"}
                        }
                    except FileNotFoundError:
                        sample["childMemory"] = None
                    sample["counterErrors"] = list(counter_errors)
                    resources.write(json.dumps(sample) + "\n")
                    resources.flush()
                    if (
                        sample["candidateVolumeFree"] < 500_000_000
                        or sample["memAvailable"] < 2_500_000_000
                    ):
                        record["resourceCap"] = True
                        break
                    previous_ticks, previous_time = ticks, now
                    time.sleep(1)
                if child.poll() is None:
                    record["deadlineAction"] = "owned_test_process_only_cap_cleanup"
                    stop_owned()

            record["exitCode"] = child.returncode
            record["counterErrors"] = counter_errors
            text = (run / "backend.private.log").read_text(errors="replace")
            record["actualCpuBackendLogLines"] = [
                line[-1000:]
                for line in text.splitlines()
                if "offloaded " in line or "n_gpu_layers" in line or "ggml_cpu" in line
            ][:8]
        except BaseException as exc:
            record.update(error=type(exc).__name__ + ": " + str(exc)[:300], setupOrPilotFailed=True)
        finally:
            stop_owned()
            record.update(
                finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                elapsedSeconds=time.monotonic() - start,
                processPresentAfterWait=bool(child and pathlib.Path(f"/proc/{child.pid}").exists()),
                exitCode=child.returncode if child else None,
            )
            for name in ("campaign/summary.json", "campaign/progress.json"):
                path = run / name
                if path.exists():
                    outcome = json.loads(path.read_text())
                    denominators = outcome.get("phase_denominators", {}).get("measured", {})
                    observed = denominators.get("attempted", outcome.get("measured_attempted", 0))
                    record["measuredRequests"] = observed
                    record["measurementStarted"] = observed > 0
                    record["outcomeStatus"] = outcome.get("status")
                    record["outcomePath"] = str(path)
                    break
            put("terminal.json", record)
            print(
                "AURORA_THESIS_ACTUAL_TERMINAL="
                + json.dumps(
                    {
                        key: record.get(key)
                        for key in (
                            "controllerPid",
                            "pid",
                            "startedAt",
                            "finishedAt",
                            "elapsedSeconds",
                            "exitCode",
                            "error",
                            "processPresentAfterWait",
                            "actualCpuBackendLogLines",
                        )
                    }
                ),
                flush=True,
            )

        return 0 if record.get("exitCode") == 0 and not record.get("setupOrPilotFailed") else 1


if __name__ == "__main__":
    if os.environ.get("AURORA_THESIS_EXECUTE") != "900-measured":
        raise SystemExit("Use the manual launcher with explicit measurement opt-in.")
    raise SystemExit(main())
