/**
 * Reminders module (EventKit via eventkit-helper). Shares the resident
 * helper process with the calendar module; deletion goes through
 * elicitation confirmation (`*.delete`).
 */

import { z } from "zod";
import { type HelperClient, sharedEventKitClient } from "../../native/eventkit.ts";
import type { AppModule, Mode, ResourceDef, ToolDef } from "../_template/module.ts";
import {
  CreateReminderInput,
  ListRemindersInput,
  ReminderIdInput,
  ReminderListOut,
  ReminderOut,
  serializeCompleteReminder,
  serializeCreateReminder,
  serializeDeleteReminder,
  serializeListLists,
  serializeListReminders,
} from "./backend.ts";

export function createRemindersModule(client: HelperClient = sharedEventKitClient()): AppModule {
  const call = <T>(req: { op: string; args: Record<string, unknown> }) =>
    client.call<T>(req.op, req.args);

  const readTools: ToolDef[] = [
    {
      name: "reminders_list_lists",
      title: "List reminder lists",
      description:
        "List the user's reminder lists (id, title). Use the ids with " +
        "reminders_list and reminders_create.",
      inputSchema: {},
      outputSchema: { lists: z.array(ReminderListOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "reminders.list",
      annotations: { idempotentHint: true },
      run: async () => ({ lists: await call(serializeListLists()), _untrusted: true }),
    },
    {
      name: "reminders_list",
      title: "List reminders",
      description:
        "List reminders (open ones by default), optionally within a single " +
        "list. Returns reminder ids needed by reminders_complete / " +
        "reminders_delete. Does NOT list calendar events — use " +
        "calendar_list_events for those.",
      inputSchema: ListRemindersInput.shape,
      outputSchema: { reminders: z.array(ReminderOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "reminders.list",
      annotations: { idempotentHint: true },
      run: async (input) => ({
        reminders: await call(serializeListReminders(input)),
        _untrusted: true,
      }),
    },
  ];

  const writeTools: ToolDef[] = [
    {
      name: "reminders_create",
      title: "Create reminder",
      description:
        "Create a reminder with optional due date, notes, and priority. " +
        "Returns the created reminder with its id. Defaults to the user's " +
        "default list unless listId is given.",
      inputSchema: CreateReminderInput.shape,
      outputSchema: { reminder: ReminderOut },
      mode: "write",
      actionId: "reminders.create",
      annotations: { destructiveHint: false },
      run: async (input) => ({ reminder: await call(serializeCreateReminder(input)) }),
    },
    {
      name: "reminders_complete",
      title: "Complete reminder",
      description: "Mark a reminder as completed by id. Get ids from reminders_list.",
      inputSchema: ReminderIdInput.shape,
      outputSchema: { reminder: ReminderOut },
      mode: "write",
      actionId: "reminders.complete",
      annotations: { destructiveHint: false, idempotentHint: true },
      run: async (input) => ({ reminder: await call(serializeCompleteReminder(input)) }),
    },
    {
      name: "reminders_delete",
      title: "Delete reminder",
      description:
        "Permanently delete a reminder by id. Asks the user for confirmation " +
        "before executing.",
      inputSchema: ReminderIdInput.shape,
      outputSchema: { deleted: z.boolean() },
      mode: "write",
      actionId: "reminders.delete",
      annotations: { idempotentHint: true },
      confirmPreview: (input) => `Delete reminder ${String(input["id"])}`,
      run: async (input) => await call<{ deleted: boolean }>(serializeDeleteReminder(input)),
    },
  ];

  const resources: ResourceDef[] = [
    {
      uriTemplate: "reminders://lists",
      name: "reminders-lists",
      title: "Reminder lists",
      description: "The user's reminder lists as JSON.",
      read: async () => await call(serializeListLists()),
    },
    {
      uriTemplate: "reminders://reminders",
      name: "reminders-reminders",
      title: "Open reminders",
      description:
        "Open (incomplete) reminders across all lists, as JSON. To filter by " +
        "list or include completed ones, use the reminders_list tool.",
      read: async () => await call(serializeListReminders({})),
    },
  ];

  return {
    id: "reminders",
    resources: () => resources,
    tools: (mode: Mode) => (mode === "write" ? [...readTools, ...writeTools] : readTools),
  };
}
