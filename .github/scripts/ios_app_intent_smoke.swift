import AppIntents
import Foundation

@available(iOS 16.0, macOS 13.0, *)
@main
struct AuroraAppIntentSmoke {
  static func main() async throws {
    var intent = AskAuroraIntent()
    intent.prompt = "CI App Intent smoke"
    let handoff = intent.makeHandoff()
    _ = try await intent.perform()

    precondition(handoff.action == "askAuroraAppIntent")
    precondition(handoff.backendMethod == "Orchestrator.ExternalUserInput")
    precondition(handoff.invocation == "app-intent")
    precondition(handoff.privacyClass == "personal")
    precondition(handoff.requiresConfirmation == false)
    precondition(handoff.siriReplacement == false)
    precondition(handoff.correlationId.isEmpty == false)

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(handoff)
    guard let json = String(data: data, encoding: .utf8) else {
      throw CocoaError(.fileWriteInapplicableStringEncoding)
    }
    print(json)
  }
}
