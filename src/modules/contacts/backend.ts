/**
 * Contacts backend — serialization boundary to the native contacts-helper.
 * Same security contract as the other backends (structured JSON on stdin,
 * shape validation only, no rewriting — see DESIGN.md §5.1); the injection
 * regression suite pins it.
 */

import { z } from "zod";
import type { HelperRequest } from "../_template/module.ts";

export const LabeledValueInput = z.object({
  label: z.string().max(100).optional().describe('Label like "home" or "work".'),
  value: z.string().min(1).max(500).describe("The email address or phone number."),
});

export const SearchContactsInput = z.object({
  query: z.string().min(1).max(500).describe("Name to search for (partial names match)."),
  limit: z.coerce.number().int().min(1).max(200).default(25).describe("Max results. Hard cap 200."),
});

export const GetContactInput = z.object({
  id: z.string().min(1).max(300).describe("Contact id (from contacts_search)."),
});

export const CreateContactInput = z.object({
  givenName: z.string().min(1).max(500).describe("First name."),
  familyName: z.string().max(500).optional().describe("Last name."),
  organization: z.string().max(500).optional().describe("Company / organization."),
  emails: z.array(LabeledValueInput).max(10).optional().describe("Email addresses."),
  phones: z.array(LabeledValueInput).max(10).optional().describe("Phone numbers."),
});
export type CreateContactInput = z.infer<typeof CreateContactInput>;

export type { HelperRequest };

export function serializeSearchContacts(input: unknown): HelperRequest {
  return { op: "contacts.search", args: SearchContactsInput.parse(input) };
}

export function serializeGetContact(input: unknown): HelperRequest {
  return { op: "contacts.get", args: GetContactInput.parse(input) };
}

export function serializeCreateContact(input: unknown): HelperRequest {
  return { op: "contacts.create", args: CreateContactInput.parse(input) };
}

/* Output shapes */

export const LabeledValueOut = z.object({
  label: z.string().nullable().optional(),
  value: z.string(),
});

export const ContactOut = z.object({
  id: z.string(),
  givenName: z.string(),
  familyName: z.string(),
  fullName: z.string(),
  organization: z.string().optional(),
  emails: z.array(LabeledValueOut),
  phones: z.array(LabeledValueOut),
});
