/**
 * Authentication for the remote (Streamable HTTP) transport — DESIGN.md §4.
 *
 * Two modes:
 *  - "oauth2.1": this server acts as an OAuth 2.1 RESOURCE SERVER. Bearer
 *    JWTs are verified against the configured authorization server's JWKS
 *    (discovered via RFC 8414 metadata), and the token AUDIENCE must equal
 *    this server's canonical URI — tokens issued for anything else are
 *    rejected (confused-deputy / token-passthrough defense).
 *  - "apikey": a locally generated 256-bit key, stored 0600 next to the
 *    config, compared in constant time. Suited to a reverse-proxied personal
 *    setup where a full authorization server is overkill.
 *
 * Never log tokens or keys.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { type OAuthConfig, configDir } from "../config.ts";
import { logger } from "../logger.ts";

export interface AuthResult {
  ok: boolean;
  /** RFC 6750 error code for the WWW-Authenticate header when !ok. */
  error?: "invalid_token" | "invalid_request";
  detail?: string;
}

export interface Authenticator {
  authenticate(authorizationHeader: string | undefined): Promise<AuthResult>;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, token, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) return undefined;
  return token;
}

/* ------------------------------------------------------------------ */
/* API key                                                             */
/* ------------------------------------------------------------------ */

export function apiKeyPath(): string {
  return join(configDir(), "http-api-key");
}

/** Load the API key, generating one on first use (printed nowhere; the user
 *  reads it from the 0600 file). */
export function loadOrCreateApiKey(): string {
  try {
    const key = readFileSync(apiKeyPath(), "utf8").trim();
    if (key.length >= 32) return key;
  } catch {
    // fall through to generation
  }
  const key = randomBytes(32).toString("hex");
  writeFileSync(apiKeyPath(), key + "\n", { mode: 0o600 });
  logger.info("auth.apikey_generated", { path: apiKeyPath() });
  return key;
}

export class ApiKeyAuthenticator implements Authenticator {
  private readonly key: Buffer;

  constructor(key: string = loadOrCreateApiKey()) {
    this.key = Buffer.from(key, "utf8");
  }

  async authenticate(header: string | undefined): Promise<AuthResult> {
    const token = bearerToken(header);
    if (!token) return { ok: false, error: "invalid_request", detail: "missing bearer token" };
    const candidate = Buffer.from(token, "utf8");
    const ok = candidate.length === this.key.length && timingSafeEqual(candidate, this.key);
    return ok ? { ok: true } : { ok: false, error: "invalid_token", detail: "bad api key" };
  }
}

/* ------------------------------------------------------------------ */
/* OAuth 2.1 resource server                                           */
/* ------------------------------------------------------------------ */

interface AsMetadata {
  issuer: string;
  jwks_uri: string;
}

/** Fetch RFC 8414 authorization-server metadata and pin the JWKS. The issuer
 *  URL comes from local config only — never from a request. */
async function discoverJwks(issuer: string): Promise<{ jwks: ReturnType<typeof createRemoteJWKSet>; issuer: string }> {
  const base = issuer.replace(/\/$/, "");
  const metaUrl = new URL(`${base}/.well-known/oauth-authorization-server`);
  const res = await fetch(metaUrl);
  if (!res.ok) {
    throw new Error(`authorization server metadata fetch failed (${res.status}) from ${metaUrl}`);
  }
  const meta = (await res.json()) as AsMetadata;
  if (meta.issuer !== issuer && meta.issuer !== base) {
    throw new Error(`authorization server metadata issuer mismatch: ${meta.issuer}`);
  }
  if (!meta.jwks_uri) throw new Error("authorization server metadata missing jwks_uri");
  return { jwks: createRemoteJWKSet(new URL(meta.jwks_uri)), issuer: meta.issuer };
}

export class OAuthAuthenticator implements Authenticator {
  private jwksPromise: ReturnType<typeof discoverJwks> | undefined;
  private readonly cfg: OAuthConfig;

  constructor(cfg: OAuthConfig) {
    this.cfg = cfg;
  }

  private jwks() {
    return (this.jwksPromise ??= discoverJwks(this.cfg.issuer));
  }

  async authenticate(header: string | undefined): Promise<AuthResult> {
    const token = bearerToken(header);
    if (!token) return { ok: false, error: "invalid_request", detail: "missing bearer token" };
    try {
      const { jwks, issuer } = await this.jwks();
      await jwtVerify(token, jwks, {
        issuer,
        // MUST match this server's canonical URI. Rejects tokens minted for
        // other services even when signed by the same authorization server.
        audience: this.cfg.audience,
      });
      return { ok: true };
    } catch (err) {
      // Detail goes to the client per RFC 6750; never include the token.
      return { ok: false, error: "invalid_token", detail: (err as Error).message };
    }
  }
}

export function createAuthenticator(
  auth: "oauth2.1" | "apikey",
  oauth: OAuthConfig | undefined,
): Authenticator {
  if (auth === "apikey") return new ApiKeyAuthenticator();
  if (!oauth) throw new Error('transport.oauth is required for auth "oauth2.1"');
  return new OAuthAuthenticator(oauth);
}
