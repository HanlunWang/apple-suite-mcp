/**
 * Client for the resident contacts-helper process — its own binary, and
 * therefore its own revocable TCC subject (DESIGN.md §2).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HelperCallError,
  type HelperClient,
  HelperProcessClient,
  packageRoot,
} from "./client.ts";

export const CONTACTS_HELPER_BIN = "contacts-helper";
export const CONTACTS_HELPER_ARGV: readonly string[] = Object.freeze(["--json-stdin"]);

export function resolveContactsHelperPath(): string {
  const override = process.env["APPLE_MCP_CONTACTS_HELPER"];
  if (override) return override;

  const root = packageRoot(import.meta.dirname);
  const candidates = [
    join(root, "native", "contacts-helper", ".build", "release", CONTACTS_HELPER_BIN),
    join(root, "native", "contacts-helper", ".build", "debug", CONTACTS_HELPER_BIN),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new HelperCallError(
    "helper_missing",
    `${CONTACTS_HELPER_BIN} binary not found`,
    `Build it with "npm run build:native" (requires Xcode command line tools), ` +
      `or point APPLE_MCP_CONTACTS_HELPER at the binary.`,
  );
}

export class ContactsHelperClient extends HelperProcessClient {
  constructor(binPath?: string, timeoutMs?: number) {
    super(binPath ?? resolveContactsHelperPath(), CONTACTS_HELPER_ARGV, timeoutMs);
  }
}

let shared: ContactsHelperClient | undefined;

export function sharedContactsClient(): HelperClient {
  return (shared ??= new ContactsHelperClient());
}
