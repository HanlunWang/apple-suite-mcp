/**
 * Notes backend — serialization boundary to the fixed JXA template
 * (native/notes-jxa/notes.js). Content crosses as parsed JSON data; the
 * template never changes per request (DESIGN.md §5.1). Body text is carried
 * verbatim here — the presentation-layer HTML escaping happens inside the
 * fixed template, not in this transport layer.
 */

import { z } from "zod";

export const ListNotesInput = z.object({
  folderName: z
    .string()
    .max(300)
    .optional()
    .describe("Restrict to one folder (name from notes_list_folders). Default: all notes."),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("Max notes returned. Hard cap 200."),
});

export const SearchNotesInput = z.object({
  query: z.string().min(1).max(500).describe("Text to find in note titles or bodies."),
  limit: z.coerce.number().int().min(1).max(200).default(25).describe("Max results. Hard cap 200."),
});

export const GetNoteInput = z.object({
  id: z.string().min(1).max(500).describe("Note id (from notes_list / notes_search)."),
});

export const CreateNoteInput = z.object({
  title: z.string().min(1).max(1000).describe("Note title (becomes the first line)."),
  body: z
    .string()
    .max(100_000)
    .default("")
    .describe("Plain-text body. Rendered as text — HTML is not interpreted."),
  folderName: z
    .string()
    .max(300)
    .optional()
    .describe("Target folder name. Default: the default account's notes."),
});
export type CreateNoteInput = z.infer<typeof CreateNoteInput>;

export interface HelperRequest {
  op: string;
  args: Record<string, unknown>;
}

export function serializeListFolders(): HelperRequest {
  return { op: "notes.list_folders", args: {} };
}

export function serializeListNotes(input: unknown): HelperRequest {
  return { op: "notes.list", args: ListNotesInput.parse(input) };
}

export function serializeSearchNotes(input: unknown): HelperRequest {
  return { op: "notes.search", args: SearchNotesInput.parse(input) };
}

export function serializeGetNote(input: unknown): HelperRequest {
  return { op: "notes.get", args: GetNoteInput.parse(input) };
}

export function serializeCreateNote(input: unknown): HelperRequest {
  return { op: "notes.create", args: CreateNoteInput.parse(input) };
}

/* Output shapes */

export const FolderOut = z.object({ id: z.string(), name: z.string() });

export const NoteMetaOut = z.object({
  id: z.string(),
  name: z.string(),
  folder: z.string().nullable(),
  modified: z.string().nullable().optional(),
});

export const NoteOut = NoteMetaOut.extend({
  plaintext: z.string(),
});
