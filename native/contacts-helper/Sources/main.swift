// contacts-helper — native backend for the contacts module.
//
// SECURITY CONTRACT (DESIGN.md §5.1): structured JSON requests on stdin, one
// JSON response per line on stdout. Untrusted fields are only ever used as
// typed Contacts.framework API arguments. No script text, no shell.
//
// Its own TCC subject: macOS prompts for Contacts access on the first data
// operation; the grant is revocable for this binary alone.
//
// The contact "note" field is deliberately NOT read or written — it requires
// the com.apple.developer.contacts.notes entitlement.
//
// Wire protocol: identical to eventkit-helper (see native/README.md).

import Contacts
import Foundation

// MARK: - Wire types

struct Envelope: Decodable {
    let id: Int
    let op: String
}

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

struct ErrorBody: Encodable {
    let code: String
    let message: String
    let hint: String?
}

struct OkResponse: Encodable {
    let id: Int
    let ok = true
    let data: AnyEncodable
}

struct ErrResponse: Encodable {
    let id: Int
    let ok = false
    let error: ErrorBody
}

enum HelperError: Error {
    case permissionDenied(String, hint: String)
    case notFound(String)
    case invalidRequest(String)
}

// MARK: - DTOs

struct LabeledValue: Encodable, Decodable {
    let label: String?
    let value: String
}

struct ContactDTO: Encodable {
    let id: String
    let givenName: String
    let familyName: String
    let fullName: String
    let organization: String?
    let emails: [LabeledValue]
    let phones: [LabeledValue]
}

struct PongDTO: Encodable { let pong: Bool; let version: String }

let FETCH_KEYS: [CNKeyDescriptor] = [
    CNContactIdentifierKey as CNKeyDescriptor,
    CNContactGivenNameKey as CNKeyDescriptor,
    CNContactFamilyNameKey as CNKeyDescriptor,
    CNContactOrganizationNameKey as CNKeyDescriptor,
    CNContactEmailAddressesKey as CNKeyDescriptor,
    CNContactPhoneNumbersKey as CNKeyDescriptor,
    CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
]

func cleanLabel(_ label: String?) -> String? {
    guard let label else { return nil }
    return CNLabeledValue<NSString>.localizedString(forLabel: label)
}

func contactDTO(_ c: CNContact) -> ContactDTO {
    ContactDTO(
        id: c.identifier,
        givenName: c.givenName,
        familyName: c.familyName,
        fullName: CNContactFormatter.string(from: c, style: .fullName) ?? "",
        organization: c.organizationName.isEmpty ? nil : c.organizationName,
        emails: c.emailAddresses.map {
            LabeledValue(label: cleanLabel($0.label), value: $0.value as String)
        },
        phones: c.phoneNumbers.map {
            LabeledValue(label: cleanLabel($0.label), value: $0.value.stringValue)
        }
    )
}

// MARK: - Args

struct SearchArgs: Decodable {
    let query: String
    let limit: Int?
}

struct IdArgs: Decodable { let id: String }

struct CreateContactArgs: Decodable {
    let givenName: String
    let familyName: String?
    let organization: String?
    let emails: [LabeledValue]?
    let phones: [LabeledValue]?
}

// MARK: - Helper core

final class Helper {
    let store = CNContactStore()
    private var granted = false

    static let permissionHint =
        "Grant access in System Settings → Privacy & Security → Contacts "
        + "(the subject is the contacts-helper binary), then retry."

