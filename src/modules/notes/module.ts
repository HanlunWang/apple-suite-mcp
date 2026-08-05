/**
 * Notes module (JXA fixed-template backend via osascript). Read tools when
 * enabled; create only in write mode.
 */

import { z } from "zod";
import type { HelperClient } from "../../native/client.ts";
import { sharedNotesClient } from "../../native/notes.ts";
import type { AppModule, Mode, ResourceDef, ToolDef } from "../_template/module.ts";
import {
  CreateNoteInput,
  FolderOut,
  GetNoteInput,
  ListNotesInput,
  NoteMetaOut,
  NoteOut,
  SearchNotesInput,
  serializeCreateNote,
  serializeGetNote,
  serializeListFolders,
  serializeListNotes,
  serializeSearchNotes,
} from "./backend.ts";

export function createNotesModule(client: HelperClient = sharedNotesClient()): AppModule {
  const call = <T>(req: { op: string; args: Record<string, unknown> }, signal?: AbortSignal) =>
    client.call<T>(req.op, req.args, signal);

  const readTools: ToolDef[] = [
    {
      name: "notes_list_folders",
      title: "List note folders",
      description: "List the user's Notes folders (id, name).",
      inputSchema: {},
      outputSchema: { folders: z.array(FolderOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "notes.list",
      annotations: { idempotentHint: true },
      run: async () => ({ folders: await call(serializeListFolders()), _untrusted: true }),
    },
    {
      name: "notes_list",
      title: "List notes",
      description:
        "List notes (title + metadata only), optionally within one folder. " +
        "Use notes_get to read a note's body.",
      inputSchema: ListNotesInput.shape,
      outputSchema: { notes: z.array(NoteMetaOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "notes.list",
      annotations: { idempotentHint: true },
      run: async (input, ctx) => ({ notes: await call(serializeListNotes(input), ctx?.signal), _untrusted: true }),
    },
    {
      name: "notes_search",
      title: "Search notes",
      description:
        "Find notes whose title or body contains the query text. Returns " +
        "metadata; use notes_get for the full body.",
      inputSchema: SearchNotesInput.shape,
      outputSchema: { notes: z.array(NoteMetaOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "notes.search",
      annotations: { idempotentHint: true },
      run: async (input, ctx) => ({ notes: await call(serializeSearchNotes(input), ctx?.signal), _untrusted: true }),
    },
    {
      name: "notes_get",
      title: "Read note",
      description: "Read one note's plain-text body by id (from notes_list / notes_search).",
      inputSchema: GetNoteInput.shape,
      outputSchema: { note: NoteOut, _untrusted: z.boolean() },
      mode: "read",
      actionId: "notes.get",
      annotations: { idempotentHint: true },
      run: async (input, ctx) => ({ note: await call(serializeGetNote(input), ctx?.signal), _untrusted: true }),
    },
  ];

  const writeTools: ToolDef[] = [
    {
      name: "notes_create",
      title: "Create note",
      description:
        "Create a note with a title and plain-text body, optionally in a " +
        "specific folder. Returns the created note's id.",
      inputSchema: CreateNoteInput.shape,
      outputSchema: {
        note: z.object({ id: z.string(), name: z.string(), folder: z.string().nullable() }),
      },
      mode: "write",
      actionId: "notes.create",
      annotations: { destructiveHint: false },
      run: async (input) => ({ note: await call(serializeCreateNote(input)) }),
    },
  ];

  const resources: ResourceDef[] = [
    {
      uriTemplate: "notes://folders",
      name: "notes-folders",
      title: "Note folders",
      description: "The user's Notes folders as JSON.",
      read: async () => await call(serializeListFolders()),
    },
    {
      uriTemplate: "notes://notes",
      name: "notes-notes",
      title: "Notes",
      description:
        "Recent note metadata (titles, folders, modification times), as JSON. " +
        "To filter by folder or read a body, use the notes_list / notes_get tools.",
      read: async () => await call(serializeListNotes({})),
    },
  ];

  return {
    id: "notes",
    resources: () => resources,
    tools: (mode: Mode) => (mode === "write" ? [...readTools, ...writeTools] : readTools),
  };
}
