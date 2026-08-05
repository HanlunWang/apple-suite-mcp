/**
 * Calendar backend — the serialization boundary to the native eventkit-helper.
 *
 * SECURITY (DESIGN.md §5.1): this file is the only place calendar data crosses
 * from the MCP server toward the OS. Untrusted fields travel as STRUCTURED
 * JSON on the helper's stdin. They are never concatenated into AppleScript,
 * shell text, or argv. The helper (native/eventkit-helper) consumes the
 * payload with typed EventKit APIs — there is no script text anywhere on this
 * path, so there is nothing to inject into.
 *
 * Content is validated for SHAPE (types, lengths, date format) but never
 * "escaped" or rewritten — escaping-based sanitization is exactly the
 * upstream bug class this project exists to eliminate.
 *
 * The injection regression suite (tests/injection/) pins this contract.
 */

import { z } from "zod";
import type { HelperRequest } from "../_template/module.ts";
import { EVENTKIT_HELPER_ARGV, EVENTKIT_HELPER_BIN } from "../../native/eventkit.ts";

const isoDateTime = () => z.iso.datetime({ offset: true });

export const ListEventsInput = z.object({
  from: isoDateTime().describe("Range start (ISO 8601, e.g. 2026-01-01T00:00:00Z)."),
  to: isoDateTime().describe("Range end (ISO 8601). Must be after `from`."),
  calendarIds: z
    .array(z.string().max(200))
    .max(50)
    .optional()
    .describe("Restrict to these calendar ids (from calendar_list_calendars). Default: all."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe("Max events returned, sorted by start time. Hard cap 500."),
});

export const CreateEventInput = z.object({
  title: z.string().min(1).max(1000).describe("Event title."),
  start: isoDateTime().describe("Start time (ISO 8601)."),
  end: isoDateTime().describe("End time (ISO 8601). Must be after `start`."),
  calendarId: z
    .string()
    .max(200)
    .optional()
    .describe("Target calendar id. Default: the user's default calendar."),
  location: z.string().max(1000).optional().describe("Event location."),
  notes: z.string().max(10_000).optional().describe("Free-form notes."),
  allDay: z.boolean().default(false).describe("All-day event."),
});
export type CreateEventInput = z.infer<typeof CreateEventInput>;

export const UpdateEventInput = z.object({
  id: z.string().min(1).max(300).describe("Event id (from calendar_list_events)."),
  title: z.string().min(1).max(1000).optional(),
  start: isoDateTime().optional(),
  end: isoDateTime().optional(),
  location: z.string().max(1000).optional(),
  notes: z.string().max(10_000).optional(),
});

export const DeleteEventInput = z.object({
  id: z.string().min(1).max(300).describe("Event id to delete (from calendar_list_events)."),
});

/** Structured request sent to the helper. Pure data — no executable text. */
export type { HelperRequest };

export function serializeListEvents(input: unknown): HelperRequest {
  return { op: "calendar.list_events", args: ListEventsInput.parse(input) };
}

export function serializeCreateEvent(input: unknown): HelperRequest {
  return { op: "calendar.create_event", args: CreateEventInput.parse(input) };
}

export function serializeUpdateEvent(input: unknown): HelperRequest {
  return { op: "calendar.update_event", args: UpdateEventInput.parse(input) };
}

export function serializeDeleteEvent(input: unknown): HelperRequest {
  return { op: "calendar.delete_event", args: DeleteEventInput.parse(input) };
}

export function serializeListCalendars(): HelperRequest {
  return { op: "calendar.list_calendars", args: {} };
}

/** A helper invocation: fixed binary, fixed argv, data only on stdin. */
export interface HelperInvocation {
  command: string;
  argv: readonly string[];
  /** JSON payload written to the helper's stdin. */
  stdin: string;
}

export function buildHelperInvocation(request: HelperRequest): HelperInvocation {
  return {
    command: EVENTKIT_HELPER_BIN,
    argv: EVENTKIT_HELPER_ARGV,
    stdin: JSON.stringify(request),
  };
}

/* ------------------------------------------------------------------ */
/* Output shapes (helper responses, surfaced via tool outputSchema)    */
/* ------------------------------------------------------------------ */

export const CalendarOut = z.object({
  id: z.string(),
  title: z.string(),
  editable: z.boolean(),
  kind: z.enum(["event", "reminder"]),
});

export const EventOut = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  calendarId: z.string(),
  calendarTitle: z.string(),
  location: z.string().optional(),
  notes: z.string().optional(),
});
export type EventOut = z.infer<typeof EventOut>;
