/**
 * Runner for the Mail JXA backend — the fixed template at
 * native/mail-jxa/mail.js. See src/native/jxa.ts for the contract.
 * mail.send is only reachable through the elicitation confirmation gate.
 */

import { join } from "node:path";
import { type HelperClient, packageRoot } from "./client.ts";
import { JxaScriptClient } from "./jxa.ts";

export function mailScriptPath(): string {
  return join(packageRoot(import.meta.dirname), "native", "mail-jxa", "mail.js");
}

export class JxaMailClient extends JxaScriptClient {
  constructor(timeoutMs?: number) {
    super(mailScriptPath(), "mail", timeoutMs);
  }
}

let shared: JxaMailClient | undefined;

export function sharedMailClient(): HelperClient {
  return (shared ??= new JxaMailClient());
}
