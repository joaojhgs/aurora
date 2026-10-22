# V1067 final narrow source closure

Verdict: **APPROVE source closure of the two remaining V1066 findings.**

Reviewed `controller-integrated-v1067.py` SHA256 `5b0d4d58e53aa06d712f54782391872a8a403f81ed7108d51c21afb19d5b292c`, by exact diff against preserved V1066 `915b6370d77f5faa693b952e6bfe32f7aadd0ecb242f307d1f4f8b5899924487`. Original REQUEST_CHANGES reports remain historical. This review writes only this report; no runtime, tests, imports, models, builds, network, or source changes.

1. **Retirement reservation closed.** If bounded owned cleanup cannot prove retirement, the controller remains alive holding its existing flock, durably reports WAITING_OWNED_PROCESS_RETIREMENT, and passively polls the recorded PID/start-time owners and actual backend. It admits no further workload or repeated signals. SIGTERM during this hold does not cut the reservation. Only actual owner absence lets execution reach exit/release. Group expansion now begins only from live birth-matched owned members, not historical group IDs. This is an actual source fence rather than the prior informational flag.

2. **Partial strict-correctness continuation closed.** Full passed flows retain the three-stage requirement. For completed_incorrect, the unchanged hook failedStage selects the stages actually invoked: transcription requires STT; assistant requires STT and LLM; synthesis requires all three. Required spans retain actual backend PID, native clock, completed outcome and the frozen recorder constraint. An ordinary transcript/reply mismatch can therefore retain completed_incorrect without requiring fabricated downstream inference, while missing required evidence remains an operational stop. The existing warmup loop still requires correct outcomes and all three stages before releasing measurement.

The earlier timeout:null/explicit missing-reason correction remains intact. Strict transcript/Paris/WAV checks, serial null-SDK-CID association, input/models/artifact/source pins, counts, deadlines and prior source-positive boundaries were not reopened. No additional source fixes or scenario matrix requested.

This is a bounded source verdict, **not** a runtime result, native normal-UI readiness claim, actual 15-warmup release, or 900-call seal. Root retains fresh staging/hash/resource/lock admission, sole execution, actual provider/GPU/native warmup acceptance and later retirement/data sealing.
