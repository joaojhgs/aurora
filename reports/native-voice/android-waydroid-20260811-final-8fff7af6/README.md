# Final-source Waydroid and MobileMCP check

## Provenance

- Source commit: `8fff7af61dc19ca6c4d00b0b26bb86d7e4206808`
- APK SHA-256: `83256515b81e87f3fd28e9a5122c0d6a5dd20d7b7507591daff475bc6de0f24c`
- APK size: `341843160` bytes
- Package/activity: `dev.aurora.desktop/.MainActivity`
- Build target: x86_64 Android client, target/compile SDK 36, min SDK 24
- Device: WayDroid x86_64 Device, Android 13, `192.168.240.112:5555`, 768x1280 during capture
- Test date: 2026-08-11 UCT

The installed `base.apk` was pulled back from the device after MobileMCP installation. Its size and SHA-256 matched the clean-worktree artifact exactly.

## Accepted observations

1. Direct ADB cold-launched `dev.aurora.desktop/.MainActivity` successfully in 677 ms after MobileMCP installed the APK. MobileMCP's generic package launcher could not resolve the Tauri launcher, so the explicit activity was used only for launch.
2. MobileMCP displayed the runtime role picker from the same APK. Both `Make this device available` and `Connect to Aurora` were present; selecting `Connect to Aurora` immediately changed the persisted selection text to `Saved Connect to Aurora`.
3. MobileMCP continued the `Connect to Aurora` flow and exposed an accessibility tree containing:
   - `onboarding-title`
   - `webthin-profile-node-name`
   - `webthin-invite`
   - `Scan invite`
   - `Open invite file`
   - `Save invite and continue`
   - `Connect with an address`
4. MobileMCP opened the manual-address path and exposed `aurora-endpoint`, `Use this address`, and `Use invite instead`.
5. MobileMCP entered `http://192.168.240.1:8000` and selected `Use this address`. The app navigated to the Connected devices surface. Because no Gateway was listening, the shell truthfully showed `Offline`, connection checks, zero devices, and unavailable/read-only controls.
6. The rendered screens inspected here did not expose build-time role selection or the removed `VITE_AURORA_RUNTIME_MODE` concept. The one APK changed behavior through onboarding/profile state.

These observations prove the `Connect to Aurora` onboarding/navigation shape and that both dynamic role choices render in the final-source APK. They do not prove pairing, a live Gateway voice turn, background voice, physical-device behavior, or role persistence across a clean process restart.

## Unaccepted or blocked observations

- The process-restart persistence attempt is not accepted. During recovery, Waydroid's WebView sandbox processes repeatedly failed to attach and the activity rendered black. An ADB reboot then stopped the Waydroid container rather than restarting it.
- Host status after that reboot was `Session: RUNNING`, `Container: STOPPED`. Starting `waydroid-container.service` requires the host sudo/polkit credential, which was not supplied or bypassed.
- The `Make this device available` role picker state is captured, but its Continue/setup/navigation path remains incomplete until Waydroid is restarted.
- No Gateway was running on the host, so pairing and an actual assistant/voice turn were not attempted or claimed.
- The API 35 Google APIs QEMU AVD remains separately blocked because the `developer` user currently lacks `/dev/kvm` access.

## Screenshots

- `01-role-picker-make-device-available.png`: both dynamic roles, with the device-available choice selected.
- `02-role-picker-connect-to-aurora.png`: the same APK after selecting the remote-management role.
- `03-connect-invite-setup.png`: invite/file/manual-address choices.
- `04-connect-manual-address.png`: manual address controls.
- `05-connected-devices-offline.png`: post-save navigation with honest offline state.
- `06-waydroid-webview-restart-block.png`: black activity during the Waydroid WebView sandbox failure; retained as blocker evidence, not product evidence.
