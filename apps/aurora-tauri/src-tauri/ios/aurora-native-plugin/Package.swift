// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "AuroraNativePlugin",
  platforms: [
    .iOS(.v13)
  ],
  products: [
    .library(
      name: "AuroraNativePlugin",
      targets: ["AuroraNativePlugin"]
    )
  ],
  dependencies: [
    .package(url: "https://github.com/tauri-apps/tauri-swift", from: "2.0.0")
  ],
  targets: [
    .target(
      name: "AuroraNativePlugin",
      dependencies: [
        .product(name: "Tauri", package: "tauri-swift")
      ],
      path: "Sources/AuroraNativePlugin"
    )
  ]
)
