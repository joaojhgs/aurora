import AVFAudio
import Foundation
import LocalAuthentication
import Security
import Tauri
import UIKit
import UserNotifications
import WebKit

@_cdecl("init_plugin_aurora_native")
public func initPluginAuroraNative() -> UnsafeMutableRawPointer {
  Unmanaged.passRetained(AuroraNativePlugin()).toOpaque()
}

struct AuroraInvocationRequest: Decodable {
  let action: String
  let correlationId: String?
}

struct AuroraAdminUnlockArgs: Decodable {
  let reason: String
  let action: String?
  let correlationId: String?
  let allowDeviceCredential: Bool?
}

struct AuroraShareTextArgs: Decodable {
  let text: String
  let title: String?
}

struct AuroraOpenDeepLinkArgs: Decodable {
  let url: String
}

struct AuroraShowNotificationArgs: Decodable {
  let title: String
  let body: String?
}

@objc(AuroraNativePlugin)
public final class AuroraNativePlugin: Plugin {
  // The current iOS bridge owns bounded capture/playback plumbing only. It
  // must not report a usable voice turn or open the microphone until the
  // native typed transport/session executor is linked into the app target.
  private static let nativeTurnTransportAvailable = false
  private static let maxSharedTextLength = 8192
  private static let maxTitleLength = 120
  private static let maxNotificationBodyLength = 512
  private static let maxUrlLength = 2048
  private static let pendingNativeTargetReason = "This iOS feature is unavailable until mobile app setup is complete."
  private static let allowedOutgoingLinkSchemes: Set<String> = [
    "https",
    "mailto",
    "tel",
    "aurora",
    "aurora-local"
  ]

  private let voiceCapture = AuroraIOSVoiceCapture()
  private var voiceSession: AuroraIOSVoiceSessionHost?
  private var voiceSessionGeneration: UInt64?

