**Latest actual setup result: USB authorized and reachable — 2026-10-21T23:46:02UTC**

The existing Personal notebook controller now reaches the owner's **POCO X7 Pro**, serial **KBX8LNFUBE5XGQRG**. Actual `get-state` returned exit0 **device**; nonprivate `getprop` returned Xiaomi/model2412DPC0AG, **Android16/API36**, **arm64-v8a**. No USB approval or pairing action is needed.

The selected endpoint is `127.0.0.1:5037`; client/server are SDK37.0.0 build14910828. The current server is **PID39627**, UID1001/GID1002 with matching Personal network/user/mount namespaces and a USB fd open to `/dev/bus/usb/003/011`. It started externally at23:44:19 with **ADB_LIBUSB=1**, and `server-status` reports **LIBUSB, forced**. At23:40 the previous PID31031 used NATIVE and enumerated no phone despite fixed node permissions. Enumeration is now restored; the precise earlier native-backend failure was not isolated. This lane performed **no daemon restart, USB reset/rescan, permission/key/security change or namespace entry**. No further controller diagnosis is required for the present successful state.

| Actual readiness boundary | Fresh observation |
| --- | --- |
| USB identity/interface | Xiaomi POCO X7 Pro;2717:ff08;usb3-1;ADB interfaceff/42/01;node003/011 readable/writable |
| Phone properties | Model2412DPC0AG;Android16/API36;arm64-v8a;all five bounded getprops exit0 |
| Installed Aurora | `dev.aurora.desktop`,DEBUGGABLE,v1.0.0/code100,targetSDK36,updated2026-08-27;**source SHA unknown** |
| APK identity limit | Installed base.apk529,739,457bytes;SHA intentionally not computed because the bounded128MiB hash guard rejected it;no APK transfer |
| Phone power | USB charging;76%;34.6°C at23:45:16UTC |
| Direct LAN eligibility | **Phone Wi-Fi OFF**: `wifi_on=0`,no wlan0IPv4;route to notebook192.168.1.250 selects cellular`ccmni2` |
| Notebook LAN/source | Wi-Fi`wlp4s0`192.168.1.250/24;HEADdf23fd6e1f80e87dc45b6221bed87c00b4187e66;existing dirty files preserved |
| App/native route | No app installed/launched by this lane;native file-audio,cancel,actual model/stage/audio/HTTP/P2P proof still pending |
| Resource/collection | No build,model transfer,inference,pilot,warmup or measured case;main Root campaign untouched |

**Exact next action:** the owner must enable the phone's existing trusted Personal Wi-Fi for the required LAN route. This lane will not change network settings. The route command only selected a route and sent no measurement packets. USB remains control only. Neither ADB nor the cellular/overlay route qualifies as direct LAN HTTP or actual P2P evidence.

In parallel, Root's resource-owner decision is requested for finite disjoint source/runtime/model staging without pausing the current HTTP campaign. Exact approved local source remains`ebde3a8acf6315f920d03593845f17a1fc65a733` with remote SHA unknown;no fetch/pull/Git write occurred. The previously observed missing exact assets and llama runtime remain an independent readiness gate. This lane owns subsequent routine phone/app/native qualification; Root alone integrates any required product-source repair. The old installed app is not assumed to contain the approved native adapter. Full900/overnight execution still requires the later explicit owner start and finite availability window.

Actual command/source/window/checksum receipts are physically saved in both repositories:

- [Controller, process ownership, backend and successful serial command](evidence/adb-server-usb-diagnosis-20261021T234436/result.json):SHA256`e6a38b554147ebe59df6524b28fcdec20d3f8a58bfef14d4544ca6956423ee44`.
- [Actual successful phone properties, app version, battery and notebook dirty state](evidence/usb-authorized-readiness-20261021T234510/result.json).
- [Scoped package metadata, APK bound and actual Wi-Fi/route state](evidence/authorized-phone-route-app-20261021T234557/result.json).

