// photos-helper — native backend for the photos module (Photos.framework).
//
// SECURITY CONTRACT (DESIGN.md §5.1): structured JSON on stdin, one JSON
// response per line on stdout; untrusted fields only ever become typed
// PhotoKit API arguments. No script text, no shell.
//
// Its own TCC subject (Photos library access), requested lazily. READ-ONLY:
// this helper exposes metadata only — no pixels leave the machine and no
// asset is ever modified or deleted.

import Foundation
import Photos

// MARK: - Wire types (shared contract)

struct Envelope: Decodable { let id: Int; let op: String }

struct RequestBody<Args: Decodable>: Decodable {
    let id: Int
    let op: String
    let args: Args
}

struct AnyEncodable: Encodable {
    private let encodeFn: (Encoder) throws -> Void
    init<T: Encodable>(_ value: T) { self.encodeFn = value.encode }
    func encode(to encoder: Encoder) throws { try encodeFn(encoder) }
}

struct ErrorBody: Encodable { let code: String; let message: String; let hint: String? }
struct OkResponse: Encodable { let id: Int; let ok = true; let data: AnyEncodable }
struct ErrResponse: Encodable { let id: Int; let ok = false; let error: ErrorBody }

enum HelperError: Error {
    case permissionDenied(String, hint: String)
    case notFound(String)
    case invalidRequest(String)
}

// MARK: - Dates

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

func parseDate(_ s: String, field: String) throws -> Date {
    guard let d = isoFormatter.date(from: s) else {
        throw HelperError.invalidRequest("\(field) is not an ISO 8601 date-time: \(s)")
    }
    return d
}

// MARK: - DTOs

struct AlbumDTO: Encodable {
    let id: String
    let title: String
    let count: Int
}

struct AssetDTO: Encodable {
    let id: String
    let createdAt: String?
    let mediaType: String
    let favorite: Bool
    let width: Int
    let height: Int
}

struct PongDTO: Encodable { let pong: Bool; let version: String }

func mediaTypeName(_ t: PHAssetMediaType) -> String {
    switch t {
    case .image: return "image"
    case .video: return "video"
    case .audio: return "audio"
    default: return "unknown"
    }
}

func assetDTO(_ a: PHAsset) -> AssetDTO {
    AssetDTO(
        id: a.localIdentifier,
        createdAt: a.creationDate.map { isoFormatter.string(from: $0) },
        mediaType: mediaTypeName(a.mediaType),
        favorite: a.isFavorite,
        width: a.pixelWidth,
        height: a.pixelHeight
    )
}

// MARK: - Args

struct ListAssetsArgs: Decodable {
    let albumId: String?
    let from: String?
    let to: String?
    let favoritesOnly: Bool?
    let limit: Int?
}


// MARK: - Helper core

final class Helper {
    private var granted = false

    static let permissionHint =
        "Grant access in System Settings → Privacy & Security → Photos "
        + "(the subject is the photos-helper binary), then retry."

    func ensureAccess() async throws {
        if granted { return }
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else {
            throw HelperError.permissionDenied(
                "Photos access is not granted", hint: Helper.permissionHint)
        }
        granted = true
    }

    func listAlbums() async throws -> [AlbumDTO] {
        try await ensureAccess()
        var albums: [AlbumDTO] = []
        let collections = PHAssetCollection.fetchAssetCollections(
            with: .album, subtype: .albumRegular, options: nil)
        collections.enumerateObjects { collection, _, _ in
            let count = PHAsset.fetchAssets(in: collection, options: nil).count
            albums.append(
                AlbumDTO(
                    id: collection.localIdentifier,
                    title: collection.localizedTitle ?? "",
                    count: count))
        }
        return albums
    }

    func listAssets(_ args: ListAssetsArgs) async throws -> [AssetDTO] {
        try await ensureAccess()
        let limit = min(max(args.limit ?? 50, 1), 500)

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = limit
        var predicates: [NSPredicate] = []
        if let from = args.from {
            predicates.append(NSPredicate(format: "creationDate >= %@", try parseDate(from, field: "from") as NSDate))
        }
        if let to = args.to {
            predicates.append(NSPredicate(format: "creationDate <= %@", try parseDate(to, field: "to") as NSDate))
        }
        if args.favoritesOnly == true {
            predicates.append(NSPredicate(format: "favorite == YES"))
        }
        if !predicates.isEmpty {
            options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        }

        let fetch: PHFetchResult<PHAsset>
        if let albumId = args.albumId {
            let collections = PHAssetCollection.fetchAssetCollections(
                withLocalIdentifiers: [albumId], options: nil)
            guard let collection = collections.firstObject else {
                throw HelperError.notFound("album \(albumId) not found")
            }
            fetch = PHAsset.fetchAssets(in: collection, options: options)
        } else {
            fetch = PHAsset.fetchAssets(with: options)
        }

        var assets: [AssetDTO] = []
        fetch.enumerateObjects { asset, _, _ in assets.append(assetDTO(asset)) }
        return assets
    }
}

// MARK: - Dispatch

let decoder = JSONDecoder()
let encoder = JSONEncoder()

func decodeArgs<T: Decodable>(_ data: Data, _ type: T.Type) throws -> T {
    do { return try decoder.decode(RequestBody<T>.self, from: data).args } catch {
        throw HelperError.invalidRequest("bad args: \(error.localizedDescription)")
    }
}

func handle(line: String, helper: Helper) async -> Data {
    guard let data = line.data(using: .utf8) else {
        return encodeError(id: 0, code: "invalid_request", message: "non-UTF8 input")
    }
    let envelope: Envelope
    do { envelope = try decoder.decode(Envelope.self, from: data) } catch {
        return encodeError(id: 0, code: "invalid_request", message: "malformed request envelope")
    }
    do {
        let result: AnyEncodable
        switch envelope.op {
        case "ping":
            result = AnyEncodable(PongDTO(pong: true, version: "1.0.0"))
        case "photos.list_albums":
            result = AnyEncodable(try await helper.listAlbums())
        case "photos.list":
            result = AnyEncodable(try await helper.listAssets(decodeArgs(data, ListAssetsArgs.self)))
        default:
            return encodeError(id: envelope.id, code: "invalid_request", message: "unknown op \(envelope.op)")
        }
        return (try? encoder.encode(OkResponse(id: envelope.id, data: result)))
            ?? encodeError(id: envelope.id, code: "internal", message: "encoding failure")
    } catch let err as HelperError {
        switch err {
        case .permissionDenied(let msg, let hint):
            return encodeError(id: envelope.id, code: "permission_denied", message: msg, hint: hint)
        case .notFound(let msg):
            return encodeError(id: envelope.id, code: "not_found", message: msg)
        case .invalidRequest(let msg):
            return encodeError(id: envelope.id, code: "invalid_request", message: msg)
        }
    } catch {
        return encodeError(id: envelope.id, code: "internal", message: error.localizedDescription)
    }
}

func encodeError(id: Int, code: String, message: String, hint: String? = nil) -> Data {
    let resp = ErrResponse(id: id, error: ErrorBody(code: code, message: message, hint: hint))
    return (try? encoder.encode(resp)) ?? Data("{\"id\":0,\"ok\":false}".utf8)
}

// MARK: - Main loop

guard CommandLine.arguments.dropFirst() == ["--json-stdin"] else {
    FileHandle.standardError.write(Data("usage: photos-helper --json-stdin\n".utf8))
    exit(2)
}

let helper = Helper()
let newline = Data("\n".utf8)
while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    let out = await handle(line: line, helper: helper)
    FileHandle.standardOutput.write(out + newline)
}
