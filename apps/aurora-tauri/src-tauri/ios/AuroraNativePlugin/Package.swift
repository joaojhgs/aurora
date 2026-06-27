// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "AuroraNativePlugin",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "AuroraNativePlugin",
      type: .static,
      targets: ["AuroraNativePlugin"]
    )
  ],
  dependencies: [
    .package(name: "Tauri", path: "../../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "AuroraNativePlugin",
      dependencies: ["Tauri"],
      path: "Sources/AuroraNativePlugin"
    )
  ]
)
