import Foundation
import Tauri
import WebKit

public final class AuroraNativePlugin: Plugin {
  private var lastPayload: [String: Any] = AuroraNativePlugin.emptyPayload()

  @objc public override func load(webview: WKWebView) {
    lastPayload = AuroraNativePlugin.emptyPayload()
  }

  @objc public func nativeCapabilityManifest(_ invoke: Invoke) throws {
    invoke.resolve(AuroraNativePlugin.nativeCapabilityManifest())
  }

  @objc public func iosInvocationStatus(_ invoke: Invoke) throws {
    invoke.resolve(AuroraNativePlugin.iosInvocationStatus())
  }

  @objc public func invocationStatus(_ invoke: Invoke) throws {
    invoke.resolve(AuroraNativePlugin.iosInvocationStatus())
  }

  @objc public func iosEntrypointPayload(_ invoke: Invoke) throws {
    invoke.resolve([
      "payload": lastPayload,
      "entrypoints": AuroraNativePlugin.entrypoints(),
      "evidenceSource": "ios-tauri-native-plugin",
      "secretsRedacted": true
    ])
  }

  private static func nativeCapabilityManifest() -> [String: Any] {
    [
      "platform": "ios",
      "permissions": [
        "aurora.ios.appIntents": true,
        "aurora.ios.shortcuts": true,
        "aurora.ios.shareExtension": true,
        "aurora.ios.deepLinks": true,
        "aurora.ios.widgets": true,
        "aurora.ios.fileAssociations": true,
        "aurora.ios.entrypointPayload": true
      ],
      "capabilities": [
        "ios.appIntents": true,
        "ios.shortcuts": true,
        "ios.shareExtension": true,
        "ios.deepLinks": true,
        "ios.widgets": true,
        "ios.fileAssociations": true,
        "ios.entrypointPayload": true,
        "ios.siriReplacement": false
      ],
      "permissionStates": stateMap(prefix: "aurora.ios.", state: "available"),
      "capabilityStates": stateMap(prefix: "ios.", state: "available"),
      "mobileIntegrations": mobileIntegrations(),
      "platformLimitations": [
        [
          "platform": "ios",
          "id": "noSiriReplacement",
          "label": "No Siri replacement",
          "reason": "Apple permits app-owned App Intents, Shortcuts, widgets, share extensions, and deep links, not replacing Siri as the system assistant.",
          "userCopy": "Use Siri/Shortcuts/App Intents integration; do not claim Aurora replaces Siri.",
          "evidenceSource": "Apple App Intents and SiriKit extension documentation"
        ]
      ],
      "iosInvocation": iosInvocationStatus(),
      "entrypoints": entrypoints(),
      "lastEntrypointPayload": emptyPayload(),
      "evidenceSource": "ios-tauri-native-plugin",
      "secretsRedacted": true
    ]
  }

  private static func mobileIntegrations() -> [[String: Any]] {
    [
      integration(
        id: "appIntents",
        label: "Siri/Shortcuts/App Intents integration",
        support: "supported-path",
        capability: "ios.appIntents",
        permission: "aurora.ios.appIntents",
        userCopy: "Scoped App Intents can open concrete Aurora actions; backend state remains authoritative.",
        verifier: "tauri ios build plus simulator/device App Intent invocation on macOS/Xcode"
      ),
      integration(
        id: "shareExtension",
        label: "iOS share extension intake",
        support: "supported-path",
        capability: "ios.shareExtension",
        permission: "aurora.ios.shareExtension",
        userCopy: "The share extension accepts user-selected text, URLs, and files, then hands redacted metadata to Aurora backend context ingestion.",
        verifier: "Xcode share-extension target smoke plus simulator/device share sheet invocation"
      ),
      integration(
        id: "deepLinks",
        label: "iOS deep links",
        support: "supported-path",
        capability: "ios.deepLinks",
        permission: "aurora.ios.deepLinks",
        userCopy: "aurora:// app links launch app-owned Aurora flows; backend state still proves any session or context handoff.",
        verifier: "simulator/device aurora:// URL open smoke through the iOS Tauri target"
      ),
      integration(
        id: "widgets",
        label: "iOS widgets",
        support: "supported-path",
        capability: "ios.widgets",
        permission: "aurora.ios.widgets",
        userCopy: "Widget actions open Aurora through app-owned entrypoints and do not execute assistant work in the extension process.",
        verifier: "Xcode widget extension build plus simulator widget tap smoke"
      ),
      integration(
        id: "fileAssociations",
        label: "iOS file associations",
        support: "supported-path",
        capability: "ios.fileAssociations",
        permission: "aurora.ios.fileAssociations",
        userCopy: "Tauri iOS file associations declare Aurora as a viewer for selected text, markdown, JSON, and Aurora exports.",
        verifier: "Tauri mobile file association metadata plus simulator document-open smoke"
      ),
      [
        "platform": "ios",
        "id": "siriReplacement",
        "label": "Siri replacement",
        "support": "unsupported",
        "capability": "ios.siriReplacement",
        "permission": NSNull(),
        "privacyClass": "public",
        "evidenceSource": "Apple-platform-policy",
        "userCopy": "iOS does not allow Aurora to replace Siri as the default assistant.",
        "verifier": "copy and capability review; no executable route should be exposed"
      ]
    ]
  }

