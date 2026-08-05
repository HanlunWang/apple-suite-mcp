/**
 * Shortcuts module (the `shortcuts` CLI).
 *
 * Running a shortcut executes user-authored automation with the user's full
 * privileges and can do anything the user can — so `shortcuts.run` is in the
 * default requireConfirmation list (elicitation fires with the shortcut name
 * before it runs), and the module is in REMOTE_BLOCKED_MODULES.
 */

import { z } from "zod";
import type { HelperClient } from "../../native/client.ts";
import { sharedShortcutsClient } from "../../native/shortcuts.ts";
import type { AppModule, Mode, ResourceDef, ToolDef } from "../_template/module.ts";
import {
  RunResultOut,
  RunShortcutInput,
  serializeListShortcuts,
  serializeRunShortcut,
} from "./backend.ts";

export function createShortcutsModule(client: HelperClient = sharedShortcutsClient()): AppModule {
  const call = <T>(req: { op: string; args: Record<string, unknown> }) =>
    client.call<T>(req.op, req.args);

  const readTools: ToolDef[] = [
    {
      name: "shortcuts_list",
      title: "List shortcuts",
      description:
        "List the names of the user's installed Shortcuts. Use an exact name " +
        "with shortcuts_run.",
      inputSchema: {},
      outputSchema: { shortcuts: z.array(z.string()), _untrusted: z.boolean() },
      mode: "read",
      actionId: "shortcuts.list",
      annotations: { idempotentHint: true },
      run: async () => {
        const result = await call<{ shortcuts: string[] }>(serializeListShortcuts());
        return { shortcuts: result.shortcuts, _untrusted: true };
      },
    },
  ];

  const writeTools: ToolDef[] = [
    {
      name: "shortcuts_run",
      title: "Run shortcut",
      description:
        "Run one of the user's Shortcuts by exact name, optionally passing " +
        "text input. A shortcut can do anything its author scripted, so this " +
        "ALWAYS asks the user for confirmation first.",
      inputSchema: RunShortcutInput.shape,
      outputSchema: RunResultOut.shape,
      mode: "write",
      actionId: "shortcuts.run",
      annotations: { destructiveHint: true, openWorldHint: true },
      confirmPreview: (input) => {
        const name = String(input["name"] ?? "?");
        const text = typeof input["input"] === "string" ? String(input["input"]) : "";
        const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        return text
          ? `Run shortcut: ${name}\nInput:\n${excerpt}`
          : `Run shortcut: ${name}`;
      },
      run: async (input) => await call(serializeRunShortcut(input)),
    },
  ];

  const resources: ResourceDef[] = [
    {
      uriTemplate: "shortcuts://list",
      name: "shortcuts-list",
      title: "Shortcuts",
      description: "Installed shortcut names as JSON.",
      read: async () => await call(serializeListShortcuts()),
    },
  ];

  return {
    id: "shortcuts",
    activationNotice:
      "Running a shortcut executes user-authored automation with your full privileges; " +
      "every run asks for confirmation.",
    resources: () => resources,
    tools: (mode: Mode) => (mode === "write" ? [...readTools, ...writeTools] : readTools),
  };
}
