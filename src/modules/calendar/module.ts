/**
 * Calendar module (EventKit via eventkit-helper). Read tools/resources are
 * always available when the module is enabled; write tools only in write
 * mode; deletion goes through elicitation confirmation (`*.delete`).
 */

import { z } from "zod";
import { type HelperClient, sharedEventKitClient } from "../../native/eventkit.ts";
import type { AppModule, Mode, ResourceDef, ToolDef } from "../_template/module.ts";
import {
  CalendarOut,
  CreateEventInput,
  DeleteEventInput,
  EventOut,
  ListEventsInput,
  UpdateEventInput,
  serializeCreateEvent,
  serializeDeleteEvent,
  serializeListCalendars,
  serializeListEvents,
  serializeUpdateEvent,
} from "./backend.ts";

export function createCalendarModule(client: HelperClient = sharedEventKitClient()): AppModule {
  const call = <T>(req: { op: string; args: Record<string, unknown> }, signal?: AbortSignal) =>
    client.call<T>(req.op, req.args, signal);

  const readTools: ToolDef[] = [
    {
      name: "calendar_list_calendars",
      title: "List calendars",
      description:
        "List the user's calendars (id, title, editability). Use the ids with " +
        "calendar_list_events and calendar_create_event.",
      inputSchema: {},
      outputSchema: { calendars: z.array(CalendarOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "calendar.list",
      annotations: { idempotentHint: true },
      run: async () => ({
        calendars: await call(serializeListCalendars()),
        _untrusted: true,
      }),
    },
    {
      name: "calendar_list_events",
      title: "List events",
      description:
        "List events in a time range, sorted by start time. Returns event ids " +
        "needed by calendar_update_event / calendar_delete_event. Does NOT " +
        "search reminders — use reminders_list for those.",
      inputSchema: ListEventsInput.shape,
      outputSchema: { events: z.array(EventOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "calendar.list",
      annotations: { idempotentHint: true },
      run: async (input, ctx) => ({
        events: await call(serializeListEvents(input), ctx?.signal),
        _untrusted: true,
      }),
    },
  ];

  const writeTools: ToolDef[] = [
    {
      name: "calendar_create_event",
      title: "Create event",
      description:
        "Create a calendar event. Returns the created event with its id. " +
        "Defaults to the user's default calendar unless calendarId is given.",
      inputSchema: CreateEventInput.shape,
      outputSchema: { event: EventOut },
      mode: "write",
      actionId: "calendar.create",
      annotations: { destructiveHint: false },
      run: async (input) => ({ event: await call(serializeCreateEvent(input)) }),
    },
    {
      name: "calendar_update_event",
      title: "Update event",
      description:
        "Update fields of an existing event by id. Only the provided fields " +
        "change. Get ids from calendar_list_events.",
      inputSchema: UpdateEventInput.shape,
      outputSchema: { event: EventOut },
      mode: "write",
      actionId: "calendar.update",
      run: async (input) => ({ event: await call(serializeUpdateEvent(input)) }),
    },
    {
      name: "calendar_delete_event",
      title: "Delete event",
      description:
        "Permanently delete a calendar event by id. Asks the user for " +
        "confirmation before executing.",
      inputSchema: DeleteEventInput.shape,
      outputSchema: { deleted: z.boolean() },
      mode: "write",
      actionId: "calendar.delete",
      annotations: { idempotentHint: true },
      confirmPreview: (input) => `Delete calendar event ${String(input["id"])}`,
      run: async (input) => await call<{ deleted: boolean }>(serializeDeleteEvent(input)),
    },
  ];

  const resources: ResourceDef[] = [
    {
      uriTemplate: "calendar://calendars",
      name: "calendar-calendars",
      title: "Calendars",
      description: "The user's calendars as JSON.",
      read: async () => await call(serializeListCalendars()),
    },
    {
      uriTemplate: "calendar://events",
      name: "calendar-events",
      title: "Calendar events (next 7 days)",
      description:
        "Events from now through the next 7 days, as JSON. For an arbitrary " +
        "range use the calendar_list_events tool.",
      read: async () => {
        const now = new Date();
        const week = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
        return await call(
          serializeListEvents({ from: now.toISOString(), to: week.toISOString() }),
        );
      },
    },
  ];

  return {
    id: "calendar",
    resources: () => resources,
    tools: (mode: Mode) => (mode === "write" ? [...readTools, ...writeTools] : readTools),
  };
}
