/**
 * Configuration schema + loader for the Apple Suite MCP server.
 *
 * Design invariants (see DESIGN.md §3):
 *   - Everything is DISABLED by default.
 *   - A module that is not enabled must NOT be registered as a tool/resource
 *     and must NOT trigger any TCC prompt.
 *   - Write mode is opt-in per module. Default is read-only.
 *   - Config changes apply on server RESTART (deliberate: prevents a running
 *     session from being coerced into enabling capabilities).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const MODULE_IDS = [
  "calendar",
  "reminders",
  "contacts",
  "notes",
  "mail",
  "messages",
  "maps",
  "photos",
  "music",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export function isModuleId(id: string): id is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(id);
}

/** Modules that require macOS Full Disk Access and MUST run in an isolated
 *  TCC-responsible helper process (see DESIGN.md §3.5). */
export const FDA_MODULES: ReadonlySet<ModuleId> = new Set(["messages"]);

/** High-risk modules that are NEVER exposed over the remote (HTTP) transport,
 *  regardless of configuration (DESIGN.md §4: minimal remote surface). */
export const REMOTE_BLOCKED_MODULES: ReadonlySet<ModuleId> = new Set(["mail", "messages"]);

export const ModuleConfig = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["read", "write"]).default("read"),
});
export type ModuleConfig = z.infer<typeof ModuleConfig>;

export const OAuthConfig = z.object({
  /** Authorization server issuer URL. Must be https (or http on localhost) —
   *  a malicious endpoint URL is an attack vector (cf. CVE-2025-6514). */
  issuer: z.url(),
  /** Expected token audience — the canonical URI of THIS server. Tokens with
   *  any other audience are rejected (confused-deputy defense). */
  audience: z.string().min(1),
});
export type OAuthConfig = z.infer<typeof OAuthConfig>;

const isLoopbackHost = (host: string) =>
  host === "localhost" || host === "127.0.0.1" || host === "::1";

export const TransportConfig = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdio") }),
  z
    .object({
      type: z.literal("http"),
      // Remote transport is Streamable HTTP; auth defaults to OAuth 2.1.
      auth: z.enum(["oauth2.1", "apikey"]).default("oauth2.1"),
      bind: z.string().default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(8765),
      // High-risk surface is closed to remote by default (DESIGN.md §4).
      allowRemoteWrite: z.boolean().default(false),
      oauth: OAuthConfig.optional(),
    })
    .superRefine((t, ctx) => {
      if (t.auth === "oauth2.1") {
        if (!t.oauth) {
          ctx.addIssue({
            code: "custom",
            path: ["oauth"],
            message: 'auth "oauth2.1" requires transport.oauth { issuer, audience }',
          });
        } else {
          const u = new URL(t.oauth.issuer);
          if (u.protocol !== "https:" && !isLoopbackHost(u.hostname)) {
            ctx.addIssue({
              code: "custom",
              path: ["oauth", "issuer"],
              message: "oauth issuer must use https (http allowed for localhost only)",
            });
          }
        }
      }
    }),
]);
export type TransportConfig = z.infer<typeof TransportConfig>;

export const AppConfig = z.object({
  version: z.literal(1),
  protocol: z.string().default("2025-11-25"),
  modules: z.record(z.enum(MODULE_IDS), ModuleConfig),
  /** Fully-qualified action ids requiring elicitation confirmation.
   *  Rule forms: "<module>.<action>", "*.<action>", "<module>.*". (DESIGN.md §5.5) */
  requireConfirmation: z.array(z.string()).default([
    "mail.send",
    "messages.send",
    "*.delete",
  ]),
  /** Register the capabilities_* meta tools (DESIGN.md §3.4). They expose no
   *  app data; enable-requests still require CLI approval + restart. */
  capabilityTools: z.boolean().default(true),
  transport: TransportConfig.default({ type: "stdio" }),
  rateLimits: z
    .object({
      perToolPerMinute: z.number().int().positive().default(30),
      perSessionPerMinute: z.number().int().positive().default(120),
    })
    .default({ perToolPerMinute: 30, perSessionPerMinute: 120 }),
});
export type AppConfig = z.infer<typeof AppConfig>;

/** Default config generated on first run: everything off, read-only, stdio. */
export function defaultConfig(): AppConfig {
  const modules = Object.fromEntries(
    MODULE_IDS.map((id) => [id, { enabled: false, mode: "read" as const }]),
  ) as Record<ModuleId, ModuleConfig>;
  return AppConfig.parse({ version: 1, modules });
}

/* ------------------------------------------------------------------ */
/* Loading / persistence                                               */
/* ------------------------------------------------------------------ */

/** Overridable for tests; defaults to ~/.apple-mcp. */
export function configDir(): string {
  return process.env["APPLE_MCP_CONFIG_DIR"] ?? join(homedir(), ".apple-mcp");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export class ConfigError extends Error {
  /** Actionable guidance for the user (DESIGN.md §7.1: structured errors). */
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = "ConfigError";
    this.hint = hint;
  }
}

/**
 * Load the config, generating a locked-down default on first run.
 * Unknown module ids are rejected; missing module ids are filled with the
 * disabled default (forward compatibility when new modules ship).
 */
export function loadConfig(): AppConfig {
  const path = configPath();
  let rawText: string;
  try {
    rawText = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const cfg = defaultConfig();
      saveConfig(cfg);
      return cfg;
    }
    throw new ConfigError(
      `cannot read config at ${path}: ${(err as Error).message}`,
      `Check file permissions on ${path}, or delete it to regenerate defaults.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    throw new ConfigError(
      `config at ${path} is not valid JSON: ${(err as Error).message}`,
      `Fix the JSON syntax, or delete the file to regenerate a locked-down default.`,
    );
  }

  // Fill any missing module entries with the disabled default so configs
  // written by older versions keep validating after new modules are added.
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const mods = (obj["modules"] ?? {}) as Record<string, unknown>;
    for (const id of MODULE_IDS) if (!(id in mods)) mods[id] = { enabled: false, mode: "read" };
    obj["modules"] = mods;
  }

  const parsed = AppConfig.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `config at ${path} failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      `Run "apple-mcp status" to inspect, fix the listed fields, or delete the file to regenerate defaults.`,
    );
  }
  return parsed.data;
}

/** Persist config with owner-only permissions (it encodes capability state). */
export function saveConfig(cfg: AppConfig): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/* ------------------------------------------------------------------ */
/* The three gates (DESIGN.md §3.1)                                    */
/* ------------------------------------------------------------------ */

/** Gate ①: is this module enabled at all? */
export function isModuleEnabled(cfg: AppConfig, id: ModuleId): boolean {
  return cfg.modules[id]?.enabled === true;
}

/** Gate ②: is a write action permitted for this module? */
export function isWriteAllowed(cfg: AppConfig, id: ModuleId): boolean {
  return isModuleEnabled(cfg, id) && cfg.modules[id]?.mode === "write";
}

/** Gate ③: does this action require an elicitation confirmation?
 *  actionId is "<module>.<action>"; rules may wildcard either side. */
export function needsConfirmation(cfg: AppConfig, actionId: string): boolean {
  const [mod, action] = actionId.split(".");
  if (!mod || !action) return true; // malformed id: fail closed
  return cfg.requireConfirmation.some((rule) => {
    const [rMod, rAction] = rule.split(".");
    if (!rMod || !rAction) return false;
    return (rMod === mod || rMod === "*") && (rAction === action || rAction === "*");
  });
}
