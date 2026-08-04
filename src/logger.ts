/**
 * Structured JSON logging with sensitive-field redaction (DESIGN.md §5.3).
 *
 * Invariants:
 *  - Logs go to STDERR only. Stdout belongs to the MCP stdio transport;
 *    writing anything else there corrupts the protocol stream.
 *  - Message/mail bodies, phone numbers, email addresses etc. are redacted
 *    by key name before serialization. Data read from Apple apps is treated
 *    as sensitive by default — when in doubt, do not log it.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Keys whose string values are never written to logs. */
const REDACT_KEY = /^(body|content|text|message|notes?|subject|phone|email|address|title|payload|stdin)$/i;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = (process.env["APPLE_MCP_LOG_LEVEL"] as LogLevel) || "info";
if (!(minLevel in LEVEL_ORDER)) minLevel = "info";

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(redact(fields) as Record<string, unknown>),
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => log("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => log("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log("error", event, fields),
};
