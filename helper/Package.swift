// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "MacReachHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "MacReachHelper",
            path: "Sources/MacReachHelper",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