[Current machine readiness](ACTUAL-READINESS-20261021.json) and [latest complete receipt bundle](LATEST-USB-CHECK.json) supersede older negative USB findings below. Targeted Ruff check/format passed for the two new read-only diagnostic scripts. No synthetic tooling test is counted as native readiness. The original failed Dispatch remains settled; this is direct-owner continuation with ordinary Root notifications, without a second completion signal.

---

**Preserved historical observations — superseded by the successful USB receipts above**

**Latest owner-requested single fresh check: 2026-10-21T23:40:20.290383+00:00**

**Change confirmed:** the current Personal environment can now read and write `/dev/bus/usb/003/011` (group1002). The USB access fix is visible. The remaining fresh result is ADB non-enumeration, not the prior node-permission denial and not an unauthorized-phone state. One physical USB disconnect/reconnect is a possible next discovery step; the cause is not yet proven.

Status: **KNOWN_SERIAL_NOT_REACHABLE_ON_EXPOSED_CONTROLLER**. `adb devices -l` exit 0; `adb -s KBX8LNFUBE5XGQRG get-state` exit 1.

Inventory stdout: `List of devices attached`. Selected-state result: `error: device 'KBX8LNFUBE5XGQRG' not found`.

Fresh USB metadata: `{"canRead": true, "canWrite": true, "exists": true, "gid": 1002, "manufacturer": "Xiaomi", "mode": "crw-rw----", "path": "/dev/bus/usb/003/011", "product": "POCO X7 Pro", "serial": "KBX8LNFUBE5XGQRG", "sysfsDevice": "3-1", "uid": 65534}`. Getprop results: `{}`.

[Actual result](evidence/owner-check-again-20261021T234015/result.json) and [fresh finite control intent](evidence/owner-check-again-20261021T234015/intent.json). SHA256 `1c9f619a8610b1da38093e5f63f4f5a8086c1076185ed0d959ec2211b72b48b4`; notebook copy was persisted before relay. Main campaign untouched; full overnight collection remains gated on owner start.

---

**Status: Fresh owner “fixed, check” execution — device still unreachable from this session**

A new finite read-only window was recorded under the renewed owner instruction, ending **2026-10-21T23:37:59.855047+00:00**. The earlier expired wrapper guard stopped before any command and is not evidence about the USB fix. Existing control terminal/incarnation was freshly fenced; no other terminal or lifecycle was adopted.

**Actual command results at2026-10-21T23:28:05UTC:**

| Command | Exit | Observed result |
| --- | --- | --- |
| `adb devices -l` |0| Successfully executed; attached-device list empty |
| `adb -s KBX8LNFUBE5XGQRG get-state` |1| `error: device 'KBX8LNFUBE5XGQRG' not found` |
| Private-free `getprop` requests |not run| Device is not reachable/authorized through this controller |

The attached hardware is still Xiaomi POCO X7 Pro, serial`KBX8LNFUBE5XGQRG`. Its current device node is **`/dev/bus/usb/003/011`**, changed from003/010. The existing ADB listener now has PID31031, changed from11271. The fresh process ran successfully, observed these changes and still reports that the Personal environment cannot read or write the new node (`crw-rw----`, mapped UID/GID65534). The existing listener itself responded normally; no server restart, key search, permission fix or namespace operation was performed by this check.

**Immediate reachability: not ready in the exposed Personal controller.** There is no evidence of an Android authorization dialog, and no successful device-property command can honestly be claimed. This is not a claim that host-wide ADB is unavailable. The existing host controller still needs an exposed supported route to this session. No new permission confirmation is pending.

The exact executed source, explicit commands, timestamps, exit codes, stderr and fresh window are saved in [actual command receipt](evidence/usb-exact-serial-fixed-20261021T232759/result.json) and [window/send intent](evidence/usb-exact-serial-fixed-20261021T232759/intent.json). Result SHA256: `026d9d69ee6d655bb16e0ec81809d2533d1d1cb79d9b68694e3ab66f47069c47`. The result was fsynced in the notebook repository before relay and is retained with an identical local checksum.

No app install/launch, native pilot, inference, source/model transfer or overnight case ran. Main Root HTTP/provider control is untouched. The current machine-readable state is [ACTUAL-READINESS-20261021.json](ACTUAL-READINESS-20261021.json). Earlier partial reports and all failed observations are preserved below and in the snapshot directory.

