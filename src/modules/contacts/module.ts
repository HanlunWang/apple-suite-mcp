/**
 * Contacts module (Contacts.framework via contacts-helper — its own
 * revocable TCC subject). Read tools when enabled; create only in write mode.
 */

import { z } from "zod";
import { sharedContactsClient } from "../../native/contacts.ts";
import type { HelperClient } from "../../native/client.ts";
import type { AppModule, Mode, ResourceDef, ToolDef } from "../_template/module.ts";
import {
  ContactOut,
  CreateContactInput,
  GetContactInput,
  SearchContactsInput,
  serializeCreateContact,
  serializeGetContact,
  serializeSearchContacts,
} from "./backend.ts";

export function createContactsModule(client: HelperClient = sharedContactsClient()): AppModule {
  const call = <T>(req: { op: string; args: Record<string, unknown> }, signal?: AbortSignal) =>
    client.call<T>(req.op, req.args, signal);

  const readTools: ToolDef[] = [
    {
      name: "contacts_search",
      title: "Search contacts",
      description:
        "Search contacts by name (partial names match). Returns ids, names, " +
        "emails, and phone numbers. Use contacts_get for a single known id.",
      inputSchema: SearchContactsInput.shape,
      outputSchema: { contacts: z.array(ContactOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "contacts.search",
      annotations: { idempotentHint: true },
      run: async (input, ctx) => ({
        contacts: await call(serializeSearchContacts(input), ctx?.signal),
        _untrusted: true,
      }),
    },
    {
      name: "contacts_get",
      title: "Get contact",
      description: "Fetch one contact by id. If you only have a name, use contacts_search.",
      inputSchema: GetContactInput.shape,
      outputSchema: { contact: ContactOut, _untrusted: z.boolean() },
      mode: "read",
      actionId: "contacts.get",
      annotations: { idempotentHint: true },
      run: async (input, ctx) => ({
        contact: await call(serializeGetContact(input), ctx?.signal),
        _untrusted: true,
      }),
    },
  ];

  const writeTools: ToolDef[] = [
    {
      name: "contacts_create",
      title: "Create contact",
      description:
        "Create a new contact with optional emails, phone numbers, and " +
        "organization. Returns the created contact with its id.",
      inputSchema: CreateContactInput.shape,
      outputSchema: { contact: ContactOut },
      mode: "write",
      actionId: "contacts.create",
      annotations: { destructiveHint: false },
      run: async (input) => ({ contact: await call(serializeCreateContact(input)) }),
    },
  ];

  // Contacts exposes no resource: a search without a query is meaningless as
  // browsable context, and the contacts_search tool covers the parameterized
  // case with a properly typed schema.
  const resources: ResourceDef[] = [];

  return {
    id: "contacts",
    resources: () => resources,
    tools: (mode: Mode) => (mode === "write" ? [...readTools, ...writeTools] : readTools),
  };
}
