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
      "evidenceSource": "IOS-003 native plugin manifest",
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
    ]
  ]

  @objc public func nativeCapabilityManifest(_ invoke: Invoke) throws {
    invoke.resolve([
      "platform": "ios",
      "permissions": [
        "aurora.iosAppIntents": true,
        "aurora.iosShortcuts": true,
        "aurora.iosShareExtension": false,
        "aurora.iosWidgets": false,
        "aurora.iosDeepLinks": false,
        "aurora.iosSiriReplacement": false,
        "aurora.audioCapture": false,
        "aurora.audioPlayback": false
      ],
      "capabilities": [
        "ios.appIntents": true,
        "ios.shortcuts": true,
        "ios.shareExtension": false,
        "ios.widgets": false,
        "ios.deepLinks": false,
        "ios.siriReplacement": false,
        "native.audioCapture": false,
        "native.audioPlayback": false
      ],
      "mobileIntegrations": mobileIntegrations,
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
}
