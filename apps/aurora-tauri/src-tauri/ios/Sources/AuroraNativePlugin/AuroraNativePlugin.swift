import Foundation
import LocalAuthentication
import Security
import Tauri
import WebKit

struct AuroraAdminUnlockArgs: Decodable {
    let reason: String
    let action: String?
    let correlationId: String?
    let allowDeviceCredential: Bool?
}

@objc public class AuroraNativePlugin: Plugin {
    @objc public override func load(webview: WKWebView) {
        super.load(webview: webview)
    }

    @objc public func iosSecureStorageStatus(_ invoke: Invoke) {
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

    @objc public func iosBiometricStatus(_ invoke: Invoke) {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        invoke.resolve([
            "available": available,
            "permission": "aurora.iosBiometricUnlock",
            "capability": "ios.biometric.adminUnlock",
            "source": "tauri-ios-native-plugin",
            "reason": available ? nil : (error?.localizedDescription ?? "Face ID/Touch ID is not available."),
            "details": [
                "framework": "LocalAuthentication",
                "biometry": biometryLabel(context.biometryType),
                "usageDescriptionRequired": "NSFaceIDUsageDescription",
                "privacyClass": "credential",
                "secretsRedacted": true,
                "confirmationOnly": true
            ]
        ])
    }

    @objc public func iosAdminUnlock(_ invoke: Invoke) {
        do {
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
                    invoke.resolve([
                        "available": true,
                        "permission": "aurora.iosBiometricUnlock",
                        "capability": "ios.biometric.adminUnlock",
                        "source": "tauri-ios-native-plugin",
                        "details": [
                            "action": args.action as Any,
                            "correlationId": args.correlationId as Any,
                            "adminActionBackendRequired": true,
                            "confirmationOnly": true,
                            "secretsRedacted": true
                        ]
                    ])
                } else {
                    invoke.reject(authError?.localizedDescription ?? "Biometric admin unlock failed.")
                }
            }
        } catch {
            invoke.reject("Invalid iOS admin unlock request.")
        }
    }
}

private func biometryLabel(_ type: LABiometryType) -> String {
    switch type {
    case .faceID:
        return "Face ID"
    case .touchID:
        return "Touch ID"
    default:
        return "none"
    }
}
