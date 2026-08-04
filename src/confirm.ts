/**
 * Elicitation confirmation gate (DESIGN.md §5.5).
 *
 * Side-effecting actions matched by config.requireConfirmation must be
 * confirmed by the HUMAN through the client's elicitation UI before they
 * execute. Fail-closed: if the connected client does not support
 * elicitation, the action is refused (never silently executed).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger.ts";

export class ConfirmationRefusedError extends Error {
  readonly reason: "declined" | "cancelled" | "unsupported";

  constructor(message: string, reason: "declined" | "cancelled" | "unsupported") {
    super(message);
    this.name = "ConfirmationRefusedError";
    this.reason = reason;
  }
}

/**
 * Ask the user (via the client's elicitation UI) to confirm `actionId`.
 * `preview` must summarize exactly what is about to happen — recipient,
 * subject, target — so the human decides with full information.
 *
 * Resolves when confirmed; throws ConfirmationRefusedError otherwise.
 */
export async function confirmOrThrow(
  server: McpServer,
  actionId: string,
  preview: string,
): Promise<void> {
  const caps = server.server.getClientCapabilities();
  if (!caps?.elicitation) {
    logger.warn("confirm.unsupported", { actionId });
    throw new ConfirmationRefusedError(
      `Action "${actionId}" requires user confirmation, but this client does not ` +
        `support MCP elicitation. The action was NOT executed. Perform it manually, ` +
        `or connect with a client that supports elicitation.`,
      "unsupported",
    );
  }

  const result = await server.server.elicitInput({
    mode: "form",
    message: `Confirm ${actionId}?\n\n${preview}\n\nThis action has real side effects.`,
    requestedSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          title: "Confirm",
          description: `Set to true to allow ${actionId}.`,
        },
      },
      required: ["confirm"],
    },
  });

  if (result.action === "accept" && result.content?.["confirm"] === true) {
    logger.info("confirm.accepted", { actionId });
    return;
  }
  const reason = result.action === "cancel" ? "cancelled" : "declined";
  logger.info("confirm.refused", { actionId, reason });
  throw new ConfirmationRefusedError(
    `User ${reason} confirmation for "${actionId}". The action was NOT executed.`,
    reason,
  );
}
