/**
 * Runner for the Notes JXA backend — the fixed template at
 * native/notes-jxa/notes.js. See src/native/jxa.ts for the contract.
 */

import { join } from "node:path";
import { type HelperClient, packageRoot } from "./client.ts";
import { JxaScriptClient, OSASCRIPT_BIN } from "./jxa.ts";

export { OSASCRIPT_BIN };

export function notesScriptPath(): string {
  return join(packageRoot(import.meta.dirname), "native", "notes-jxa", "notes.js");
}

/** Fixed argv: interpreter flag + constant script path. No request data. */
export function notesArgv(): readonly string[] {
  return Object.freeze(["-l", "JavaScript", notesScriptPath()]);
}

export class JxaNotesClient extends JxaScriptClient {
  constructor(timeoutMs?: number) {
    super(notesScriptPath(), "notes", timeoutMs);
  }
}

let shared: JxaNotesClient | undefined;

export function sharedNotesClient(): HelperClient {
  return (shared ??= new JxaNotesClient());
}
