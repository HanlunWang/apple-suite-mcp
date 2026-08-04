// eventkit-helper — native backend for the calendar and reminders modules.
//
// SECURITY CONTRACT (DESIGN.md §5.1): this process receives STRUCTURED JSON
// requests on stdin (one per line) and writes one JSON response per line to
// stdout. Untrusted fields are only ever used as typed EventKit API arguments.
// There is no script text and no shell anywhere in this program.
//
// It is its own TCC subject: macOS prompts for Calendar/Reminders access the
// first time a data operation runs, and the grant can be revoked for this
// binary alone in System Settings.
//
// Wire protocol (NDJSON):
//   request:  {"id": 1, "op": "calendar.list_events", "args": {...}}
//   success:  {"id": 1, "ok": true, "data": ...}
//   failure:  {"id": 1, "ok": false, "error": {"code", "message", "hint"?}}
//
// The "ping" op never touches EventKit (used by CI and health checks).

import EventKit
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

// MARK: - Dates

let isoFormatterFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

func parseDate(_ s: String, field: String) throws -> Date {
    if let d = isoFormatter.date(from: s) { return d }
    if let d = isoFormatterFractional.date(from: s) { return d }
    throw HelperError.invalidRequest("\(field) is not an ISO 8601 date-time: \(s)")
}

func formatDate(_ d: Date) -> String { isoFormatter.string(from: d) }

// MARK: - DTOs

struct CalendarDTO: Encodable {
    let id: String
    let title: String
    let editable: Bool
    let kind: String  // "event" | "reminder"
}

struct EventDTO: Encodable {
    let id: String
    let title: String
    let start: String
    let end: String
    let allDay: Bool
    let calendarId: String
    let calendarTitle: String
    let location: String?
    let notes: String?
}

struct ReminderDTO: Encodable {
    let id: String
    let title: String
    let listId: String
    let listTitle: String
    let completed: Bool
    let due: String?
    let notes: String?
    let priority: String  // "none" | "high" | "medium" | "low"
}

struct DeletedDTO: Encodable { let deleted: Bool }
struct PongDTO: Encodable { let pong: Bool; let version: String }

func eventDTO(_ e: EKEvent) -> EventDTO {
    EventDTO(
        id: e.eventIdentifier ?? "",
        title: e.title ?? "",
        start: formatDate(e.startDate),
        end: formatDate(e.endDate),
        allDay: e.isAllDay,
        calendarId: e.calendar?.calendarIdentifier ?? "",
        calendarTitle: e.calendar?.title ?? "",
        location: e.location,
        notes: e.notes
    )
}

func priorityName(_ p: Int) -> String {
    switch p {
    case 0: return "none"
    case 1...4: return "high"
    case 5: return "medium"
    default: return "low"
    }
}

func priorityValue(_ name: String) throws -> Int {
    switch name {
    case "none": return 0
    case "high": return 1
    case "medium": return 5
    case "low": return 9
    default: throw HelperError.invalidRequest("priority must be none|high|medium|low")
    }
}

func reminderDTO(_ r: EKReminder) -> ReminderDTO {
    let due = r.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
    return ReminderDTO(
        id: r.calendarItemIdentifier,
        title: r.title ?? "",
        listId: r.calendar?.calendarIdentifier ?? "",
        listTitle: r.calendar?.title ?? "",
        completed: r.isCompleted,
        due: due.map(formatDate),
        notes: r.notes,
        priority: priorityName(r.priority)
    )
}

// MARK: - Args

struct ListEventsArgs: Decodable {
    let from: String
    let to: String
    let calendarIds: [String]?
    let limit: Int?
}

struct CreateEventArgs: Decodable {
    let title: String
    let start: String
    let end: String
    let calendarId: String?
    let location: String?
    let notes: String?
    let allDay: Bool?
}

struct UpdateEventArgs: Decodable {
    let id: String
    let title: String?
    let start: String?
    let end: String?
    let location: String?
    let notes: String?
}

struct IdArgs: Decodable { let id: String }

struct ListRemindersArgs: Decodable {
    let listId: String?
    let includeCompleted: Bool?
    let limit: Int?
}

struct CreateReminderArgs: Decodable {
    let title: String
    let listId: String?
    let due: String?
    let notes: String?
    let priority: String?
}

struct EmptyArgs: Decodable {}

// MARK: - Helper core

