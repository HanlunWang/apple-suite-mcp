/**
 * Remote transport: Streamable HTTP (MCP 2025-11-25) — DESIGN.md §4.
 *
 *  - single /mcp endpoint (POST + GET + DELETE)
 *  - binds 127.0.0.1 by default; exposing it further requires the user's own
 *    reverse proxy + TLS, and auth is ALWAYS required regardless of bind
 *  - cryptographically random session ids; one McpServer per session,
 *    registered with the REMOTE minimal surface (registry RegisterOptions)
 *  - DNS-rebinding protection via Host allowlist for loopback binds
 *  - RFC 9728 protected-resource metadata + RFC 6750 WWW-Authenticate
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.ts";
import { logger } from "../logger.ts";
import { type Authenticator, createAuthenticator } from "./auth.ts";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
  lastSeen: number;
}

/** A client that disconnects without DELETE leaves its session behind, so
 *  sessions are reaped on idle and capped — otherwise each reconnect leaks an
 *  McpServer, and minting fresh sessions would reset the per-session rate
 *  limits indefinitely. */
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_SWEEP_MS = 60_000;
const MAX_SESSIONS = 64;

function isLoopback(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

/** Host values a loopback client may legitimately send. IPv6 literals appear
 *  bracketed in the Host header, so `bind: "::1"` needs "[::1]" forms or the
 *  DNS-rebinding allowlist rejects every request to the server's own address. */
function loopbackHosts(port: number): string[] {
  const hosts = ["127.0.0.1", "localhost", "[::1]"];
  return [...hosts, ...hosts.map((h) => `${h}:${port}`)];
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startHttpServer(
  cfg: AppConfig,
  createSessionServer: () => Promise<McpServer>,
): Promise<HttpServerHandle> {
  if (cfg.transport.type !== "http") throw new Error("transport is not http");
  const t = cfg.transport;
  const authenticator: Authenticator = createAuthenticator(t.auth, t.oauth);
  const sessions = new Map<string, Session>();
  // Reassigned after listen() — with port 0 the OS picks the real port, and
  // the DNS-rebinding Host allowlist must use that value.
  let actualPort = t.port;

  const resourceMetadataPath = "/.well-known/oauth-protected-resource";

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      logger.error("http.request_failed", { error: (err as Error).message });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      } else {
        res.end();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // RFC 9728: where clients discover the authorization server. Unauthenticated.
    if (req.method === "GET" && url.pathname === resourceMetadataPath) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          resource: t.auth === "oauth2.1" ? t.oauth!.audience : url.origin,
          ...(t.auth === "oauth2.1" ? { authorization_servers: [t.oauth!.issuer] } : {}),
          bearer_methods_supported: ["header"],
        }),
      );
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    // Auth precedes everything — including session routing.
    const auth = await authenticator.authenticate(req.headers.authorization);
    if (!auth.ok) {
      const params = [
        `resource_metadata="${url.origin}${resourceMetadataPath}"`,
        ...(auth.error ? [`error="${auth.error}"`] : []),
      ].join(", ");
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer ${params}`,
      });
      res.end(JSON.stringify({ error: auth.error ?? "unauthorized", detail: auth.detail }));
      logger.warn("http.unauthorized", { method: req.method });
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const body = req.method === "POST" ? await readBody(req) : undefined;

    if (typeof sessionId === "string") {
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown_session" }));
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "POST" && isInitializeRequest(body)) {
      if (sessions.size >= MAX_SESSIONS) {
        logger.warn("http.session_limit", { sessions: sessions.size });
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "too_many_sessions" }));
        return;
      }
      const mcp = await createSessionServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableDnsRebindingProtection: isLoopback(t.bind),
        ...(isLoopback(t.bind) ? { allowedHosts: loopbackHosts(actualPort) } : {}),
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, mcp, lastSeen: Date.now() });
          logger.info("http.session_open", { sessions: sessions.size });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.delete(id)) {
          void mcp.close();
          logger.info("http.session_closed", { sessions: sessions.size });
        }
      };
      // Cast: the SDK's accessor types clash with exactOptionalPropertyTypes.
      await mcp.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad_request", detail: "expected initialize or mcp-session-id" }));
  }

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) {
      if (s.lastSeen > cutoff) continue;
      sessions.delete(id);
      void s.transport.close();
      void s.mcp.close();
      logger.info("http.session_reaped", { sessions: sessions.size });
    }
  }, SESSION_SWEEP_MS);
  sweeper.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(t.port, t.bind, resolve);
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : t.port;
  actualPort = port;
  logger.info("http.listening", { bind: t.bind, port, auth: t.auth });
  if (!isLoopback(t.bind)) {
    logger.warn("http.non_loopback_bind", {
      bind: t.bind,
      note: "put a TLS reverse proxy in front; plain HTTP off-host is unsafe",
    });
  }

  return {
    server: httpServer,
    port,
    async close() {
      clearInterval(sweeper);
      for (const [id, s] of sessions) {
        sessions.delete(id);
        await s.transport.close();
        await s.mcp.close();
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
