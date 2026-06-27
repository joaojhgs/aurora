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
  private let supportedActions = [
    "app-intent.open-assistant",
    "shortcut.open-assistant",
    "share.import-context",
    "deeplink.open"
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
      ]
    ])
  }

  @objc public func invocationStatus(_ invoke: Invoke) throws {
    invoke.resolve([
      "available": true,
      "surface": "Siri/Shortcuts/App Intents integration",
      "supportedActions": supportedActions,
      "siriReplacement": false,
      "requiresBackendEvidence": true,
      "secretsRedacted": true
    ])
  }

  @objc public func invokeAuroraAction(_ invoke: Invoke) throws {
    let request = try invoke.parseArgs(AuroraInvocationRequest.self)
    guard supportedActions.contains(request.action) else {
      invoke.resolve([
        "accepted": false,
        "action": request.action,
        "reason": "unsupported_action",
        "secretsRedacted": true
      ])
      return
    }

    var result: [String: Any] = [
      "accepted": true,
      "action": request.action,
      "handoff": "AuroraClient",
      "secretsRedacted": true
    ]
    if let correlationId = request.correlationId {
      result["correlationId"] = correlationId
    }
    invoke.resolve(result)
  }
}
