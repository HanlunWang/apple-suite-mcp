/**
 * Calendar backend — the serialization boundary to the native eventkit-helper.
 *
 * SECURITY (DESIGN.md §5.1): this file is the only place calendar data crosses
 * from the MCP server toward the OS. Untrusted fields travel as STRUCTURED
 * JSON on the helper's stdin. They are never concatenated into AppleScript,
 * shell text, or argv. The helper (native/eventkit-helper, M1) consumes the
 * payload with typed EventKit APIs — there is no script text anywhere on this
 * path, so there is nothing to inject into.
 *
 * The injection regression suite (tests/injection/) pins this contract.
 */

import { z } from "zod";

/** Fixed helper binary location (resolved relative to the install dir at
 *  runtime; the path never contains request data). */
export const EVENTKIT_HELPER_BIN = "eventkit-helper";

/** Fixed argv for every invocation. Request data NEVER appears in argv —
 *  argv is visible in `ps` output and easier to mangle than an stdin pipe. */
export const HELPER_ARGV: readonly string[] = Object.freeze(["--json-stdin"]);

export const CreateEventInput = z.object({
  title: z.string().min(1).max(1000),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  calendar: z.string().max(200).optional(),
  location: z.string().max(1000).optional(),
  notes: z.string().max(10_000).optional(),
});
export type CreateEventInput = z.infer<typeof CreateEventInput>;

/** Structured request sent to the helper. Pure data — no executable text. */
export interface HelperRequest {
  op: "create_event";
  args: CreateEventInput;
}

/**
 * Validate + serialize a create-event request into the structured payload for
 * the native helper. Content is treated as opaque data: it is validated for
 * SHAPE (types, lengths, date format) but never "escaped" or rewritten —
 * escaping-based sanitization is exactly the upstream bug class this project
 * exists to eliminate.
 */
export function serializeCreateEvent(input: unknown): HelperRequest {
  const args = CreateEventInput.parse(input);
  return { op: "create_event", args };
}

/** A helper invocation: fixed binary, fixed argv, data only on stdin. */
export interface HelperInvocation {
  command: string;
  argv: readonly string[];
  /** JSON payload written to the helper's stdin. */
  stdin: string;
}

export function buildHelperInvocation(request: HelperRequest): HelperInvocation {
  return {
    command: EVENTKIT_HELPER_BIN,
    argv: HELPER_ARGV,
    stdin: JSON.stringify(request),
  };
}
