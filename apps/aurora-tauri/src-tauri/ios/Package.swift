// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "AuroraNativePlugin",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "AuroraNativePlugin", targets: ["AuroraNativePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/tauri-apps/tauri-mobile", branch: "v2")
    ],
    targets: [
        .target(
            name: "AuroraNativePlugin",
            dependencies: [
                .product(name: "Tauri", package: "tauri-mobile")
            ]
        )
    ]
)
