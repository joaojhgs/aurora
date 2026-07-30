import Foundation

public struct AuroraEntrypointPayload: Codable {
  public let source: String
  public let invocation: String
  public let url: String?
  public let scheme: String?
  public let host: String?
  public let path: String?
  public let fileExtension: String?
  public let uniformTypeIdentifier: String?
  public let originatingBundleId: String?
  public let sharedItemCount: Int
  public let privacyLabels: [String]
  public let backendHandoffRequired: Bool
  public let correlationId: String
  public let secretsRedacted: Bool
  public let siriReplacement: Bool
}

public struct AuroraEntrypointDescriptor: Codable {
  public let id: String
  public let platform: String
  public let label: String
  public let state: String
  public let available: Bool
  public let capability: String
  public let permission: String
  public let intakeType: String
  public let urlScheme: String?
  public let universalLinkHost: String?
  public let fileExtensions: [String]
  public let xcodeTarget: String
  public let backendRequired: Bool
  public let payloadCommand: String
  public let privacyClass: String
  public let reason: String
}

public enum AuroraEntrypointFactory {
  private static let pendingNativeTargetReason = "iOS native target proof is pending; this source is described but must not be reported available until a macOS/Xcode build and simulator or device invocation proves it."

  public static func descriptors() -> [AuroraEntrypointDescriptor] {
    [
      AuroraEntrypointDescriptor(
        id: "ios_share_extension",
        platform: "ios",
        label: "iOS share extension",
        state: "pending_native_target",
        available: false,
        capability: "ios.shareExtension",
        permission: "aurora.ios.shareExtension",
        intakeType: "share_extension",
        urlScheme: nil,
        universalLinkHost: nil,
        fileExtensions: [],
        xcodeTarget: "AuroraShareExtension",
        backendRequired: true,
        payloadCommand: "iosEntrypointPayload",
        privacyClass: "personal",
        reason: pendingNativeTargetReason
      ),
      AuroraEntrypointDescriptor(
        id: "ios_deep_link",
        platform: "ios",
        label: "iOS deep link",
        state: "available",
        available: true,
        capability: "ios.deepLinks",
        permission: "aurora.ios.deepLinks",
        intakeType: "deep_link",
        urlScheme: "aurora",
        universalLinkHost: "link.aurora.local",
        fileExtensions: [],
        xcodeTarget: "Aurora",
        backendRequired: true,
        payloadCommand: "iosEntrypointPayload",
        privacyClass: "personal",
        reason: "Deep links launch Aurora-owned flows only; Aurora confirms whether intake succeeded."
      ),
      AuroraEntrypointDescriptor(
        id: "ios_widget",
        platform: "ios",
        label: "iOS widget",
        state: "pending_native_target",
        available: false,
        capability: "ios.widgets",
        permission: "aurora.ios.widgets",
        intakeType: "widget",
        urlScheme: "aurora",
        universalLinkHost: nil,
        fileExtensions: [],
        xcodeTarget: "AuroraWidgetExtension",
        backendRequired: true,
        payloadCommand: "iosEntrypointPayload",
        privacyClass: "personal",
        reason: pendingNativeTargetReason
      ),
      AuroraEntrypointDescriptor(
        id: "ios_file_association",
        platform: "ios",
        label: "iOS file association",
        state: "pending_native_target",
        available: false,
        capability: "ios.fileAssociations",
        permission: "aurora.ios.fileAssociations",
        intakeType: "file_association",
        urlScheme: nil,
        universalLinkHost: nil,
        fileExtensions: ["txt", "md", "json", "aurora"],
        xcodeTarget: "Aurora",
        backendRequired: true,
        payloadCommand: "iosEntrypointPayload",
        privacyClass: "personal",
        reason: pendingNativeTargetReason
      )
    ]
  }

  public static func emptyPayload() -> AuroraEntrypointPayload {
    AuroraEntrypointPayload(
      source: "none",
      invocation: "none",
      url: nil,
      scheme: nil,
      host: nil,
      path: nil,
      fileExtension: nil,
      uniformTypeIdentifier: nil,
      originatingBundleId: nil,
      sharedItemCount: 0,
      privacyLabels: ["personal"],
      backendHandoffRequired: true,
      correlationId: UUID().uuidString,
      secretsRedacted: true,
      siriReplacement: false
    )
  }

  public static func shareExtensionPayload(sharedItemCount: Int, originatingBundleId: String?) -> AuroraEntrypointPayload {
    AuroraEntrypointPayload(
      source: "ios_share_extension",
      invocation: "share_extension",
      url: nil,
      scheme: nil,
      host: nil,
      path: nil,
      fileExtension: nil,
      uniformTypeIdentifier: nil,
      originatingBundleId: originatingBundleId,
      sharedItemCount: sharedItemCount,
      privacyLabels: ["personal", "sensitive"],
      backendHandoffRequired: true,
      correlationId: UUID().uuidString,
      secretsRedacted: true,
      siriReplacement: false
    )
  }

  public static func deepLinkPayload(url: URL) -> AuroraEntrypointPayload {
    AuroraEntrypointPayload(
      source: "ios_deep_link",
      invocation: "deep_link",
      url: redactedURL(url),
      scheme: url.scheme,
      host: url.host,
      path: url.path.isEmpty ? nil : url.path,
      fileExtension: nil,
      uniformTypeIdentifier: nil,
      originatingBundleId: nil,
      sharedItemCount: 0,
      privacyLabels: ["personal"],
      backendHandoffRequired: true,
      correlationId: UUID().uuidString,
      secretsRedacted: true,
      siriReplacement: false
    )
  }

  public static func widgetPayload(action: String) -> AuroraEntrypointPayload {
    AuroraEntrypointPayload(
      source: "ios_widget",
      invocation: action.isEmpty ? "widget" : "widget:\(action)",
      url: nil,
      scheme: "aurora",
      host: nil,
      path: nil,
      fileExtension: nil,
      uniformTypeIdentifier: nil,
      originatingBundleId: "dev.aurora.widget",
      sharedItemCount: 0,
      privacyLabels: ["personal"],
      backendHandoffRequired: true,
      correlationId: UUID().uuidString,
      secretsRedacted: true,
      siriReplacement: false
    )
  }

  public static func fileAssociationPayload(fileURL: URL, uniformTypeIdentifier: String?) -> AuroraEntrypointPayload {
    AuroraEntrypointPayload(
      source: "ios_file_association",
      invocation: "file_association",
      url: redactedURL(fileURL),
      scheme: fileURL.scheme,
      host: fileURL.host,
      path: fileURL.lastPathComponent,
      fileExtension: fileURL.pathExtension.isEmpty ? nil : fileURL.pathExtension,
      uniformTypeIdentifier: uniformTypeIdentifier,
      originatingBundleId: nil,
      sharedItemCount: 1,
      privacyLabels: ["personal", "sensitive"],
      backendHandoffRequired: true,
      correlationId: UUID().uuidString,
      secretsRedacted: true,
      siriReplacement: false
    )
  }

  private static func redactedURL(_ url: URL) -> String {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return "redacted"
    }
    components.query = nil
    components.fragment = nil
    return components.string ?? "redacted"
  }
}