  private static func integration(
    id: String,
    label: String,
    support: String,
    capability: String,
    permission: String,
    userCopy: String,
    verifier: String
  ) -> [String: Any] {
    [
      "platform": "ios",
      "id": id,
      "label": label,
      "support": support,
      "capability": capability,
      "permission": permission,
      "privacyClass": "personal",
      "evidenceSource": "ios-tauri-native-plugin",
      "userCopy": userCopy,
      "verifier": verifier
    ]
  }

  private static func iosInvocationStatus() -> [String: Any] {
    [
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
      "evidenceSource": "ios-tauri-native-plugin",
      "secretsRedacted": true
    ]
  }

  private static func entrypoints() -> [[String: Any]] {
    [
      entrypoint(
        id: "ios_share_extension",
        label: "iOS share extension",
        capability: "ios.shareExtension",
        permission: "aurora.ios.shareExtension",
        intakeType: "share_extension",
        xcodeTarget: "AuroraShareExtension",
        reason: "Share extension target must hand redacted payload metadata to backend attachment/context ingestion."
      ),
      entrypoint(
        id: "ios_deep_link",
        label: "iOS deep link",
        capability: "ios.deepLinks",
        permission: "aurora.ios.deepLinks",
        intakeType: "deep_link",
        urlScheme: "aurora",
        universalLinkHost: "link.aurora.local",
        xcodeTarget: "Aurora",
        reason: "Deep links launch Aurora-owned flows only; backend evidence decides whether content/session intake succeeded."
      ),
      entrypoint(
        id: "ios_widget",
        label: "iOS widget",
        capability: "ios.widgets",
        permission: "aurora.ios.widgets",
        intakeType: "widget",
        xcodeTarget: "AuroraWidgetExtension",
        reason: "Widgets can open Aurora entrypoints but must not run orchestrator logic in the extension."
      ),
      entrypoint(
        id: "ios_file_association",
        label: "iOS file association",
        capability: "ios.fileAssociations",
        permission: "aurora.ios.fileAssociations",
        intakeType: "file_association",
        fileExtensions: ["txt", "md", "json", "aurora"],
        xcodeTarget: "Aurora",
        reason: "File open events pass file URL metadata to the app; backend ingestion owns storage and redaction decisions."
      )
    ]
  }

  private static func entrypoint(
    id: String,
    label: String,
    capability: String,
    permission: String,
    intakeType: String,
    urlScheme: String? = nil,
    universalLinkHost: String? = nil,
    fileExtensions: [String] = [],
    xcodeTarget: String,
    reason: String
  ) -> [String: Any] {
    [
      "id": id,
      "platform": "ios",
      "label": label,
      "state": "available",
      "available": true,
      "capability": capability,
      "permission": permission,
      "intakeType": intakeType,
      "urlScheme": nullable(urlScheme),
      "universalLinkHost": nullable(universalLinkHost),
      "fileExtensions": fileExtensions,
      "xcodeTarget": xcodeTarget,
      "backendRequired": true,
      "payloadCommand": "iosEntrypointPayload",
      "privacyClass": "personal",
      "reason": reason
    ]
  }

  private static func emptyPayload() -> [String: Any] {
    [
      "source": "none",
      "invocation": "none",
      "url": NSNull(),
      "scheme": NSNull(),
      "host": NSNull(),
      "path": NSNull(),
      "fileExtension": NSNull(),
      "uniformTypeIdentifier": NSNull(),
      "originatingBundleId": NSNull(),
      "sharedItemCount": 0,
      "privacyLabels": ["personal"],
      "backendHandoffRequired": true,
      "correlationId": NSNull(),
      "secretsRedacted": true
    ]
  }

  private static func stateMap(prefix: String, state: String) -> [String: String] {
    [
      "\(prefix)appIntents": state,
      "\(prefix)shortcuts": state,
      "\(prefix)shareExtension": state,
      "\(prefix)deepLinks": state,
      "\(prefix)widgets": state,
      "\(prefix)fileAssociations": state,
      "\(prefix)entrypointPayload": state,
      "\(prefix)siriReplacement": "unsupported_platform"
    ]
  }

  private static func nullable(_ value: String?) -> Any {
    value ?? NSNull()
  }
}
