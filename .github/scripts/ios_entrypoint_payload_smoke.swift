import Foundation

struct AuroraEntrypointSmokeReport: Codable {
  let descriptors: [AuroraEntrypointDescriptor]
  let payloads: [AuroraEntrypointPayload]
}

@main
struct AuroraEntrypointPayloadSmoke {
  static func main() throws {
    let descriptors = AuroraEntrypointFactory.descriptors()
    precondition(descriptors.map(\.id).contains("ios_share_extension"))
    precondition(descriptors.map(\.id).contains("ios_deep_link"))
    precondition(descriptors.map(\.id).contains("ios_widget"))
    precondition(descriptors.map(\.id).contains("ios_file_association"))
    precondition(descriptors.allSatisfy { $0.platform == "ios" })
    precondition(descriptors.allSatisfy { $0.backendRequired })
    precondition(descriptors.allSatisfy { $0.payloadCommand == "iosEntrypointPayload" })

    let share = AuroraEntrypointFactory.shareExtensionPayload(
      sharedItemCount: 2,
      originatingBundleId: "com.apple.mobilesafari"
    )
    let deepLink = AuroraEntrypointFactory.deepLinkPayload(
      url: URL(string: "aurora://assistant/share?token=secret#fragment")!
    )
    let widget = AuroraEntrypointFactory.widgetPayload(action: "open-assistant")
    let file = AuroraEntrypointFactory.fileAssociationPayload(
      fileURL: URL(fileURLWithPath: "/private/tmp/example.aurora"),
      uniformTypeIdentifier: "dev.aurora.context"
    )

    let payloads = [share, deepLink, widget, file]
    precondition(payloads.allSatisfy(\.backendHandoffRequired))
    precondition(payloads.allSatisfy(\.secretsRedacted))
    precondition(payloads.allSatisfy { $0.siriReplacement == false })
    precondition(share.invocation == "share_extension")
    precondition(share.sharedItemCount == 2)
    precondition(share.privacyLabels.contains("sensitive"))
    precondition(deepLink.url == "aurora://assistant/share")
    precondition(deepLink.scheme == "aurora")
    precondition(widget.invocation == "widget:open-assistant")
    precondition(file.fileExtension == "aurora")
    precondition(file.uniformTypeIdentifier == "dev.aurora.context")

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(AuroraEntrypointSmokeReport(descriptors: descriptors, payloads: payloads))
    guard let json = String(data: data, encoding: .utf8) else {
      throw CocoaError(.fileWriteInapplicableStringEncoding)
    }
    print(json)
  }
}