---

**Status: Current bounded check — POCO USB identified; exposed controllers cannot reach it**

On **2026-10-21**, the owner explicitly authorized read-only discovery and reuse of an existing Personal notebook host controller. No additional permission confirmation is pending.

The attached phone is **Xiaomi POCO X7 Pro**, hardware USB serial **KBX8LNFUBE5XGQRG**, read from the attached USB device's sysfs identity. The existing exposed ADB server at`127.0.0.1:5037` was actually queried: its inventory returned`OKAY` with no devices. The normal SDK command `adb -H 127.0.0.1 -P 5037 -s KBX8LNFUBE5XGQRG get-state` returned exit1: `error: device 'KBX8LNFUBE5XGQRG' not found`. No phone authorization dialog is established by this result, so no Allow action or pairing code is requested.

Existing-server metadata identifies Android platform tools37 and a Personal Podman-owned server process, with the current container user namespace and container marker. Its USB node`/dev/bus/usb/003/010` exists but is unreadable/unwritable by the Personal UID. The selected ADB server override variables are unset. This proves the exposed container server cannot currently reach the phone; it does **not** prove the physical host has no usable ADB controller.

Supported alternatives were checked. `orca emulator devices --worktree <existing Personal Aurora workspace> --json` returned an empty approved-device list. Project setup discovery exposes only`ssh:ssh-sem-notebook-personal` for this Personal notebook. Approved desktop discovery exposes only the separate Root desktop; no notebook desktop/controller is available there, and those Root targets were not used. `orca host list --json` is explicitly forbidden from this SSH worker. No alternate host ADB endpoint/socket or approved device selector is advertised through these surfaces. The installed host-spawn/distrobox-host-exec helpers were not executed because the owner's no-container-escape/no-namespace constraint remains in force; no generic host shell, namespace entry or privilege route was used.

**Exact next blocker:** an existing Personal host ADB controller must be reachable through an approved controller endpoint/socket or Orca device selector. **Minimal owner action:** provide that existing nonsecret endpoint/socket or selector. No key search, code, permission change, account switch, controller replacement, USB grant or invented confirmation dialog is needed or requested by this finding.

Actual setup is still **not ready**. ABI, Android version, Aurora app build/source and feature-consent state remain unreadable. There has been no app install/launch, native file-audio pilot or inference. The old wireless endpoint was not retried. Fresh notebook asset/runtime observations remain in [machine readiness](ACTUAL-READINESS-20261021.json): eight named model/audio candidates and the llama runtime/cache are unavailable at the inspected paths. Exact source/model/runtime acquisition and native pilot still need resource-safe execution; no heavy transfer/build ran and the main HTTP campaign remains independent. Full900/overnight collection still waits for the owner's explicit start and finite window.

The actual controller and serial queries, precise commands/errors, source bytes and updated report are preserved in both repositories. Prior failed/partial reports and all negative results remain intact under`evidence/usb-resume-20261021T2207/`. Historical2026-10-20 preparation follows below.

---

**Status: Partial setup — preparation verified; actual phone deployment blocked**

The isolated setup kit is physically present on the worker and Personal notebook. Notebook smoke verified19files/187,864bytes against manifest SHA`55b36d33ee52917cfc87495fcfda2f34fb7f915845988411766d289814c25df9`; all13tooling/saved-data checks passed on Python3.11.14 in0.101seconds. Its unadmitted collection preflight correctly refused with exit2. The same13checks passed locally, Ruff check/format passed and the local inference overlay validates the current configuration schema. These checks did not exercise a phone, native model or measured route.

The kit includes fenced sequential notebook controls, bounded readiness scripts, a schema-valid local-only service overlay, six-condition immutable manifest templates, a physical-resource dependency graph, append-only checksum custody, a finite guarded adapter orchestrator, saved-case type7 statistics/projection, safe-stop/return-phone instructions and a bounded native capability repair recommendation. It is under `thesis/phone-notebook/20261020/` locally and `.../prepared-kit-v1/` on the notebook. No shared product source, Git index, measured source/config, methodology or Ultragoal state was changed.

