// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "maps-helper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "maps-helper", path: "Sources")
    ]
)
