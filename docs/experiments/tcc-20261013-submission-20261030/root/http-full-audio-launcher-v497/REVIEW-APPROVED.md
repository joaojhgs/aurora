# V497 final GPU-binding source closure

**APPROVE, source only.** The sole remaining same-cohort launch omission is closed. Prior failed review reports remain preserved; their four earlier findings were already closed and were not reopened.

- controller.py: `a2337af9265073aaf1353b6c990e8bbd52457bc02e65fc1d056b0b9fd1eb5b8b`
- bootstrap.py: `7a3b4434d9cfaa3ea0ba157e6363c331895c1d40140d8062f136c97204a0cf00`
- README.md: `a05202663a1b63437cf8368eb49f0861bc034c99033cad7f16a60a0316b52080`

The controller now calls _admit_gpu before child Popen, requiring an AMD vendor 0x1002 device 0x7480 with exactly 8573157376 bytes VRAM; unavailable/mismatched identity raises before launch. Detected identity enters the private launch receipt. env.update explicitly supplies GGML_VK_VISIBLE_DEVICES='1' and OMP_NUM_THREADS/OPENBLAS_NUM_THREADS/MKL_NUM_THREADS='2', and these declared values are separately recorded in effectiveGpuEnvironment. The actual env dictionary is passed to child Popen; the code no longer relies on the ordinary parent shell inheriting a prior child's settings. This matches the scoped existing V485 guard/settings. It is not runtime proof of backend initialization, selected physical device or layer offload; actual later logs remain required.

Bootstrap hash remains unchanged. Strict correction-only source/stdlib AST inspection; no imports, runtime/tests/models/devices/network/remote execution or active campaign/source/index/goals/ledger/vault changes. Only this new private report written. Future independently frozen inputs/environment/deployment/resource admission and the held post-seal HTTP execution remain Root-owned. No runtime success, 900 completion, full-GPU or phase-2 claim.