final class Helper {
    let store = EKEventStore()
    private var eventsGranted = false
    private var remindersGranted = false

    static let permissionHint =
        "Grant access in System Settings → Privacy & Security → Calendars/Reminders "
        + "(the subject is the eventkit-helper binary), then retry."

    func ensureEventsAccess() async throws {
        if eventsGranted { return }
        let granted = (try? await store.requestFullAccessToEvents()) ?? false
        guard granted else {
            throw HelperError.permissionDenied(
                "Calendar access is not granted", hint: Helper.permissionHint)
        }
        eventsGranted = true
    }

    func ensureRemindersAccess() async throws {
        if remindersGranted { return }
        let granted = (try? await store.requestFullAccessToReminders()) ?? false
        guard granted else {
            throw HelperError.permissionDenied(
                "Reminders access is not granted", hint: Helper.permissionHint)
        }
        remindersGranted = true
    }

    // MARK: Calendar ops

    func listCalendars() async throws -> [CalendarDTO] {
        try await ensureEventsAccess()
        return store.calendars(for: .event).map {
            CalendarDTO(
                id: $0.calendarIdentifier, title: $0.title,
                editable: $0.allowsContentModifications, kind: "event")
        }
    }

    func listEvents(_ args: ListEventsArgs) async throws -> [EventDTO] {
        try await ensureEventsAccess()
        let from = try parseDate(args.from, field: "from")
        let to = try parseDate(args.to, field: "to")
        var calendars: [EKCalendar]? = nil
        if let ids = args.calendarIds, !ids.isEmpty {
            calendars = store.calendars(for: .event).filter { ids.contains($0.calendarIdentifier) }
        }
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
        let limit = min(max(args.limit ?? 50, 1), 500)
        let events = store.events(matching: predicate)
            .sorted { $0.startDate < $1.startDate }
            .prefix(limit)
        return events.map(eventDTO)
    }

    func createEvent(_ args: CreateEventArgs) async throws -> EventDTO {
        try await ensureEventsAccess()
        let event = EKEvent(eventStore: store)
        event.title = args.title
        event.startDate = try parseDate(args.start, field: "start")
        event.endDate = try parseDate(args.end, field: "end")
        event.isAllDay = args.allDay ?? false
        event.location = args.location
        event.notes = args.notes
        if let calId = args.calendarId {
            guard let cal = store.calendar(withIdentifier: calId), cal.allowedEntityTypes.contains(.event) else {
                throw HelperError.notFound("calendar \(calId) not found")
            }
            event.calendar = cal
        } else {
            guard let cal = store.defaultCalendarForNewEvents else {
                throw HelperError.invalidRequest("no default calendar; pass calendarId")
            }
            event.calendar = cal
        }
        try store.save(event, span: .thisEvent, commit: true)
        return eventDTO(event)
    }

    func updateEvent(_ args: UpdateEventArgs) async throws -> EventDTO {
        try await ensureEventsAccess()
        guard let event = store.event(withIdentifier: args.id) else {
            throw HelperError.notFound("event \(args.id) not found")
        }
        if let t = args.title { event.title = t }
        if let s = args.start { event.startDate = try parseDate(s, field: "start") }
        if let e = args.end { event.endDate = try parseDate(e, field: "end") }
        if let l = args.location { event.location = l }
        if let n = args.notes { event.notes = n }
        try store.save(event, span: .thisEvent, commit: true)
        return eventDTO(event)
    }

    func deleteEvent(_ args: IdArgs) async throws -> DeletedDTO {
        try await ensureEventsAccess()
        guard let event = store.event(withIdentifier: args.id) else {
            throw HelperError.notFound("event \(args.id) not found")
        }
        try store.remove(event, span: .thisEvent, commit: true)
        return DeletedDTO(deleted: true)
    }

    // MARK: Reminder ops

    func listReminderLists() async throws -> [CalendarDTO] {
        try await ensureRemindersAccess()
        return store.calendars(for: .reminder).map {
            CalendarDTO(
                id: $0.calendarIdentifier, title: $0.title,
                editable: $0.allowsContentModifications, kind: "reminder")
        }
    }

    private func fetchReminders(matching predicate: NSPredicate) async -> [EKReminder] {
        await withCheckedContinuation { cont in
            store.fetchReminders(matching: predicate) { cont.resume(returning: $0 ?? []) }
        }
    }

