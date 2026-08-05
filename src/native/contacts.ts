/**
 * Client for the resident contacts-helper process — its own binary, and
 * therefore its own revocable TCC subject (DESIGN.md §2).
 */

import { type HelperClient, HelperProcessClient, resolveHelperBin } from "./client.ts";

export const CONTACTS_HELPER_BIN = "contacts-helper";
export const CONTACTS_HELPER_ARGV: readonly string[] = Object.freeze(["--json-stdin"]);

export function resolveContactsHelperPath(): string {
  return resolveHelperBin(CONTACTS_HELPER_BIN, "APPLE_MCP_CONTACTS_HELPER", import.meta.dirname);
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
