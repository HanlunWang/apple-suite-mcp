/**
 * Mail module (JXA fixed-template backend). High-risk: mail.send is in the
 * default requireConfirmation list, so the elicitation gate fires before the
 * template is ever invoked; the module is in REMOTE_BLOCKED_MODULES and
 * never registers over HTTP.
 */

import { z } from "zod";
import type { HelperClient } from "../../native/client.ts";
import { sharedMailClient } from "../../native/mail.ts";
import type { AppModule, Mode, ResourceDef, ToolDef } from "../_template/module.ts";
import {
  ListUnreadInput,
  MailMessageOut,
  SearchMailInput,
  SendMailInput,
  SendResultOut,
  serializeListUnread,
  serializeSearchMail,
  serializeSendMail,
} from "./backend.ts";

export function createMailModule(client: HelperClient = sharedMailClient()): AppModule {
  const call = <T>(req: { op: string; args: Record<string, unknown> }, signal?: AbortSignal) =>
    client.call<T>(req.op, req.args, signal);

  const readTools: ToolDef[] = [
    {
      name: "mail_list_unread",
      title: "List unread mail",
      description:
        "List unread inbox messages (subject, sender, date). Set includeBody " +
        "to also fetch bodies (slower, fewer messages).",
      inputSchema: ListUnreadInput.shape,
      outputSchema: { messages: z.array(MailMessageOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "mail.list",
      annotations: { idempotentHint: true },
      run: async (input, ctx) => ({
        messages: await call(serializeListUnread(input), ctx?.signal),
        _untrusted: true,
      }),
    },
    {
      name: "mail_search",
      title: "Search inbox",
      description:
        "Find inbox messages whose subject or sender contains the query. " +
        "Searches the inbox only, without bodies.",
      inputSchema: SearchMailInput.shape,
      outputSchema: { messages: z.array(MailMessageOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "mail.search",
      annotations: { idempotentHint: true },
      run: async (input, ctx) => ({
        messages: await call(serializeSearchMail(input), ctx?.signal),
        _untrusted: true,
      }),
    },
  ];

  const writeTools: ToolDef[] = [
    {
      name: "mail_send",
      title: "Send mail",
      description:
        "Send an email from the user's Mail.app account. ALWAYS asks the user " +
        "for confirmation (with recipients and subject) before sending.",
      inputSchema: SendMailInput.shape,
      outputSchema: SendResultOut.shape,
      mode: "write",
      actionId: "mail.send",
      annotations: { destructiveHint: false, openWorldHint: true },
      validate: (input) => void SendMailInput.parse(input),
      confirmPreview: (input) => {
        const to = Array.isArray(input["to"]) ? (input["to"] as string[]).join(", ") : "?";
        const subject = String(input["subject"] ?? "");
        const body = String(input["body"] ?? "");
        const excerpt = body.length > 200 ? `${body.slice(0, 200)}…` : body;
        return `Send mail to: ${to}\nSubject: ${subject}\n---\n${excerpt}`;
      },
      run: async (input) => await call(serializeSendMail(input)),
    },
  ];

  const resources: ResourceDef[] = [
    {
      uriTemplate: "mail://unread",
      name: "mail-unread",
      title: "Unread mail",
      description:
        "Unread inbox messages (metadata only) as JSON. For bodies or a " +
        "different limit, use the mail_list_unread tool.",
      read: async () => await call(serializeListUnread({})),
    },
  ];

  return {
    id: "mail",
    resources: () => resources,
    tools: (mode: Mode) => (mode === "write" ? [...readTools, ...writeTools] : readTools),
  };
}
