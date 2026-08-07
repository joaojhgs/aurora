// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "AuroraIOSAudioSpike",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "AuroraIOSAudioSpike", targets: ["AuroraIOSAudioSpike"])
    ],
    targets: [
        .target(
            name: "AuroraIOSAudioSpike",
            dependencies: ["CAuroraIOSAudioBridge"]
        ),
        .systemLibrary(
            name: "CAuroraIOSAudioBridge",
            path: "Sources/CAuroraIOSAudioBridge"
        )
    ]
)