    func listReminders(_ args: ListRemindersArgs) async throws -> [ReminderDTO] {
        try await ensureRemindersAccess()
        var calendars: [EKCalendar]? = nil
        if let listId = args.listId {
            guard let cal = store.calendar(withIdentifier: listId) else {
                throw HelperError.notFound("reminder list \(listId) not found")
            }
            calendars = [cal]
        }
        let predicate = store.predicateForReminders(in: calendars)
        let limit = min(max(args.limit ?? 50, 1), 500)
        let includeCompleted = args.includeCompleted ?? false
        return await fetchReminders(matching: predicate)
            .filter { includeCompleted || !$0.isCompleted }
            .prefix(limit)
            .map(reminderDTO)
    }

    func createReminder(_ args: CreateReminderArgs) async throws -> ReminderDTO {
        try await ensureRemindersAccess()
        let reminder = EKReminder(eventStore: store)
        reminder.title = args.title
        reminder.notes = args.notes
        if let p = args.priority { reminder.priority = try priorityValue(p) }
        if let due = args.due {
            let date = try parseDate(due, field: "due")
            reminder.dueDateComponents = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second], from: date)
        }
        if let listId = args.listId {
            guard let cal = store.calendar(withIdentifier: listId), cal.allowedEntityTypes.contains(.reminder) else {
                throw HelperError.notFound("reminder list \(listId) not found")
            }
            reminder.calendar = cal
        } else {
            guard let cal = store.defaultCalendarForNewReminders() else {
                throw HelperError.invalidRequest("no default reminder list; pass listId")
            }
            reminder.calendar = cal
        }
        try store.save(reminder, commit: true)
        return reminderDTO(reminder)
    }

    private func reminder(withId id: String) throws -> EKReminder {
        guard let item = store.calendarItem(withIdentifier: id) as? EKReminder else {
            throw HelperError.notFound("reminder \(id) not found")
        }
        return item
    }

    func completeReminder(_ args: IdArgs) async throws -> ReminderDTO {
        try await ensureRemindersAccess()
        let reminder = try reminder(withId: args.id)
        reminder.isCompleted = true
        try store.save(reminder, commit: true)
        return reminderDTO(reminder)
    }

    func deleteReminder(_ args: IdArgs) async throws -> DeletedDTO {
        try await ensureRemindersAccess()
        let reminder = try reminder(withId: args.id)
        try store.remove(reminder, commit: true)
        return DeletedDTO(deleted: true)
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
            result = AnyEncodable(PongDTO(pong: true, version: "0.1.0"))
        case "calendar.list_calendars":
            result = AnyEncodable(try await helper.listCalendars())
        case "calendar.list_events":
            result = AnyEncodable(try await helper.listEvents(decodeArgs(data, ListEventsArgs.self)))
        case "calendar.create_event":
            result = AnyEncodable(try await helper.createEvent(decodeArgs(data, CreateEventArgs.self)))
        case "calendar.update_event":
            result = AnyEncodable(try await helper.updateEvent(decodeArgs(data, UpdateEventArgs.self)))
        case "calendar.delete_event":
            result = AnyEncodable(try await helper.deleteEvent(decodeArgs(data, IdArgs.self)))
        case "reminders.list_lists":
            result = AnyEncodable(try await helper.listReminderLists())
        case "reminders.list":
            result = AnyEncodable(try await helper.listReminders(decodeArgs(data, ListRemindersArgs.self)))
        case "reminders.create":
            result = AnyEncodable(try await helper.createReminder(decodeArgs(data, CreateReminderArgs.self)))
        case "reminders.complete":
            result = AnyEncodable(try await helper.completeReminder(decodeArgs(data, IdArgs.self)))
        case "reminders.delete":
            result = AnyEncodable(try await helper.deleteReminder(decodeArgs(data, IdArgs.self)))
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

// Fixed argv contract: the server always invokes this helper as
// `eventkit-helper --json-stdin`. Reject anything else so the binary cannot
// be repurposed with data-carrying arguments.
guard CommandLine.arguments.dropFirst() == ["--json-stdin"] else {
    FileHandle.standardError.write(Data("usage: eventkit-helper --json-stdin\n".utf8))
    exit(2)
}

let helper = Helper()
let newline = Data("\n".utf8)
while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    let out = await handle(line: line, helper: helper)
    FileHandle.standardOutput.write(out + newline)
}
