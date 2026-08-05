/**
 * Messages module — the highest-risk domain (DESIGN.md §3.5).
 *
 *  - Reads go through the FDA-isolated messages-helper child process
 *    (parameterized sqlite over chat.db, read-only).
 *  - Sending goes through the fixed messages-send JXA template and is in the
 *    default requireConfirmation list — the elicitation gate fires first.
 *  - The module requires the CLI FDA acknowledgement to enable, and is in
 *    REMOTE_BLOCKED_MODULES (never registered over HTTP).
 */

import { z } from "zod";
import type { HelperClient } from "../../native/client.ts";
import { sharedMessagesDbClient, sharedMessagesSendClient } from "../../native/messages.ts";
import type { AppModule, Mode, ResourceDef, ToolDef } from "../_template/module.ts";
import {
  ChatOut,
  ListChatsInput,
  ListMessagesInput,
  MessageOut,
  SearchMessagesInput,
  SendMessageInput,
  SendMessageResultOut,
  serializeListChats,
  serializeListMessages,
  serializeSearchMessages,
  serializeSendMessage,
} from "./backend.ts";

export function createMessagesModule(
  dbClient: HelperClient = sharedMessagesDbClient(),
  sendClient: HelperClient = sharedMessagesSendClient(),
): AppModule {
  const read = <T>(req: { op: string; args: Record<string, unknown> }, signal?: AbortSignal) =>
    dbClient.call<T>(req.op, req.args, signal);

  const readTools: ToolDef[] = [
    {
      name: "messages_list_chats",
      title: "List chats",
      description:
        "List recent iMessage/SMS conversations (guid, participants, last " +
        "activity). Use the guid with messages_list and messages_send.",
      inputSchema: ListChatsInput.shape,
      outputSchema: { chats: z.array(ChatOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "messages.list",
      annotations: { idempotentHint: true },
      run: async (input, ctx) => ({ chats: await read(serializeListChats(input), ctx?.signal), _untrusted: true }),
    },
    {
      name: "messages_list",
      title: "List messages",
      description:
        "List recent messages (newest first), optionally within one chat. " +
        "Returns message text from the user's private iMessage history.",
      inputSchema: ListMessagesInput.shape,
      outputSchema: { messages: z.array(MessageOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "messages.list",
      annotations: { idempotentHint: true },
      run: async (input, ctx) => ({
        messages: await read(serializeListMessages(input), ctx?.signal),
        _untrusted: true,
      }),
    },
    {
      name: "messages_search",
      title: "Search messages",
      description:
        "Find messages containing a literal substring (wildcards are matched " +
        "literally, not interpreted).",
      inputSchema: SearchMessagesInput.shape,
      outputSchema: { messages: z.array(MessageOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "messages.search",
      annotations: { idempotentHint: true },
      run: async (input, ctx) => ({
        messages: await read(serializeSearchMessages(input), ctx?.signal),
        _untrusted: true,
      }),
    },
  ];

  const writeTools: ToolDef[] = [
    {
      name: "messages_send",
      title: "Send message",
      description:
        "Send an iMessage to an existing chat (chatGuid) or a direct handle. " +
        "ALWAYS asks the user for confirmation (with recipient and text) first.",
      inputSchema: SendMessageInput.shape,
      outputSchema: SendMessageResultOut.shape,
      mode: "write",
      actionId: "messages.send",
      annotations: { destructiveHint: false, openWorldHint: true },
      validate: (input) => void SendMessageInput.parse(input),
      confirmPreview: (input) => {
        const target = String(input["chatGuid"] ?? input["to"] ?? "?");
        const body = String(input["body"] ?? "");
        const excerpt = body.length > 200 ? `${body.slice(0, 200)}…` : body;
        return `Send iMessage to: ${target}\n---\n${excerpt}`;
      },
      run: async (input) => {
        const req = serializeSendMessage(input);
        return await sendClient.call(req.op, req.args);
      },
    },
  ];

  const resources: ResourceDef[] = [
    {
      uriTemplate: "messages://chats",
      name: "messages-chats",
      title: "Chats",
      description:
        "Recent conversations (participants, last activity) as JSON. For " +
        "message contents use the messages_list / messages_search tools.",
      read: async () => await read(serializeListChats({})),
    },
  ];

  return {
    id: "messages",
    resources: () => resources,
    tools: (mode: Mode) => (mode === "write" ? [...readTools, ...writeTools] : readTools),
  };
}
