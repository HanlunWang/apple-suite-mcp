/**
 * Shortcuts backend — serialization boundary to the Shortcuts CLI client.
 * The client uses execFile with an array argv (no shell), so shell
 * metacharacters in a shortcut name are inert. See src/native/shortcuts.ts.
 */

import { z } from "zod";
import type { HelperRequest } from "../_template/module.ts";

export const RunShortcutInput = z.object({
  name: z.string().min(1).max(300).describe("Exact shortcut name (from shortcuts_list)."),
  input: z
    .string()
    .max(100_000)
    .optional()
    .describe("Optional text input piped to the shortcut on stdin."),
});
export type RunShortcutInput = z.infer<typeof RunShortcutInput>;

export type { HelperRequest };

export function serializeListShortcuts(): HelperRequest {
  return { op: "shortcuts.list", args: {} };
}

export function serializeRunShortcut(input: unknown): HelperRequest {
  return { op: "shortcuts.run", args: RunShortcutInput.parse(input) };
}

/* Output shapes */

export const ShortcutListOut = z.object({ shortcuts: z.array(z.string()) });

export const RunResultOut = z.object({
  ran: z.boolean(),
  output: z.string().nullable(),
});
