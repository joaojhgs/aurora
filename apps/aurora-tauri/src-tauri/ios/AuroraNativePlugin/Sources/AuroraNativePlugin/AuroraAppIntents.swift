import AppIntents
import Foundation

@available(iOS 16.0, macOS 13.0, *)
public struct AuroraIntentHandoff: AppEntity, Encodable {
  public static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Aurora action")
  public static var defaultQuery = AuroraIntentHandoffQuery()

  public let id: String
  public let action: String
  public let backendMethod: String
  public let invocation: String
  public let privacyClass: String
  public let requiresConfirmation: Bool
  public let siriReplacement: Bool
  public let correlationId: String

  public var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(
      title: "\(AuroraIntentHandoff.displayTitle(for: action))",
      subtitle: "\(requiresConfirmation ? "Review before sending" : "Ready for Aurora")"
    )
  }

  private static func displayTitle(for action: String) -> String {
    switch action {
    case "askAuroraAppIntent":
      return "Ask Aurora"
    case "askAuroraShortcut":
      return "Ask Aurora Shortcut"
    case "summarizeSharedContentShortcut":
      return "Summarize with Aurora"
    case "stopAuroraSpeechAppIntent":
      return "Stop Aurora speech"
    default:
      return "Aurora action"
    }
  }
}

@available(iOS 16.0, macOS 13.0, *)
public struct AuroraIntentHandoffQuery: EntityQuery {
  public init() {}

  public func entities(for identifiers: [AuroraIntentHandoff.ID]) async throws -> [AuroraIntentHandoff] {
    identifiers.map { identifier in
      AuroraIntentHandoff(
        id: identifier,
        action: "unknown",
        backendMethod: "AuroraClient",
        invocation: "app-intent",
        privacyClass: "personal",
        requiresConfirmation: false,
        siriReplacement: false,
        correlationId: identifier
      )
    }
  }

  public func suggestedEntities() async throws -> [AuroraIntentHandoff] {
    []
  }
}

@available(iOS 16.0, macOS 13.0, *)
public enum AuroraIntentHandoffFactory {
  public static func make(
    action: String,
    backendMethod: String,
    invocation: String,
    privacyClass: String,
    requiresConfirmation: Bool,
    prompt: String? = nil
  ) -> AuroraIntentHandoff {
    let correlationId = UUID().uuidString
    let normalizedPrompt = prompt?.trimmingCharacters(in: .whitespacesAndNewlines)
    let handoffId = [action, correlationId].joined(separator: ":")
    return AuroraIntentHandoff(
      id: handoffId,
      action: action,
      backendMethod: backendMethod,
      invocation: invocation,
      privacyClass: privacyClass,
      requiresConfirmation: requiresConfirmation,
      siriReplacement: false,
      correlationId: normalizedPrompt?.isEmpty == false ? "\(correlationId):prompt" : correlationId
    )
  }
}

@available(iOS 16.0, macOS 13.0, *)
public struct AskAuroraIntent: AppIntent {
  public static var title: LocalizedStringResource = "Ask Aurora"
  public static var description = IntentDescription("Send a prompt to Aurora.")
  public static var openAppWhenRun = true

  @Parameter(title: "Prompt", description: "Prompt for Aurora.")
  public var prompt: String?

  public init() {}

  public func makeHandoff() -> AuroraIntentHandoff {
    AuroraIntentHandoffFactory.make(
      action: "askAuroraAppIntent",
      backendMethod: "Orchestrator.ExternalUserInput",
      invocation: "app-intent",
      privacyClass: "personal",
      requiresConfirmation: false,
      prompt: prompt
    )
  }

  public func perform() async throws -> some IntentResult & ReturnsValue<AuroraIntentHandoff> {
    let handoff = makeHandoff()
    return .result(
      value: handoff,
      dialog: IntentDialog("Aurora is ready to send your prompt.")
    )
  }
}

@available(iOS 16.0, macOS 13.0, *)
public struct AskAuroraShortcutIntent: AppIntent {
  public static var title: LocalizedStringResource = "Ask Aurora Shortcut"
  public static var description = IntentDescription("Open Aurora from a Shortcut with your prompt.")
  public static var openAppWhenRun = true

