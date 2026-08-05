/**
 * Clients for the messages module — the highest-risk domain, split in two:
 *
 *  - READS: the messages-helper child process (chat.db via parameterized
 *    sqlite, read-only, Full Disk Access confined to that process).
 *  - SEND: the fixed messages-send JXA template, only ever invoked after
 *    elicitation confirmation.
 */

import { join } from "node:path";
import { type HelperClient, HelperProcessClient, packageRoot } from "./client.ts";
import { JxaScriptClient } from "./jxa.ts";

/** Runtime extension of this module (.ts in dev, .js in dist) — the child
 *  script sits next to this file and is spawned with the same flavor. */
const EXT = import.meta.url.slice(import.meta.url.lastIndexOf("."));

export function messagesChildScriptPath(): string {
  return join(import.meta.dirname, `messages-helper-child${EXT}`);
}

/** The child runs under the same Node binary; argv is fixed (script path is
 *  a constant, request data only ever flows over stdin). */
export class MessagesDbClient extends HelperProcessClient {
  constructor(scriptPath: string = messagesChildScriptPath(), timeoutMs?: number) {
    super(process.execPath, [scriptPath, "--json-stdin"], timeoutMs);
  }
}

export function messagesSendScriptPath(): string {
  return join(packageRoot(import.meta.dirname), "native", "messages-jxa", "messages-send.js");
}

export class JxaMessagesSendClient extends JxaScriptClient {
  constructor(timeoutMs?: number) {
    super(messagesSendScriptPath(), "messages", timeoutMs);
  }
}

let sharedDb: MessagesDbClient | undefined;
let sharedSend: JxaMessagesSendClient | undefined;

export function sharedMessagesDbClient(): HelperClient {
  return (sharedDb ??= new MessagesDbClient());
}

export function sharedMessagesSendClient(): HelperClient {
  return (sharedSend ??= new JxaMessagesSendClient());
}