  private let mobileIntegrations: [[String: Any]] = [
    [
      "platform": "ios",
      "id": "askAuroraAppIntent",
      "publicActionId": "app-intent.open-assistant",
      "label": "Ask Aurora",
      "support": "supported-path",
      "capability": "ios.appIntents",
      "permission": "aurora.iosAppIntents",
      "invocation": "app-intent",
      "backendMethod": "Orchestrator.ExternalUserInput",
      "privacyClass": "personal",
      "requiresConfirmation": false,
      "siriReplacement": false,
      "evidenceSource": "IOS-003/IOS-004 native plugin manifest",
      "userCopy": "Runs as an app-owned Siri/Shortcuts/App Intents integration; system assistant ownership is unavailable.",
      "verifier": "tauri ios build plus simulator/device App Intent invocation on macOS/Xcode"
    ],
    [
      "platform": "ios",
      "id": "askAuroraShortcut",
      "publicActionId": "shortcut.open-assistant",
      "label": "Ask Aurora Shortcut",
      "support": "supported-path",
      "capability": "ios.shortcuts",
      "permission": "aurora.iosShortcuts",
      "invocation": "shortcut",
      "backendMethod": "Orchestrator.ExternalUserInput",
      "privacyClass": "personal",
      "requiresConfirmation": false,
      "siriReplacement": false,
      "evidenceSource": "IOS-003 native plugin manifest",
      "userCopy": "Shortcut actions open Aurora before assistant work runs.",
      "verifier": "simulator/device Shortcut invocation through the Xcode-managed iOS target"
    ],
    [
      "platform": "ios",
      "id": "summarizeSharedContentShortcut",
      "publicActionId": "share.import-context",
      "label": "Summarize shared content",
      "support": "supported-path",
      "capability": "ios.shortcuts",
      "permission": "aurora.iosShortcuts",
      "invocation": "shortcut",
      "backendMethod": "Orchestrator.IngestContext",
      "privacyClass": "sensitive",
      "requiresConfirmation": true,
      "siriReplacement": false,
      "evidenceSource": "IOS-003 native plugin manifest",
      "userCopy": "Shared content is sent only after you start the action.",
      "verifier": "simulator/device Shortcut or share handoff smoke with backend correlation evidence"
    ],
    [
      "platform": "ios",
      "id": "stopAuroraSpeechAppIntent",
      "publicActionId": "app-intent.stop-speech",
      "label": "Stop Aurora speech",
      "support": "supported-path",
      "capability": "ios.appIntents",
      "permission": "aurora.iosAppIntents",
      "invocation": "app-intent",
      "backendMethod": "TTS.Stop",
      "privacyClass": "personal",
      "requiresConfirmation": false,
      "siriReplacement": false,
      "evidenceSource": "IOS-003 native plugin manifest",
      "userCopy": "Controls Aurora-owned playback only; it cannot control Siri or system assistant audio.",
      "verifier": "simulator/device App Intent invocation with TTS stop route evidence"
    ],
    [
      "platform": "ios",
      "id": "siriReplacement",
      "label": "System assistant role",
      "support": "unsupported",
      "capability": "ios.siriReplacement",
      "permission": NSNull(),
      "privacyClass": "public",
      "requiresConfirmation": false,
      "siriReplacement": false,
      "evidenceSource": "Apple-platform-policy",
      "userCopy": "iOS does not allow third-party default assistant ownership.",
      "verifier": "copy and capability review; no executable route should be exposed"
    ],
    [
      "platform": "ios",
      "id": "shareExtension",
      "label": "iOS share extension intake",
      "support": "pending",
      "capability": "ios.shareExtension",
      "permission": "aurora.ios.shareExtension",
      "invocation": "share_extension",
      "backendMethod": "Orchestrator.IngestContext",
      "privacyClass": "sensitive",
      "requiresConfirmation": true,
      "siriReplacement": false,
      "evidenceSource": "src-tauri/ios/preflight.json:share-extension-flow",
      "reason": AuroraNativePlugin.pendingNativeTargetReason,
      "userCopy": "Share extension intake will stay unavailable until Aurora verifies the iOS app target.",
      "verifier": "tauri ios build plus compiled IOS-004 entrypoint payload smoke"
    ],
    [
      "platform": "ios",
      "id": "deepLinks",
      "publicActionId": "deeplink.open",
      "label": "iOS deep links",
      "support": "supported-path",
      "capability": "ios.deepLinks",
      "permission": "aurora.ios.deepLinks",
      "invocation": "deep_link",
      "backendMethod": "Orchestrator.IngestContext",
      "privacyClass": "personal",
      "requiresConfirmation": false,
      "siriReplacement": false,
      "evidenceSource": "IOS-004 native plugin manifest",
      "userCopy": "aurora:// links open Aurora flows and keep the session handoff inside the app.",
      "verifier": "tauri ios build plus compiled IOS-004 entrypoint payload smoke"
    ],
    [
      "platform": "ios",
      "id": "widgets",
      "label": "iOS widgets",
      "support": "pending",
      "capability": "ios.widgets",
      "permission": "aurora.ios.widgets",
      "invocation": "widget",
      "backendMethod": "AuroraClient.OpenEntrypoint",
      "privacyClass": "personal",
      "requiresConfirmation": false,
      "siriReplacement": false,
      "evidenceSource": "src-tauri/ios/preflight.json:simulator-plugin-app-intent",
      "reason": AuroraNativePlugin.pendingNativeTargetReason,
      "userCopy": "Widget actions will stay unavailable until Aurora verifies the iOS widget target.",
      "verifier": "tauri ios build plus compiled IOS-004 entrypoint payload smoke"
    ],
    [
      "platform": "ios",
      "id": "fileAssociations",
      "label": "iOS file associations",
      "support": "pending",
      "capability": "ios.fileAssociations",
      "permission": "aurora.ios.fileAssociations",
      "invocation": "file_association",
      "backendMethod": "Orchestrator.IngestContext",
      "privacyClass": "sensitive",
      "requiresConfirmation": true,
      "siriReplacement": false,
      "evidenceSource": "src-tauri/ios/preflight.json:share-extension-flow",
      "reason": AuroraNativePlugin.pendingNativeTargetReason,
      "userCopy": "File-open intake will stay unavailable until Aurora verifies iOS file association handling.",
      "verifier": "tauri ios build plus Tauri mobile file-association config and compiled IOS-004 payload smoke"
    ],
    [
      "platform": "ios",
      "id": "iosLocalLightInference",
      "label": "On-device model features",
      "support": "supported-path",
      "capability": "ios.localLightInference.provider",
      "permission": "aurora.iosLocalLightInference",
      "invocation": "tauri-command",
      "backendMethod": "Orchestrator.GetModelRuntimeCatalog",
      "privacyClass": "personal",
      "requiresConfirmation": false,
      "siriReplacement": false,
      "evidenceSource": "ios-native-local-light-adapter",
      "userCopy": "On-device model features stay unavailable until Aurora confirms the device and model are ready.",
      "verifier": "tauri ios build plus simulator/device nativeCapabilityManifest payload smoke"
    ],
    [
      "platform": "ios",
      "id": "iosShareText",
      "label": "iOS share text",
      "support": "supported-path",
      "capability": "ios.shareText",
      "permission": "aurora.ios.shareText",
      "invocation": "tauri-command",
      "backendMethod": "Native.ShareText",
      "privacyClass": "sensitive",
      "requiresConfirmation": true,
      "siriReplacement": false,
      "evidenceSource": "ios-native-outgoing-actions",
      "userCopy": "Shares bounded text through the system share sheet after Aurora approval.",
      "verifier": "tauri ios build plus simulator/device shareText smoke"
    ],
    [
      "platform": "ios",
      "id": "iosOpenDeepLink",
      "label": "iOS open link",
      "support": "supported-path",
      "capability": "ios.openDeepLink",
      "permission": "aurora.ios.openDeepLink",
      "invocation": "tauri-command",
      "backendMethod": "Native.OpenDeepLink",
      "privacyClass": "sensitive",
      "requiresConfirmation": true,
      "siriReplacement": false,
      "evidenceSource": "ios-native-outgoing-actions",
      "userCopy": "Opens only approved link types after Aurora approval.",
      "verifier": "tauri ios build plus simulator/device openDeepLink smoke"
    ],
    [
      "platform": "ios",
      "id": "iosShowNotification",
      "label": "iOS notification",
      "support": "supported-path",
      "capability": "ios.showNotification",
      "permission": "aurora.ios.showNotification",
      "invocation": "tauri-command",
      "backendMethod": "Native.ShowNotification",
      "privacyClass": "sensitive",
      "requiresConfirmation": true,
      "siriReplacement": false,
      "evidenceSource": "ios-native-outgoing-actions",
      "userCopy": "Posts a local notification only when notifications were already allowed.",
      "verifier": "tauri ios build plus simulator/device showNotification smoke"
    ]
  ]

