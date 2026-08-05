// maps-helper — native backend for the maps module (MapKit).
//
// SECURITY CONTRACT (DESIGN.md §5.1): structured JSON on stdin, one JSON
// response per line on stdout; untrusted fields only ever become typed
// MapKit API arguments. No script text, no shell.
//
// Privacy: this helper performs NO location lookups of the user — searches
// are anchored only to coordinates explicitly provided in the request. The
// only network traffic is MapKit's own search/directions service.

import Foundation
import MapKit

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
    case notFound(String)
    case invalidRequest(String)
}

// MARK: - DTOs

struct PlaceDTO: Encodable {
    let name: String
    let latitude: Double
    let longitude: Double
    let address: String?
    let phone: String?
    let url: String?
    let category: String?
}

struct RouteDTO: Encodable {
    let name: String
    let distanceMeters: Double
    let travelTimeSeconds: Double
    let transport: String
    let steps: [String]
}

struct PongDTO: Encodable { let pong: Bool; let version: String }

// MARK: - Args

struct NearArg: Decodable {
    let latitude: Double
    let longitude: Double
    let radiusKm: Double?
}

struct SearchArgs: Decodable {
    let query: String
    let near: NearArg?
    let limit: Int?
}

struct DirectionsArgs: Decodable {
    let from: String
    let to: String
    let transport: String?  // "driving" | "walking"
}

// MARK: - Core

func placeDTO(_ item: MKMapItem) -> PlaceDTO {
    PlaceDTO(
        name: item.name ?? "",
        latitude: item.placemark.coordinate.latitude,
        longitude: item.placemark.coordinate.longitude,
        address: item.placemark.title,
        phone: item.phoneNumber,
        url: item.url?.absoluteString,
        category: item.pointOfInterestCategory?.rawValue
    )
}

func runLocalSearch(_ query: String, near: NearArg?) async throws -> [MKMapItem] {
    let request = MKLocalSearch.Request()
    request.naturalLanguageQuery = query
    if let near {
        let radius = max(min((near.radiusKm ?? 10) * 1000, 200_000), 500)
        request.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: near.latitude, longitude: near.longitude),
            latitudinalMeters: radius, longitudinalMeters: radius)
    }
    let search = MKLocalSearch(request: request)
    let response = try await search.start()
    return response.mapItems
}

func search(_ args: SearchArgs) async throws -> [PlaceDTO] {
    guard !args.query.isEmpty else { throw HelperError.invalidRequest("query must not be empty") }
    let limit = min(max(args.limit ?? 10, 1), 50)
    let items = try await runLocalSearch(args.query, near: args.near)
    return items.prefix(limit).map(placeDTO)
}

func directions(_ args: DirectionsArgs) async throws -> RouteDTO {
    guard !args.from.isEmpty, !args.to.isEmpty else {
        throw HelperError.invalidRequest("from and to must not be empty")
    }
    guard let source = try await runLocalSearch(args.from, near: nil).first else {
        throw HelperError.notFound("no place found for: \(args.from)")
    }
    guard let destination = try await runLocalSearch(args.to, near: nil).first else {
        throw HelperError.notFound("no place found for: \(args.to)")
    }
    let request = MKDirections.Request()
    request.source = source
    request.destination = destination
    switch args.transport ?? "driving" {
    case "driving": request.transportType = .automobile
    case "walking": request.transportType = .walking
    default: throw HelperError.invalidRequest("transport must be driving|walking")
    }
    let response = try await MKDirections(request: request).calculate()
    guard let route = response.routes.first else {
        throw HelperError.notFound("no route found")
    }
    return RouteDTO(
        name: route.name,
        distanceMeters: route.distance,
        travelTimeSeconds: route.expectedTravelTime,
        transport: args.transport ?? "driving",
        steps: route.steps.map { $0.instructions }.filter { !$0.isEmpty }.prefix(50).map { $0 }
    )
}

// MARK: - Dispatch

let decoder = JSONDecoder()
let encoder = JSONEncoder()

func decodeArgs<T: Decodable>(_ data: Data, _ type: T.Type) throws -> T {
    do { return try decoder.decode(RequestBody<T>.self, from: data).args } catch {
        throw HelperError.invalidRequest("bad args: \(error.localizedDescription)")
    }
}

func handle(line: String) async -> Data {
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
        case "maps.search":
            result = AnyEncodable(try await search(decodeArgs(data, SearchArgs.self)))
        case "maps.directions":
            result = AnyEncodable(try await directions(decodeArgs(data, DirectionsArgs.self)))
        default:
            return encodeError(id: envelope.id, code: "invalid_request", message: "unknown op \(envelope.op)")
        }
        return (try? encoder.encode(OkResponse(id: envelope.id, data: result)))
            ?? encodeError(id: envelope.id, code: "internal", message: "encoding failure")
    } catch let err as HelperError {
        switch err {
        case .notFound(let msg): return encodeError(id: envelope.id, code: "not_found", message: msg)
        case .invalidRequest(let msg): return encodeError(id: envelope.id, code: "invalid_request", message: msg)
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
    FileHandle.standardError.write(Data("usage: maps-helper --json-stdin\n".utf8))
    exit(2)
}

let newline = Data("\n".utf8)
while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    let out = await handle(line: line)
    FileHandle.standardOutput.write(out + newline)
}
