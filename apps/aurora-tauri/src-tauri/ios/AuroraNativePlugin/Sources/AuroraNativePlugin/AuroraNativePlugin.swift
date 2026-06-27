import AVFAudio
import Foundation
import LocalAuthentication
import Security
import Tauri
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

@objc(AuroraNativePlugin)
public final class AuroraNativePlugin: Plugin {
  private let mobileIntegrations: [[String: Any]] = [
    [
      "platform": "ios",
      "id": "askAuroraAppIntent",
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
      "userCopy": "Runs as an app-owned Siri/Shortcuts/App Intents integration and does not replace Siri.",
      "verifier": "tauri ios build plus simulator/device App Intent invocation on macOS/Xcode"
    ],
    [
      "platform": "ios",
      "id": "askAuroraShortcut",
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
      "userCopy": "Shortcut invocation hands off to AuroraClient/backend evidence before executing assistant work.",
      "verifier": "simulator/device Shortcut invocation through the Xcode-managed iOS target"
    ],
    [
      "platform": "ios",
      "id": "summarizeSharedContentShortcut",
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
      "userCopy": "Requires explicit user invocation and backend route/privacy evidence before sending shared content.",
      "verifier": "simulator/device Shortcut or share handoff smoke with backend correlation evidence"
    ],
    [
      "platform": "ios",
      "id": "stopAuroraSpeechAppIntent",
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
      "label": "Siri replacement",
      "support": "unsupported",
      "capability": "ios.siriReplacement",
      "permission": NSNull(),
      "privacyClass": "public",
      "requiresConfirmation": false,
      "siriReplacement": false,
      "evidenceSource": "Apple-platform-policy",
      "userCopy": "iOS does not allow Aurora to replace Siri as the default assistant.",
      "verifier": "copy and capability review; no executable route should be exposed"
    ],
    [
      "platform": "ios",
      "id": "shareExtension",
      "label": "iOS share extension intake",
      "support": "supported-path",
      "capability": "ios.shareExtension",
      "permission": "aurora.ios.shareExtension",
      "invocation": "share_extension",
      "backendMethod": "Orchestrator.IngestContext",
      "privacyClass": "sensitive",
      "requiresConfirmation": true,
      "siriReplacement": false,
      "evidenceSource": "IOS-004 native plugin manifest",
      "userCopy": "Share extension payloads pass redacted metadata to AuroraClient/backend ingestion before any assistant action is claimed.",
      "verifier": "tauri ios build plus compiled IOS-004 entrypoint payload smoke"
    ],
    [
      "platform": "ios",
      "id": "deepLinks",
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
      "userCopy": "aurora:// links open app-owned Aurora flows; backend evidence proves any context or session handoff.",
      "verifier": "tauri ios build plus compiled IOS-004 entrypoint payload smoke"
    ],
    [
      "platform": "ios",
      "id": "widgets",
      "label": "iOS widgets",
      "support": "supported-path",
      "capability": "ios.widgets",
      "permission": "aurora.ios.widgets",
      "invocation": "widget",
      "backendMethod": "AuroraClient.OpenEntrypoint",
      "privacyClass": "personal",
      "requiresConfirmation": false,
      "siriReplacement": false,
      "evidenceSource": "IOS-004 native plugin manifest",
      "userCopy": "Widget actions open Aurora through app-owned entrypoints and do not run orchestrator logic in the extension process.",
      "verifier": "tauri ios build plus compiled IOS-004 entrypoint payload smoke"
    ],
    [
      "platform": "ios",
      "id": "fileAssociations",
      "label": "iOS file associations",
      "support": "supported-path",
      "capability": "ios.fileAssociations",
      "permission": "aurora.ios.fileAssociations",
      "invocation": "file_association",
      "backendMethod": "Orchestrator.IngestContext",
      "privacyClass": "sensitive",
      "requiresConfirmation": true,
      "siriReplacement": false,
      "evidenceSource": "IOS-004 native plugin manifest",
      "userCopy": "File-open events pass redacted file URL metadata to AuroraClient/backend ingestion; file contents are not embedded in native diagnostics.",
      "verifier": "tauri ios build plus Tauri mobile file-association config and compiled IOS-004 payload smoke"
    ],
    [
      "platform": "ios",
      "id": "iosLocalLightInference",
      "label": "iOS local-light inference provider",
      "support": "supported-path",
      "capability": "ios.localLightInference.provider",
      "permission": "aurora.iosLocalLightInference",
      "invocation": "tauri-command",
      "backendMethod": "Orchestrator.GetModelRuntimeCatalog",
      "privacyClass": "personal",
      "requiresConfirmation": false,
      "siriReplacement": false,
      "evidenceSource": "ios-native-local-light-adapter",
      "userCopy": "Native adapter reports iOS Core ML/MLC/ExecuTorch-style local-light inference as a capability-gated provider; backend model catalog and device/model proof are still required before selection.",
      "verifier": "tauri ios build plus simulator/device nativeCapabilityManifest payload smoke"
    ]
  ]

