/**
 * Reminders backend — the serialization boundary to the native
 * eventkit-helper. Same security contract as the calendar backend
 * (structured JSON on stdin, no script text — see DESIGN.md §5.1); the
 * injection regression suite pins both.
 */

import { z } from "zod";

const isoDateTime = () => z.iso.datetime({ offset: true });

export const ListRemindersInput = z.object({
  listId: z
    .string()
    .max(200)
    .optional()
    .describe("Restrict to one reminder list (id from reminders_list_lists). Default: all lists."),
  includeCompleted: z
    .boolean()
    .default(false)
    .describe("Include completed reminders. Default: only open ones."),
  limit: z.number().int().min(1).max(500).default(50).describe("Max reminders returned. Hard cap 500."),
});

export const CreateReminderInput = z.object({
  title: z.string().min(1).max(1000).describe("Reminder title."),
  listId: z
    .string()
    .max(200)
    .optional()
    .describe("Target list id. Default: the user's default reminder list."),
  due: isoDateTime().optional().describe("Due date-time (ISO 8601)."),
  notes: z.string().max(10_000).optional().describe("Free-form notes."),
  priority: z
    .enum(["none", "low", "medium", "high"])
    .default("none")
    .describe("Reminder priority."),
});
export type CreateReminderInput = z.infer<typeof CreateReminderInput>;

export const ReminderIdInput = z.object({
  id: z.string().min(1).max(300).describe("Reminder id (from reminders_list)."),
});

export interface HelperRequest {
  op: string;
  args: Record<string, unknown>;
}

export function serializeListReminders(input: unknown): HelperRequest {
  return { op: "reminders.list", args: ListRemindersInput.parse(input) };
}

export function serializeCreateReminder(input: unknown): HelperRequest {
  return { op: "reminders.create", args: CreateReminderInput.parse(input) };
}

export function serializeCompleteReminder(input: unknown): HelperRequest {
  return { op: "reminders.complete", args: ReminderIdInput.parse(input) };
}

export function serializeDeleteReminder(input: unknown): HelperRequest {
  return { op: "reminders.delete", args: ReminderIdInput.parse(input) };
}

export function serializeListLists(): HelperRequest {
  return { op: "reminders.list_lists", args: {} };
}

/* Output shapes */

export const ReminderListOut = z.object({
  id: z.string(),
  title: z.string(),
  editable: z.boolean(),
  kind: z.enum(["event", "reminder"]),
});

export const ReminderOut = z.object({
  id: z.string(),
  title: z.string(),
  listId: z.string(),
  listTitle: z.string(),
  completed: z.boolean(),
  due: z.string().optional(),
  notes: z.string().optional(),
  priority: z.enum(["none", "low", "medium", "high"]),
});
