import Foundation
import Tauri
import WebKit

@_cdecl("init_plugin_aurora_native")
public func initPluginAuroraNative() -> UnsafeMutableRawPointer {
  Unmanaged.passRetained(AuroraNativePlugin()).toOpaque()
}

struct AuroraInvocationRequest: Decodable {
  let action: String
  let correlationId: String?
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
        "permission": descriptor.permission,
        "intakeType": descriptor.intakeType,
        "urlScheme": descriptor.urlScheme ?? NSNull(),
        "universalLinkHost": descriptor.universalLinkHost ?? NSNull(),
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
      "url": payload.url ?? NSNull(),
      "scheme": payload.scheme ?? NSNull(),
      "host": payload.host ?? NSNull(),
      "path": payload.path ?? NSNull(),
      "fileExtension": payload.fileExtension ?? NSNull(),
      "uniformTypeIdentifier": payload.uniformTypeIdentifier ?? NSNull(),
      "originatingBundleId": payload.originatingBundleId ?? NSNull(),
      "sharedItemCount": payload.sharedItemCount,
      "privacyLabels": payload.privacyLabels,
      "backendHandoffRequired": payload.backendHandoffRequired,
      "correlationId": payload.correlationId,
      "secretsRedacted": payload.secretsRedacted,
      "siriReplacement": payload.siriReplacement
    ]
  }
}