  @Parameter(title: "Prompt", description: "Prompt for Aurora.")
  public var prompt: String?

  public init() {}

  public func makeHandoff() -> AuroraIntentHandoff {
    AuroraIntentHandoffFactory.make(
      action: "askAuroraShortcut",
      backendMethod: "Orchestrator.ExternalUserInput",
      invocation: "shortcut",
      privacyClass: "personal",
      requiresConfirmation: false,
      prompt: prompt
    )
  }

  public func perform() async throws -> some IntentResult & ReturnsValue<AuroraIntentHandoff> {
    let handoff = makeHandoff()
    return .result(
      value: handoff,
      dialog: IntentDialog("Aurora is ready to open from Shortcuts.")
    )
  }
}

@available(iOS 16.0, macOS 13.0, *)
public struct SummarizeSharedContentIntent: AppIntent {
  public static var title: LocalizedStringResource = "Summarize shared content"
  public static var description = IntentDescription("Share selected text with Aurora after confirmation.")
  public static var openAppWhenRun = true

  @Parameter(title: "Shared text", description: "Text selected by the user for Aurora to summarize.")
  public var sharedText: String?

  public init() {}

  public func makeHandoff() -> AuroraIntentHandoff {
    AuroraIntentHandoffFactory.make(
      action: "summarizeSharedContentShortcut",
      backendMethod: "Orchestrator.IngestContext",
      invocation: "shortcut",
      privacyClass: "sensitive",
      requiresConfirmation: true,
      prompt: sharedText
    )
  }

  public func perform() async throws -> some IntentResult & ReturnsValue<AuroraIntentHandoff> {
    let handoff = makeHandoff()
    return .result(
      value: handoff,
      dialog: IntentDialog("Aurora is ready to review shared content.")
    )
  }
}

@available(iOS 16.0, macOS 13.0, *)
public struct StopAuroraSpeechIntent: AppIntent {
  public static var title: LocalizedStringResource = "Stop Aurora speech"
  public static var description = IntentDescription("Stop Aurora speech playback.")
  public static var openAppWhenRun = true

  public init() {}

  public func makeHandoff() -> AuroraIntentHandoff {
    AuroraIntentHandoffFactory.make(
      action: "stopAuroraSpeechAppIntent",
      backendMethod: "TTS.Stop",
      invocation: "app-intent",
      privacyClass: "personal",
      requiresConfirmation: false
    )
  }

  public func perform() async throws -> some IntentResult & ReturnsValue<AuroraIntentHandoff> {
    let handoff = makeHandoff()
    return .result(
      value: handoff,
      dialog: IntentDialog("Aurora speech stop request is ready.")
    )
  }
}

@available(iOS 16.0, macOS 13.0, *)
public struct AuroraAppShortcuts: AppShortcutsProvider {
  public static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskAuroraIntent(),
      phrases: [
        "Ask \(.applicationName)",
        "Ask \(.applicationName) with \(\.$prompt)"
      ],
      shortTitle: "Ask Aurora",
      systemImageName: "sparkles"
    )
    AppShortcut(
      intent: AskAuroraShortcutIntent(),
      phrases: [
        "Open \(.applicationName)",
        "Ask \(.applicationName) shortcut"
      ],
      shortTitle: "Ask Aurora Shortcut",
      systemImageName: "bubble.left.and.text.bubble.right"
    )
    AppShortcut(
      intent: SummarizeSharedContentIntent(),
      phrases: [
        "Summarize with \(.applicationName)",
        "Summarize \(\.$sharedText) with \(.applicationName)"
      ],
      shortTitle: "Summarize",
      systemImageName: "doc.text.magnifyingglass"
    )
    AppShortcut(
      intent: StopAuroraSpeechIntent(),
      phrases: [
        "Stop \(.applicationName) speech",
        "Stop \(.applicationName)"
      ],
      shortTitle: "Stop speech",
      systemImageName: "speaker.slash"
    )
  }
}
