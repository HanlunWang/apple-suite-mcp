// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "photos-helper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "photos-helper", path: "Sources")
    ]
)
