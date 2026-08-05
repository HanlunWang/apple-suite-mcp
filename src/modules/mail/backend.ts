/**
 * Mail backend — serialization boundary to the fixed JXA template
 * (native/mail-jxa/mail.js). Standard contract: shape validation only,
 * content carried verbatim, no script text (DESIGN.md §5.1).
 */

import { z } from "zod";

export const ListUnreadInput = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).describe("Max messages. Hard cap 100."),
  includeBody: z
    .boolean()
    .default(false)
    .describe("Also fetch message bodies (slower; caps limit at 20)."),
});

export const SearchMailInput = z.object({
  query: z.string().min(1).max(500).describe("Text to find in inbox subjects or senders."),
  limit: z.coerce.number().int().min(1).max(100).default(25).describe("Max results. Hard cap 100."),
});

export const SendMailInput = z.object({
  to: z.array(z.email()).min(1).max(20).describe("Recipient email addresses."),
  subject: z.string().min(1).max(1000).describe("Subject line."),
  body: z.string().max(100_000).describe("Plain-text message body."),
  cc: z.array(z.email()).max(20).optional().describe("CC addresses."),
  bcc: z.array(z.email()).max(20).optional().describe("BCC addresses."),
});
export type SendMailInput = z.infer<typeof SendMailInput>;

export interface HelperRequest {
  op: string;
  args: Record<string, unknown>;
}

export function serializeListUnread(input: unknown): HelperRequest {
  return { op: "mail.list_unread", args: ListUnreadInput.parse(input) };
}

export function serializeSearchMail(input: unknown): HelperRequest {
  return { op: "mail.search", args: SearchMailInput.parse(input) };
}

export function serializeSendMail(input: unknown): HelperRequest {
  return { op: "mail.send", args: SendMailInput.parse(input) };
}

/* Output shapes */

export const MailMessageOut = z.object({
  id: z.number(),
  subject: z.string(),
  sender: z.string(),
  dateReceived: z.string().nullable(),
  mailbox: z.string(),
  read: z.boolean(),
  body: z.string().optional(),
});

export const SendResultOut = z.object({
  sent: z.boolean(),
  to: z.array(z.string()),
  subject: z.string(),
});