  @objc public func nativeCapabilityManifest(_ invoke: Invoke) throws {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let notificationReady = AuroraNativePlugin.notificationsAlreadyAuthorized(
        settings.authorizationStatus
      )
      let notificationState = notificationReady ? "available" : "needs_native_permission"
      invoke.resolve([
      "platform": "ios",
      "permissions": [
        "aurora.iosAppIntents": true,
        "aurora.iosShortcuts": true,
        "aurora.ios.shareExtension": false,
        "aurora.ios.deepLinks": true,
        "aurora.ios.widgets": false,
        "aurora.ios.fileAssociations": false,
        "aurora.ios.entrypointPayload": true,
        "aurora.iosLocalLightInference": false,
        "aurora.ios.shareText": true,
        "aurora.ios.openDeepLink": true,
        "aurora.ios.showNotification": notificationReady,
        "aurora.nativeCapabilityManifest": true,
        "native.permissionsManifest": true,
        "native.deviceStatus": true,
        "aurora.iosKeychain": true,
        "aurora.inboundVerifierStorage": true,
        "aurora.iosThinPeerProof": true,
        "aurora.iosThinProfile": true,
        "aurora.iosBiometricUnlock": true,
        "aurora.iosVoiceStatus": true,
        "aurora.iosBackgroundStatus": true,
        "aurora.iosMicrophoneCapture": false,
        "aurora.iosBackgroundAudio": false,
        "aurora.iosSiriReplacement": false,
        "aurora.audioCapture": false,
        "aurora.audioPlayback": false
      ],
      "capabilities": [
        "ios.appIntents": true,
        "ios.shortcuts": true,
        "ios.shareExtension": false,
        "ios.deepLinks": true,
        "ios.widgets": false,
        "ios.fileAssociations": false,
        "ios.entrypointPayload": true,
        "ios.localLightInference.provider": true,
        "ios.localLightInference.modelRuntime": false,
        "ios.localLightInference.fallback": true,
        "ios.shareText": true,
        "ios.openDeepLink": true,
        "ios.showNotification": notificationReady,
        "native.permissionsManifest": true,
        "native.deviceStatus": true,
        "ios.keychain.secureCredentialStorage": true,
        "native.inboundVerifierStorage": true,
        "ios.thinPeerProof": true,
        "ios.thinProfile": true,
        "ios.biometric.adminUnlock": true,
        "ios.voiceForegroundCapture": false,
        "ios.notifications": notificationReady,
        "ios.backgroundVoice": false,
        "ios.appOwnedInvocation": true,
        "ios.siriReplacement": false,
        "native.audioCapture": false,
        "native.audioPlayback": false
      ],
      "permissionStates": [
        "aurora.iosAppIntents": "available",
        "aurora.iosShortcuts": "available",
        "aurora.ios.shareExtension": "pending_native_target",
        "aurora.ios.deepLinks": "available",
        "aurora.ios.widgets": "pending_native_target",
        "aurora.ios.fileAssociations": "pending_native_target",
        "aurora.ios.entrypointPayload": "available",
        "aurora.iosLocalLightInference": "degraded",
        "aurora.ios.shareText": "available",
        "aurora.ios.openDeepLink": "available",
        "aurora.ios.showNotification": notificationState,
        "aurora.nativeCapabilityManifest": "available",
        "native.permissionsManifest": "available",
        "native.deviceStatus": "available",
        "aurora.iosKeychain": "available",
        "aurora.inboundVerifierStorage": "available",
        "aurora.iosThinPeerProof": "available",
        "aurora.iosThinProfile": "available",
        "aurora.iosBiometricUnlock": "available",
        "aurora.iosMicrophoneCapture": "needs_native_permission",
        "aurora.iosBackgroundAudio": "unsupported_platform",
        "aurora.iosSiriReplacement": "unsupported_platform"
      ],
      "capabilityStates": [
        "ios.appIntents": "available",
        "ios.shortcuts": "available",
        "ios.shareExtension": "pending_native_target",
        "ios.deepLinks": "available",
        "ios.widgets": "pending_native_target",
        "ios.fileAssociations": "pending_native_target",
        "ios.entrypointPayload": "available",
        "ios.localLightInference.provider": "degraded",
        "ios.localLightInference.modelRuntime": "needs_native_permission",
        "ios.localLightInference.fallback": "fallback",
        "ios.shareText": "available",
        "ios.openDeepLink": "available",
        "ios.showNotification": notificationState,
        "native.permissionsManifest": "available",
        "native.deviceStatus": "available",
        "ios.keychain.secureCredentialStorage": "available",
        "native.inboundVerifierStorage": "available",
        "ios.thinPeerProof": "available",
        "ios.thinProfile": "available",
        "ios.biometric.adminUnlock": "available",
        "ios.voiceForegroundCapture": "needs_native_permission",
        "ios.notifications": notificationState,
        "ios.backgroundVoice": "unsupported_platform",
        "ios.appOwnedInvocation": "available",
        "ios.siriReplacement": "unsupported_platform"
      ],
      "mobileIntegrations": self.mobileIntegrations,
      "iosInvocation": [
        "platform": "ios",
        "appIntentsAvailable": true,
        "shortcutsAvailable": true,
        "shareExtensionAvailable": false,
        "deepLinksAvailable": true,
        "widgetsAvailable": false,
        "fileAssociationsAvailable": false,
        "siriReplacement": false,
        "backendHandoffRequired": true,
        "privacyLabels": ["personal", "sensitive"],
        "state": "degraded",
        "reason": "Deep links can open Aurora now. Share, widget, and file-open options stay unavailable until mobile app setup is complete.",
        "evidenceSource": "src-tauri/ios/preflight.json",
        "secretsRedacted": true
      ],
      "localLightInference": AuroraNativePlugin.localLightInferenceStatusPayload(),
      "entrypoints": AuroraNativePlugin.entrypoints(),
      "lastEntrypointPayload": AuroraNativePlugin.payloadDictionary(AuroraEntrypointFactory.emptyPayload()),
      "platformLimitations": [
        [
          "platform": "ios",
          "id": "noSiriReplacement",
          "label": "No system assistant role",
          "reason": "Apple permits app-owned App Intents, Shortcuts, widgets, share extensions, and deep links, not third-party default assistant ownership.",
          "userCopy": "Use Siri/Shortcuts/App Intents integration; do not claim default iOS assistant ownership.",
          "evidenceSource": "Apple App Intents and SiriKit extension documentation"
        ],
        [
          "platform": "ios",
          "id": "foregroundConsentRequired",
          "label": "Foreground consent required",
          "reason": "Always-on background assistant capture is unavailable on iOS without explicit app-owned foreground consent.",
          "userCopy": "Audio and shared-content actions start only from an Aurora-owned user action.",
          "evidenceSource": "Apple App Intents, extensions, and privacy review requirements"
        ]
      ],
      "evidenceSource": "IOS-003 native plugin manifest",
      "secretsRedacted": true
      ])
    }
  }

  @objc public func invocationStatus(_ invoke: Invoke) throws {
    let executableActions = mobileIntegrations
      .filter { ($0["support"] as? String) == "supported-path" }
      .map { $0["publicActionId"] as? String ?? "" }
      .filter { !$0.isEmpty }
    let hasPendingNativeTargets = mobileIntegrations.contains {
      ($0["support"] as? String) == "pending"
    }
    let invocationState = hasPendingNativeTargets ? "degraded" : "available"
    let reason: Any = hasPendingNativeTargets
      ? "Some iOS options are unavailable until mobile app setup is complete."
      : NSNull()
    invoke.resolve([
      "available": true,
      "state": invocationState,
      "surface": "Siri/Shortcuts/App Intents integration",
      "supportedActions": executableActions,
      "mobileIntegrations": mobileIntegrations,
      "siriReplacement": false,
      "requiresBackendEvidence": true,
      "reason": reason,
      "entrypoints": AuroraNativePlugin.entrypoints(),
      "secretsRedacted": true
    ])
  }

  @objc public func localLightInferenceStatus(_ invoke: Invoke) throws {
    invoke.resolve(AuroraNativePlugin.localLightInferenceStatusPayload())
  }

  @objc public func voiceStatus(_ invoke: Invoke) throws {
    let permission = AVAudioSession.sharedInstance().recordPermission
    let capture = voiceSession?.captureStats() ?? voiceCapture.stats()
    let reason: Any = !AuroraNativePlugin.nativeTurnTransportAvailable
      ? "iOS native voice transport is not available on this build."
      : permission == .granted
        ? NSNull()
        : "iOS microphone capture requires foreground microphone permission, audio consent, and a visible stop control."
    invoke.resolve([
      "available": AuroraNativePlugin.nativeTurnTransportAvailable && permission == .granted,
      "permission": "aurora.iosMicrophoneCapture",
      "capability": "ios.voiceForegroundCapture",
      "source": "tauri-ios-native-plugin",
      "reason": reason,
      "details": [
        "platform": "ios",
        "recordPermission": AuroraNativePlugin.recordPermissionLabel(permission),
        "privacyClass": "raw-audio",
        "foregroundOnly": true,
        "supportsBackgroundListening": false,
        "nativeTurnTransportAvailable": AuroraNativePlugin.nativeTurnTransportAvailable,
        "supportsSiriReplacement": false,
        "consentRequired": true,
        "stopRevokeRequired": true,
        "captureRunning": capture.running,
        "queuedChunks": capture.queuedChunks,
        "acceptedChunks": capture.acceptedChunks,
        "droppedChunks": capture.droppedChunks,
        "discontinuities": capture.discontinuities,
        "secretsRedacted": true
      ]
    ])
  }

  @objc public func voiceForegroundCaptureStart(_ invoke: Invoke) {
    startVoiceCapture(invoke, background: false)
  }

  /// Starts a user-initiated background audio session. The command remains
  /// behind the separate background permission and the native transport gate;
  /// it must never be treated as an always-on or silently restarting path.
  @objc public func voiceBackgroundCaptureStart(_ invoke: Invoke) {
    startVoiceCapture(invoke, background: true)
  }

  private func startVoiceCapture(_ invoke: Invoke, background: Bool) {
    guard AuroraNativePlugin.nativeTurnTransportAvailable else {
      invoke.reject("native_voice_transport_unavailable")
      return
    }
    let startCapture: () -> Void = { [weak self] in
      guard let self else {
        invoke.reject("capture_unavailable")
        return
      }
      do {
        if let existing = self.voiceSession, existing.status()?.active == false {
          self.voiceSession = nil
          self.voiceSessionGeneration = nil
        }
        if self.voiceSession == nil {
          self.voiceSession = try AuroraIOSVoiceSessionHost(
            storedConfiguration: AVAudioSession.sharedInstance()
          )
        }
        if background {
          self.voiceSessionGeneration = try self.voiceSession?.startBackground()
        } else {
          self.voiceSessionGeneration = try self.voiceSession?.start()
        }
        let stats = self.voiceSession?.captureStats() ?? self.voiceCapture.stats()
        invoke.resolve(AuroraNativePlugin.voiceCapturePayload(stats))
      } catch {
        invoke.reject("capture_unavailable")
      }
    }
    switch AVAudioSession.sharedInstance().recordPermission {
    case .granted:
      startCapture()
    case .undetermined:
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        DispatchQueue.main.async {
          guard granted else {
            invoke.reject("microphone_permission_denied")
            return
          }
          startCapture()
        }
      }
    case .denied:
      invoke.reject("microphone_permission_denied")
    @unknown default:
      invoke.reject("microphone_permission_unavailable")
    }
  }

  @objc public func voiceForegroundCaptureStop(_ invoke: Invoke) {
    if let generation = voiceSessionGeneration {
      try? voiceSession?.cancel(generation: generation)
      voiceSessionGeneration = nil
    }
    voiceSession = nil
    voiceCapture.stop()
    invoke.resolve(AuroraNativePlugin.voiceCapturePayload(voiceCapture.stats()))
  }

  @objc public func voiceForegroundCaptureFinish(_ invoke: Invoke) {
    guard let session = voiceSession, let generation = voiceSessionGeneration else {
      invoke.reject("capture_not_active")
      return
    }
    do {
      try session.finish(generation: generation)
      let stats = session.captureStats() ?? voiceCapture.stats()
      invoke.resolve(AuroraNativePlugin.voiceCapturePayload(stats))
    } catch {
      invoke.reject("capture_finish_failed")
    }
  }

  @objc public func voiceForegroundCaptureStatus(_ invoke: Invoke) {
    let stats = voiceSession?.captureStats() ?? voiceCapture.stats()
    invoke.resolve(AuroraNativePlugin.voiceCapturePayload(stats))
  }

  @objc public func notificationStatus(_ invoke: Invoke) throws {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let available = AuroraNativePlugin.notificationsAlreadyAuthorized(settings.authorizationStatus)
      let reason: Any = available
        ? NSNull()
        : "iOS notifications require explicit user authorization and cannot provide always-on assistant wake."
      invoke.resolve([
        "available": available,
        "permission": "aurora.notificationsSend",
        "capability": "ios.notifications",
        "source": "tauri-ios-native-plugin",
        "reason": reason,
        "details": [
          "platform": "ios",
          "authorizationStatus": AuroraNativePlugin.notificationAuthorizationLabel(settings.authorizationStatus),
          "supportsSiriReplacement": false,
          "backgroundAssistantWake": false,
          "secretsRedacted": true
        ]
      ])
    }
  }

  @objc public func shareText(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraShareTextArgs.self)
      let text = try AuroraNativePlugin.boundedRequiredString(
        args.text,
        maxLength: AuroraNativePlugin.maxSharedTextLength,
        field: "text"
      )
      let title = try AuroraNativePlugin.boundedOptionalString(
        args.title,
        maxLength: AuroraNativePlugin.maxTitleLength,
        field: "title"
      )
      DispatchQueue.main.async {
        guard let presenter = AuroraNativePlugin.topViewController() else {
          invoke.reject("capability_unavailable")
          return
        }
        var activityItems: [Any] = [text]
        if let title {
          activityItems.insert(title, at: 0)
        }
        let activityController = UIActivityViewController(
          activityItems: activityItems,
          applicationActivities: nil
        )
        activityController.completionWithItemsHandler = { _, completed, _, error in
          if error != nil {
            invoke.reject("capability_unavailable")
            return
          }
          guard completed else {
            invoke.reject("user_cancelled")
            return
          }
          invoke.resolve(["shared": true])
        }
        if let popover = activityController.popoverPresentationController {
          popover.sourceView = presenter.view
          popover.sourceRect = CGRect(
            x: presenter.view.bounds.midX,
            y: presenter.view.bounds.midY,
            width: 1,
            height: 1
          )
          popover.permittedArrowDirections = []
        }
        presenter.present(activityController, animated: true)
      }
    } catch {
      invoke.reject("invalid_arguments")
    }
  }

  @objc public func openDeepLink(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraOpenDeepLinkArgs.self)
      let url = try AuroraNativePlugin.safeOutgoingUrl(args.url)
      DispatchQueue.main.async {
        UIApplication.shared.open(url, options: [:]) { opened in
          if opened {
            invoke.resolve(["opened": true])
          } else {
            invoke.reject("capability_unavailable")
          }
        }
      }
    } catch {
      invoke.reject("permission_denied")
    }
  }

  @objc public func showNotification(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraShowNotificationArgs.self)
      let title = try AuroraNativePlugin.boundedRequiredString(
        args.title,
        maxLength: AuroraNativePlugin.maxTitleLength,
        field: "title"
      )
      let body = try AuroraNativePlugin.boundedOptionalString(
        args.body,
        maxLength: AuroraNativePlugin.maxNotificationBodyLength,
        field: "body"
      )
      UNUserNotificationCenter.current().getNotificationSettings { settings in
        guard AuroraNativePlugin.notificationsAlreadyAuthorized(settings.authorizationStatus) else {
          invoke.reject("permission_unavailable")
          return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        if let body {
          content.body = body
        }
        let request = UNNotificationRequest(
          identifier: "aurora.local-notification.\(UUID().uuidString)",
          content: content,
          trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
          if error != nil {
            invoke.reject("capability_unavailable")
            return
          }
          invoke.resolve(["shown": true])
        }
      }
    } catch {
      invoke.reject("invalid_arguments")
    }
  }

  @objc public func backgroundStatus(_ invoke: Invoke) throws {
    invoke.resolve([
      "available": false,
      "permission": "aurora.iosBackgroundAudio",
      "capability": "ios.backgroundVoice",
      "source": "tauri-ios-native-plugin",
      "reason": "iOS does not allow Aurora to run always-on background assistant listening or claim default assistant ownership; use app-owned foreground, notification, Shortcut, App Intent, widget, share, or deep-link entrypoints.",
      "details": [
        "platform": "ios",
        "alwaysOnWake": false,
        "supportsSiriReplacement": false,
        "allowedFallbackSurfaces": [
          "foreground microphone permission",
          "user notifications",
          "App Intents",
          "Shortcuts",
          "widgets",
          "share sheet",
          "deep links"
        ],
        "secretsRedacted": true
      ]
    ])
  }

  @objc public func iosSecureStorageStatus(_ invoke: Invoke) throws {
    invoke.resolve([
      "available": true,
      "permission": "aurora.iosKeychain",
      "capability": "ios.keychain.secureCredentialStorage",
      "source": "tauri-ios-native-plugin",
      "details": [
        "backend": "keychain",
        "persisted": true,
        "privacyClass": "credential",
        "secretsRedacted": true,
        "namespaces": [
          "aurora.session",
          "aurora.auth",
          "aurora.gateway",
          "aurora.voice",
          "aurora.mesh",
          "aurora.admin"
        ]
      ]
    ])
  }

  @objc public func voiceCredentialSet(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraIOSVoiceCredentialSetArgs.self)
      invoke.resolve(try AuroraIOSVoiceCredentialStore.set(args))
    } catch let error as AuroraIOSVoiceCredentialStoreError {
      switch error {
      case .invalidGateway:
        invoke.reject("voice_credential_invalid_gateway")
      case .invalidBearer:
        invoke.reject("voice_credential_invalid_bearer")
      case .corruptRecord:
        invoke.reject("voice_credential_corrupt")
      case .keychainFailure:
        invoke.reject("voice_credential_storage_failed")
      }
    } catch {
      invoke.reject("voice_credential_set_failed")
    }
  }

  @objc public func voiceCredentialStatus(_ invoke: Invoke) {
    do {
      invoke.resolve(try AuroraIOSVoiceCredentialStore.status())
    } catch {
      invoke.reject("voice_credential_status_unavailable")
    }
  }

  @objc public func voiceCredentialDelete(_ invoke: Invoke) {
    do {
      invoke.resolve(try AuroraIOSVoiceCredentialStore.delete())
    } catch {
      invoke.reject("voice_credential_delete_failed")
    }
  }

  @objc public func thinPeerCredentialSet(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraThinPeerCredentialSetArgs.self)
      invoke.resolve(try AuroraThinPeerStorage.setCredential(args))
    } catch {
      invoke.reject(
        AuroraThinStorageError.redactedCode(
          for: error,
          fallback: "thin_peer_credential_set_failed"
        )
      )
    }
  }

  @objc public func localDataEnvelopeEncrypt(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraLocalDataEnvelopeEncryptArgs.self)
      invoke.resolve(try AuroraThinPeerStorage.localDataEnvelopeEncrypt(args))
    } catch {
      invoke.reject("local_data_envelope_encrypt_failed")
    }
  }

  @objc public func localDataEnvelopeDecrypt(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraLocalDataEnvelopeDecryptArgs.self)
      invoke.resolve(try AuroraThinPeerStorage.localDataEnvelopeDecrypt(args))
    } catch {
      invoke.reject("local_data_envelope_decrypt_failed")
    }
  }

  @objc public func localDataEnvelopeRotate(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraLocalDataEnvelopeRotateArgs.self)
      invoke.resolve(try AuroraThinPeerStorage.localDataEnvelopeRotate(args))
    } catch {
      invoke.reject("local_data_envelope_rotate_failed")
    }
  }

  @objc public func thinPeerCredentialStatus(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraThinPeerCredentialLookupArgs.self)
      invoke.resolve(try AuroraThinPeerStorage.credentialStatus(peerId: args.peerId))
    } catch {
      invoke.reject(
        AuroraThinStorageError.redactedCode(
          for: error,
          fallback: "thin_peer_credential_status_failed"
        )
      )
    }
  }

  @objc public func thinPeerCredentialDelete(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraThinPeerCredentialLookupArgs.self)
      invoke.resolve(try AuroraThinPeerStorage.deleteCredential(peerId: args.peerId))
    } catch {
      invoke.reject(
        AuroraThinStorageError.redactedCode(
          for: error,
          fallback: "thin_peer_credential_delete_failed"
        )
      )
    }
  }

  @objc public func thinPeerReconnectProve(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraThinPeerReconnectProveArgs.self)
      invoke.resolve(
        try AuroraThinPeerStorage.reconnectProof(
          peerId: args.peerId,
          challenge: args.challenge
        )
      )
    } catch {
      invoke.reject(
        AuroraThinStorageError.redactedCode(
          for: error,
          fallback: "thin_peer_reconnect_prove_failed"
        )
      )
    }
  }

  @objc public func thinProfileGet(_ invoke: Invoke) {
    invoke.resolve(AuroraThinPeerStorage.thinProfileGet())
  }

  @objc public func thinProfileSet(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraThinProfileSetArgs.self)
      invoke.resolve(try AuroraThinPeerStorage.thinProfileSet(value: args.value))
    } catch {
      invoke.reject(
        AuroraThinStorageError.redactedCode(
          for: error,
          fallback: "thin_profile_set_failed"
        )
      )
    }
  }

  @objc public func thinRoomSecretSet(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraThinRoomSecretSetArgs.self)
      invoke.resolve(try AuroraThinPeerStorage.thinRoomSecretSet(args))
    } catch {
      invoke.reject(
        AuroraThinStorageError.redactedCode(
          for: error,
          fallback: "thin_room_secret_set_failed"
        )
      )
    }
  }

  @objc public func thinRoomSecretGet(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraThinRoomSecretGetArgs.self)
      invoke.resolve(try AuroraThinPeerStorage.thinRoomSecretGet(args))
    } catch {
      invoke.reject(
        AuroraThinStorageError.redactedCode(
          for: error,
          fallback: "thin_room_secret_get_failed"
        )
      )
    }
  }

  @objc public func inboundVerifierGet(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraInboundVerifierGetArgs.self)
      invoke.resolve(try AuroraThinPeerStorage.inboundVerifierGet(args.request))
    } catch {
      invoke.reject(
        AuroraThinStorageError.redactedCode(
          for: error,
          fallback: "inbound_verifier_get_failed"
        )
      )
    }
  }

  @objc public func inboundVerifierSet(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraInboundVerifierSetArgs.self)
      invoke.resolve(try AuroraThinPeerStorage.inboundVerifierSet(args.request))
    } catch {
      invoke.reject(
        AuroraThinStorageError.redactedCode(
          for: error,
          fallback: "inbound_verifier_set_failed"
        )
      )
    }
  }

  @objc public func inboundVerifierDelete(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(AuroraInboundVerifierDeleteArgs.self)
      invoke.resolve(try AuroraThinPeerStorage.inboundVerifierDelete(args.request))
    } catch {
      invoke.reject(
        AuroraThinStorageError.redactedCode(
          for: error,
          fallback: "inbound_verifier_delete_failed"
        )
      )
    }
  }

  @objc public func iosBiometricStatus(_ invoke: Invoke) throws {
    let context = LAContext()
    var error: NSError?
    let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    let reason: Any = available ? NSNull() : (error?.localizedDescription ?? "Face ID/Touch ID is not available.")
    invoke.resolve([
      "available": available,
      "permission": "aurora.iosBiometricUnlock",
      "capability": "ios.biometric.adminUnlock",
      "source": "tauri-ios-native-plugin",
      "reason": reason,
      "details": [
        "framework": "LocalAuthentication",
        "biometry": AuroraNativePlugin.biometryLabel(context.biometryType),
        "usageDescriptionRequired": "NSFaceIDUsageDescription",
        "privacyClass": "credential",
        "secretsRedacted": true,
        "confirmationOnly": true
      ]
    ])
  }

  @objc public func iosAdminUnlock(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(AuroraAdminUnlockArgs.self)
    let context = LAContext()
    context.localizedCancelTitle = "Cancel"
    let policy: LAPolicy = args.allowDeviceCredential == true
      ? .deviceOwnerAuthentication
      : .deviceOwnerAuthenticationWithBiometrics
    var error: NSError?
    guard context.canEvaluatePolicy(policy, error: &error) else {
      invoke.reject(error?.localizedDescription ?? "Face ID/Touch ID is not available.")
      return
    }

    context.evaluatePolicy(policy, localizedReason: args.reason) { success, authError in
      if success {
        let action = AuroraNativePlugin.nullableString(args.action)
        let correlationId = AuroraNativePlugin.nullableString(args.correlationId)
        invoke.resolve([
          "available": true,
          "permission": "aurora.iosBiometricUnlock",
          "capability": "ios.biometric.adminUnlock",
          "source": "tauri-ios-native-plugin",
          "details": [
            "action": action,
            "correlationId": correlationId,
            "adminActionBackendRequired": true,
            "confirmationOnly": true,
            "secretsRedacted": true
          ]
        ])
      } else {
        invoke.reject(authError?.localizedDescription ?? "Biometric admin unlock failed.")
      }
    }
  }

  @objc public func iosEntrypointPayload(_ invoke: Invoke) throws {
    invoke.resolve([
      "payload": AuroraNativePlugin.payloadDictionary(AuroraEntrypointFactory.emptyPayload()),
      "entrypoints": AuroraNativePlugin.entrypoints(),
      "evidenceSource": "IOS-004 native plugin manifest",
      "secretsRedacted": true
    ])
  }

  @objc public func invokeAuroraAction(_ invoke: Invoke) throws {
    let request = try invoke.parseArgs(AuroraInvocationRequest.self)
    guard let action = mobileIntegrations.first(where: {
      ($0["publicActionId"] as? String) == request.action && ($0["support"] as? String) == "supported-path"
    }) else {
      invoke.resolve([
        "accepted": false,
        "action": request.action,
        "reason": "unsupported_action",
        "siriReplacement": false,
        "secretsRedacted": true
      ])
      return
    }

    var result: [String: Any] = [
      "accepted": true,
      "action": request.action,
      "handoff": "AuroraClient",
      "backendMethod": action["backendMethod"] ?? NSNull(),
      "invocation": action["invocation"] ?? NSNull(),
      "privacyClass": action["privacyClass"] ?? "personal",
      "requiresConfirmation": action["requiresConfirmation"] ?? false,
      "siriReplacement": false,
      "requiresBackendEvidence": true,
      "secretsRedacted": true
    ]
    if let correlationId = request.correlationId {
      result["correlationId"] = correlationId
    }
    invoke.resolve(result)
  }

  private static func entrypoints() -> [[String: Any]] {
    AuroraEntrypointFactory.descriptors().map { descriptor in
      [
        "id": descriptor.id,
        "platform": descriptor.platform,
        "label": descriptor.label,
        "state": descriptor.state,
        "available": descriptor.available,
        "capability": descriptor.capability,
        "permission": AuroraNativePlugin.nullableString(descriptor.permission),
        "intakeType": descriptor.intakeType,
        "urlScheme": AuroraNativePlugin.nullableString(descriptor.urlScheme),
        "universalLinkHost": AuroraNativePlugin.nullableString(descriptor.universalLinkHost),
        "fileExtensions": descriptor.fileExtensions,
        "xcodeTarget": descriptor.xcodeTarget,
        "backendRequired": descriptor.backendRequired,
        "payloadCommand": descriptor.payloadCommand,
        "privacyClass": descriptor.privacyClass,
        "reason": descriptor.reason
      ]
    }
  }

  private static func payloadDictionary(_ payload: AuroraEntrypointPayload) -> [String: Any] {
    [
      "source": payload.source,
      "invocation": payload.invocation,
      "url": AuroraNativePlugin.nullableString(payload.url),
      "scheme": AuroraNativePlugin.nullableString(payload.scheme),
      "host": AuroraNativePlugin.nullableString(payload.host),
      "path": AuroraNativePlugin.nullableString(payload.path),
      "fileExtension": AuroraNativePlugin.nullableString(payload.fileExtension),
      "uniformTypeIdentifier": AuroraNativePlugin.nullableString(payload.uniformTypeIdentifier),
      "originatingBundleId": AuroraNativePlugin.nullableString(payload.originatingBundleId),
      "sharedItemCount": payload.sharedItemCount,
      "privacyLabels": payload.privacyLabels,
      "backendHandoffRequired": payload.backendHandoffRequired,
      "correlationId": AuroraNativePlugin.nullableString(payload.correlationId),
      "secretsRedacted": payload.secretsRedacted,
      "siriReplacement": payload.siriReplacement
    ]
  }

  private static func localLightInferenceStatusPayload() -> [String: Any] {
    [
      "platform": "ios",
      "providerId": "native:mobile-local-light",
      "available": false,
      "requestable": false,
      "modelRuntimeProvider": false,
      "backendModelCatalogRequired": true,
      "hardwareAcceleration": "unknown",
      "modelId": NSNull(),
      "modelPresent": false,
      "permissionGranted": false,
      "state": "degraded",
      "fallbackAvailable": true,
      "fallbackProviderId": "local:Orchestrator:llama-cpp",
      "reason": "backend_model_catalog_and_device_model_proof_required",
      "evidenceSource": "ios-native-local-light-adapter",
      "secretsRedacted": true
    ]
  }

  private static func voiceCapturePayload(_ stats: AuroraIOSVoiceCaptureStats) -> [String: Any] {
    [
      "available": true,
      "foregroundOnly": true,
      "running": stats.running,
      "queuedChunks": stats.queuedChunks,
      "acceptedChunks": stats.acceptedChunks,
      "droppedChunks": stats.droppedChunks,
      "discontinuities": stats.discontinuities,
      "rawAudioLogged": false,
      "backgroundListening": false,
      "siriReplacement": false,
      "secretsRedacted": true
    ]
  }

  private static func biometryLabel(_ type: LABiometryType) -> String {
    switch type {
    case .faceID:
      return "Face ID"
    case .touchID:
      return "Touch ID"
    default:
      return "none"
    }
  }

  private static func nullableString(_ value: String?) -> Any {
    guard let value else {
      return NSNull()
    }
    return value
  }

  private static func boundedRequiredString(
    _ value: String,
    maxLength: Int,
    field: String
  ) throws -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty && trimmed.count <= maxLength else {
      throw NSError(domain: "AuroraNativePlugin", code: 1, userInfo: ["field": field])
    }
    return trimmed
  }

  private static func boundedOptionalString(
    _ value: String?,
    maxLength: Int,
    field: String
  ) throws -> String? {
    guard let value else {
      return nil
    }
    return try boundedRequiredString(value, maxLength: maxLength, field: field)
  }

  private static func safeOutgoingUrl(_ value: String) throws -> URL {
    let text = try boundedRequiredString(value, maxLength: maxUrlLength, field: "url")
    guard let components = URLComponents(string: text),
      let scheme = components.scheme?.lowercased(),
      allowedOutgoingLinkSchemes.contains(scheme),
      let url = components.url
    else {
      throw NSError(domain: "AuroraNativePlugin", code: 2, userInfo: ["field": "url"])
    }
    if scheme == "https", components.host?.isEmpty != false {
      throw NSError(domain: "AuroraNativePlugin", code: 3, userInfo: ["field": "url"])
    }
    if (scheme == "mailto" || scheme == "tel"), components.path.isEmpty {
      throw NSError(domain: "AuroraNativePlugin", code: 4, userInfo: ["field": "url"])
    }
    return url
  }

  private static func notificationsAlreadyAuthorized(_ status: UNAuthorizationStatus) -> Bool {
    switch status {
    case .authorized, .provisional, .ephemeral:
      return true
    default:
      return false
    }
  }

  private static func topViewController() -> UIViewController? {
    let root: UIViewController?
    if #available(iOS 15.0, *) {
      root = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap { $0.windows }
        .first { $0.isKeyWindow }?
        .rootViewController
    } else {
      root = UIApplication.shared.windows
        .first { $0.isKeyWindow }?
        .rootViewController
    }
    return visibleViewController(from: root)
  }

  private static func visibleViewController(from controller: UIViewController?) -> UIViewController? {
    if let navigation = controller as? UINavigationController {
      return visibleViewController(from: navigation.visibleViewController)
    }
    if let tab = controller as? UITabBarController {
      return visibleViewController(from: tab.selectedViewController)
    }
    if let presented = controller?.presentedViewController {
      return visibleViewController(from: presented)
    }
    return controller
  }

  private static func recordPermissionLabel(_ permission: AVAudioSession.RecordPermission) -> String {
    switch permission {
    case .granted:
      return "granted"
    case .denied:
      return "denied"
    case .undetermined:
      return "undetermined"
    @unknown default:
      return "unknown"
    }
  }

  private static func notificationAuthorizationLabel(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .authorized:
      return "authorized"
    case .denied:
      return "denied"
    case .notDetermined:
      return "notDetermined"
    case .provisional:
      return "provisional"
    case .ephemeral:
      return "ephemeral"
    @unknown default:
      return "unknown"
    }
  }
}
