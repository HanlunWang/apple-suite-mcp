/**
 * Messages backend — serialization boundaries for BOTH sides of the module:
 * chat.db reads (messages-helper child, parameterized sqlite) and sending
 * (fixed JXA template, elicitation-gated). Standard contract: shape
 * validation only, content carried verbatim (DESIGN.md §5.1).
 */

import { z } from "zod";

export const ListChatsInput = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25).describe("Max chats. Hard cap 200."),
});

export const ListMessagesInput = z.object({
  chatGuid: z
    .string()
    .max(500)
    .optional()
    .describe("Restrict to one chat (guid from messages_list_chats). Default: all chats."),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("Max messages. Hard cap 200."),
});

export const SearchMessagesInput = z.object({
  query: z.string().min(1).max(500).describe("Literal substring to find in message text."),
  limit: z.coerce.number().int().min(1).max(200).default(25).describe("Max results. Hard cap 200."),
});

export const SendMessageInput = z
  .object({
    to: z
      .string()
      .max(500)
      .optional()
      .describe("Recipient handle (phone/email) on iMessage. Prefer chatGuid."),
    chatGuid: z
      .string()
      .max(500)
      .optional()
      .describe("Existing chat to send into (guid from messages_list_chats)."),
    body: z.string().min(1).max(10_000).describe("Message text."),
  })
  .refine((v) => v.to || v.chatGuid, { message: "either to or chatGuid is required" });
export type SendMessageInput = z.infer<typeof SendMessageInput>;

export interface HelperRequest {
  op: string;
  args: Record<string, unknown>;
}

export function serializeListChats(input: unknown): HelperRequest {
  return { op: "messages.list_chats", args: ListChatsInput.parse(input) };
}

export function serializeListMessages(input: unknown): HelperRequest {
  return { op: "messages.list", args: ListMessagesInput.parse(input) };
}

export function serializeSearchMessages(input: unknown): HelperRequest {
  return { op: "messages.search", args: SearchMessagesInput.parse(input) };
}

export function serializeSendMessage(input: unknown): HelperRequest {
  return { op: "messages.send", args: SendMessageInput.parse(input) };
}

/* Output shapes */

export const ChatOut = z.object({
  guid: z.string(),
  identifier: z.string(),
  displayName: z.string().nullable(),
  participants: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
});

export const MessageOut = z.object({
  guid: z.string(),
  chatGuid: z.string(),
  sender: z.string().nullable(),
  fromMe: z.boolean(),
  at: z.string().nullable(),
  text: z.string().nullable(),
});

export const SendMessageResultOut = z.object({
  sent: z.boolean(),
  target: z.string(),
});