    func ensureAccess() async throws {
        if granted { return }
        let ok = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            store.requestAccess(for: .contacts) { ok, _ in cont.resume(returning: ok) }
        }
        guard ok else {
            throw HelperError.permissionDenied(
                "Contacts access is not granted", hint: Helper.permissionHint)
        }
        granted = true
    }

    func search(_ args: SearchArgs) async throws -> [ContactDTO] {
        try await ensureAccess()
        guard !args.query.isEmpty else {
            throw HelperError.invalidRequest("query must not be empty")
        }
        let limit = min(max(args.limit ?? 25, 1), 200)
        let predicate = CNContact.predicateForContacts(matchingName: args.query)
        let contacts = try store.unifiedContacts(matching: predicate, keysToFetch: FETCH_KEYS)
        return contacts.prefix(limit).map(contactDTO)
    }

    func get(_ args: IdArgs) async throws -> ContactDTO {
        try await ensureAccess()
        do {
            let c = try store.unifiedContact(withIdentifier: args.id, keysToFetch: FETCH_KEYS)
            return contactDTO(c)
        } catch {
            throw HelperError.notFound("contact \(args.id) not found")
        }
    }

    func create(_ args: CreateContactArgs) async throws -> ContactDTO {
        try await ensureAccess()
        let contact = CNMutableContact()
        contact.givenName = args.givenName
        contact.familyName = args.familyName ?? ""
        contact.organizationName = args.organization ?? ""
        contact.emailAddresses = (args.emails ?? []).map {
            CNLabeledValue(label: $0.label ?? CNLabelHome, value: $0.value as NSString)
        }
        contact.phoneNumbers = (args.phones ?? []).map {
            CNLabeledValue(label: $0.label ?? CNLabelPhoneNumberMain,
                           value: CNPhoneNumber(stringValue: $0.value))
        }
        let save = CNSaveRequest()
        save.add(contact, toContainerWithIdentifier: nil)
        try store.execute(save)
        return try await get(IdArgs(id: contact.identifier))
    }
}

// MARK: - Dispatch

let decoder = JSONDecoder()
let encoder = JSONEncoder()

func decodeArgs<T: Decodable>(_ data: Data, _ type: T.Type) throws -> T {
    do {
        return try decoder.decode(RequestBody<T>.self, from: data).args
    } catch {
        throw HelperError.invalidRequest("bad args: \(error.localizedDescription)")
    }
}

func handle(line: String, helper: Helper) async -> Data {
    guard let data = line.data(using: .utf8) else {
        return encodeError(id: 0, code: "invalid_request", message: "non-UTF8 input", hint: nil)
    }
    let envelope: Envelope
    do {
        envelope = try decoder.decode(Envelope.self, from: data)
    } catch {
        return encodeError(id: 0, code: "invalid_request", message: "malformed request envelope", hint: nil)
    }

    do {
        let result: AnyEncodable
        switch envelope.op {
        case "ping":
            result = AnyEncodable(PongDTO(pong: true, version: "1.0.0"))
        case "contacts.search":
            result = AnyEncodable(try await helper.search(decodeArgs(data, SearchArgs.self)))
        case "contacts.get":
            result = AnyEncodable(try await helper.get(decodeArgs(data, IdArgs.self)))
        case "contacts.create":
            result = AnyEncodable(try await helper.create(decodeArgs(data, CreateContactArgs.self)))
        default:
            return encodeError(
                id: envelope.id, code: "invalid_request",
                message: "unknown op \(envelope.op)", hint: nil)
        }
        return (try? encoder.encode(OkResponse(id: envelope.id, data: result)))
            ?? encodeError(id: envelope.id, code: "internal", message: "encoding failure", hint: nil)
    } catch let err as HelperError {
        switch err {
        case .permissionDenied(let msg, let hint):
            return encodeError(id: envelope.id, code: "permission_denied", message: msg, hint: hint)
        case .notFound(let msg):
            return encodeError(id: envelope.id, code: "not_found", message: msg, hint: nil)
        case .invalidRequest(let msg):
            return encodeError(id: envelope.id, code: "invalid_request", message: msg, hint: nil)
        }
    } catch {
        return encodeError(id: envelope.id, code: "internal", message: error.localizedDescription, hint: nil)
    }
}

func encodeError(id: Int, code: String, message: String, hint: String?) -> Data {
    let resp = ErrResponse(id: id, error: ErrorBody(code: code, message: message, hint: hint))
    return (try? encoder.encode(resp)) ?? Data("{\"id\":0,\"ok\":false}".utf8)
}

// MARK: - Main loop (top-level code)

guard CommandLine.arguments.dropFirst() == ["--json-stdin"] else {
    FileHandle.standardError.write(Data("usage: contacts-helper --json-stdin\n".utf8))
    exit(2)
}

let helper = Helper()
let newline = Data("\n".utf8)
while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    let out = await handle(line: line, helper: helper)
    FileHandle.standardOutput.write(out + newline)
}