| Actual boundary | Observed result |
| --- | --- |
| Notebook | `skyron-notebook`, approved PersonalPodman namespace, Ryzen5 7535HS/12logical,32.79GBRAM/17.20GBavailable,101.96GBfree, load2.13,71°C, AC/100% at21:33:59UTC |
| Runtime | Existing Python3.11.14; five pinned packages match; `llama-cpp-python0.3.19` missing; accelerator/model offload unproven |
| Assets | All six named model/audio candidate paths absent; this is not a whole-host absence claim; exact model+auxiliary assets total774,455,356bytes before the219,794byte fixed WAV |
| Phone control | One existing-pair ADB connect to owner endpoint`100.64.0.4:35431` failed; `get-state` confirmed device not found; no reset, new pairing, code request or retry |
| Controller/topology | ADB37.0.0 in PersonalPodman, own daemon on127.0.0.1:5037; supplied phone address routes over`tailscale0` from100.64.0.2; notebook WiFi192.168.1.250/24 |
| Phone/app | Model, ABI, app build/source/APK, catalog and native capacity unknown because connection did not complete; no personal content read or Aurora app launched |
| Product routes | Authenticated PHONE→NOTEBOOK direct LAN HTTP and actual same-pair P2P MQTT/ICE remain unverified; ADB is not a measured route |
| Source | Root approved exact local commit`ebde3a8acf6315f920d03593845f17a1fc65a733`; push rejected, no verified remote SHA; no auth change, push retry, fetch/pull or source deployment here |
| Collection | Zero model calls, zero warmups, zero measured attempts; local baseline/applicable-cell eligibility unverified; no pilot timing or performance percentile invented |
| Owner window | Proposed seven to eight hours only; later explicit going-to-sleep start signal and exact UTC start/end/duration absent; collection refuses to start |

Three real readiness/connection/controller results were written and fsynced in the notebook repository before relay and verified against identical local checksums. Seven setup-copy receipts and the final notebook smoke have the same dual-host custody. The exact original code hashes for the first three discovery scripts are retained in their immutable intents; those scripts were subsequently formatted and their original bytes were not separately saved. All subsequent control operations retain exact executed source bytes. This limits source-text reconstruction for the preliminary metadata only; no scientific collection occurred.

The main remaining implementation gap is a qualified Android finite file-audio/native adapter with bounded cancellation and actual stage/audio/route/custody validation. The desktop hook is restricted to DEV+desktop-local+tauri-local; existing Android PCM injection is restricted to debuggable packages. [NATIVE-ADAPTER.md](NATIVE-ADAPTER.md) describes how Root can qualify the existing entrypoint or make a minimal source repair. No mock/Python substitute or native acceptance claim was made.

Root alone owns later resource admission. The approved local server-source subset is402files/7,524,554blob bytes, estimated7,849,472tar bytes, inventoried in [SOURCE-PIN.json](SOURCE-PIN.json). A requested future <=12MiB/120second copy-only window remains separate from the774MBasset/runtime/inference admission. Routine phone work remains in this lane; no Root phone checks or K3 campaign dependency were introduced.

All already-issued preparation commands completed. No native turn/app was started, so no phone occupation or task-owned native session needs cancellation. The ordinary ADB daemon remains available without pairing/security changes; it was not killed or reset. The notebook control lease expires22:02UTC and can be returned to Root early after this bounded branch. Actual deployment and overnight setup remain incomplete until the connection, source/resource, native route/capacity and later owner-start gates pass.

Entry points: [runbook](RUNBOOK.md), [machine readiness](ACTUAL-READINESS.json), [copy manifest](PREPARATION-MANIFEST.json), [notebook smoke](evidence/notebook-kit-smoke-2153/result.json), [tooling validation](evidence/tooling-validation-final.txt).

`make check-docs` failed on existing out-of-scope `docs/experiments/` report artifacts and a broken `campaign.py` link. Those files were already present at initial status and were preserved. No broad formatting, full product suite, build, model download or device campaign was run, because this lane changed only isolated preparation files and had no heavy-resource admission.