  @objc public func nativeCapabilityManifest(_ invoke: Invoke) throws {
    invoke.resolve([
      "platform": "ios",
      "permissions": [
        "aurora.iosAppIntents": true,
        "aurora.iosShortcuts": true,
        "aurora.ios.shareExtension": true,
        "aurora.ios.deepLinks": true,
        "aurora.ios.widgets": true,
        "aurora.ios.fileAssociations": true,
        "aurora.ios.entrypointPayload": true,
        "aurora.iosLocalLightInference": false,
        "aurora.iosKeychain": true,
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
        "ios.shareExtension": true,
        "ios.deepLinks": true,
        "ios.widgets": true,
        "ios.fileAssociations": true,
        "ios.entrypointPayload": true,
        "ios.localLightInference.provider": true,
        "ios.localLightInference.modelRuntime": false,
        "ios.localLightInference.fallback": true,
        "ios.keychain.secureCredentialStorage": true,
        "ios.biometric.adminUnlock": true,
        "ios.voiceForegroundCapture": false,
        "ios.notifications": false,
        "ios.backgroundVoice": false,
        "ios.appOwnedInvocation": true,
        "ios.siriReplacement": false,
        "native.audioCapture": false,
        "native.audioPlayback": false
      ],
      "permissionStates": [
        "aurora.iosAppIntents": "available",
        "aurora.iosShortcuts": "available",
        "aurora.ios.shareExtension": "available",
        "aurora.ios.deepLinks": "available",
        "aurora.ios.widgets": "available",
        "aurora.ios.fileAssociations": "available",
        "aurora.ios.entrypointPayload": "available",
        "aurora.iosLocalLightInference": "degraded",
        "aurora.iosKeychain": "available",
        "aurora.iosBiometricUnlock": "available",
        "aurora.iosMicrophoneCapture": "needs_native_permission",
        "aurora.iosBackgroundAudio": "unsupported_platform",
        "aurora.iosSiriReplacement": "unsupported_platform"
      ],
      "capabilityStates": [
        "ios.appIntents": "available",
        "ios.shortcuts": "available",
        "ios.shareExtension": "available",
        "ios.deepLinks": "available",
        "ios.widgets": "available",
        "ios.fileAssociations": "available",
        "ios.entrypointPayload": "available",
        "ios.localLightInference.provider": "degraded",
        "ios.localLightInference.modelRuntime": "needs_native_permission",
        "ios.localLightInference.fallback": "fallback",
        "ios.keychain.secureCredentialStorage": "available",
        "ios.biometric.adminUnlock": "available",
        "ios.voiceForegroundCapture": "needs_native_permission",
        "ios.notifications": "needs_native_permission",
        "ios.backgroundVoice": "unsupported_platform",
        "ios.appOwnedInvocation": "available",
        "ios.siriReplacement": "unsupported_platform"
      ],
      "mobileIntegrations": mobileIntegrations,
      "iosInvocation": [
        "platform": "ios",
        "appIntentsAvailable": true,
        "shortcutsAvailable": true,
        "shareExtensionAvailable": true,
        "deepLinksAvailable": true,
        "widgetsAvailable": true,
        "fileAssociationsAvailable": true,
        "siriReplacement": false,
        "backendHandoffRequired": true,
        "privacyLabels": ["personal", "sensitive"],
        "state": "available",
        "reason": "iOS invocation targets are present; backend evidence still decides whether intake was processed.",
        "evidenceSource": "IOS-004 native plugin manifest",
        "secretsRedacted": true
      ],
      "localLightInference": AuroraNativePlugin.localLightInferenceStatusPayload(),
      "entrypoints": AuroraNativePlugin.entrypoints(),
      "lastEntrypointPayload": AuroraNativePlugin.payloadDictionary(AuroraEntrypointFactory.emptyPayload()),
      "platformLimitations": [
        [
          "platform": "ios",
          "id": "noSiriReplacement",
          "label": "No Siri replacement",
          "reason": "Apple permits app-owned App Intents, Shortcuts, widgets, share extensions, and deep links, not replacing Siri as the system assistant.",
          "userCopy": "Use Siri/Shortcuts/App Intents integration; do not claim Aurora replaces Siri.",
          "evidenceSource": "Apple App Intents and SiriKit extension documentation"
        ],
        [
          "platform": "ios",
          "id": "foregroundConsentRequired",
          "label": "Foreground consent required",
          "reason": "Always-on background assistant capture is unavailable on iOS without explicit app-owned foreground consent.",
          "userCopy": "Audio and shared-content actions require app-owned user invocation and backend privacy evidence.",
          "evidenceSource": "Apple App Intents, extensions, and privacy review requirements"
        ]
      ],
      "evidenceSource": "IOS-003 native plugin manifest",
      "secretsRedacted": true
    ])
  }

  @objc public func invocationStatus(_ invoke: Invoke) throws {
    let executableActions = mobileIntegrations
      .filter { ($0["support"] as? String) != "unsupported" }
      .map { $0["id"] as? String ?? "" }
      .filter { !$0.isEmpty }
    invoke.resolve([
      "available": true,
      "surface": "Siri/Shortcuts/App Intents integration",
      "supportedActions": executableActions,
      "mobileIntegrations": mobileIntegrations,
      "siriReplacement": false,
      "requiresBackendEvidence": true,
      "entrypoints": AuroraNativePlugin.entrypoints(),
      "secretsRedacted": true
    ])
  }

  @objc public func localLightInferenceStatus(_ invoke: Invoke) throws {
    invoke.resolve(AuroraNativePlugin.localLightInferenceStatusPayload())
  }

  @objc public func voiceStatus(_ invoke: Invoke) throws {
    let permission = AVAudioSession.sharedInstance().recordPermission
    let reason: Any = permission == .granted
      ? NSNull()
      : "iOS microphone capture requires foreground AVAudioSession record permission, raw-audio consent, backend audio evidence, and a visible stop/revoke path."
    invoke.resolve([
      "available": permission == .granted,
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
        "supportsSiriReplacement": false,
        "consentRequired": true,
        "stopRevokeRequired": true,
        "secretsRedacted": true
      ]
    ])
  }

  @objc public func notificationStatus(_ invoke: Invoke) throws {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let available = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
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

  @objc public func backgroundStatus(_ invoke: Invoke) throws {
    invoke.resolve([
      "available": false,
      "permission": "aurora.iosBackgroundAudio",
      "capability": "ios.backgroundVoice",
      "source": "tauri-ios-native-plugin",
      "reason": "iOS does not allow Aurora to run always-on background assistant listening or replace Siri; use app-owned foreground, notification, Shortcut, App Intent, widget, share, or deep-link entrypoints.",
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
          "aurora.mesh",
          "aurora.admin"
        ]
      ]
    ])
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
      ($0["id"] as? String) == request.action && ($0["support"] as? String) != "unsupported"
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
