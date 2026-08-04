/**
 * Streamable HTTP transport end-to-end on a real loopback socket:
 * auth required, sessions established, remote surface applied.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { type AppConfig, TransportConfig, defaultConfig } from "../../src/config.ts";
import { apiKeyPath } from "../../src/transport/auth.ts";
import { type HttpServerHandle, startHttpServer } from "../../src/transport/http.ts";
import { buildMcpServer } from "../../src/server.ts";

let dir: string;
let handle: HttpServerHandle;
let apiKey: string;
let base: string;

function makeConfig(): AppConfig {
  const cfg = defaultConfig();
  cfg.modules.calendar = { enabled: true, mode: "read" };
  cfg.transport = TransportConfig.parse({ type: "http", auth: "apikey", port: 0 });
  return cfg;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "apple-mcp-http-"));
  process.env["APPLE_MCP_CONFIG_DIR"] = dir;
  const cfg = makeConfig();
  handle = await startHttpServer(cfg, () => buildMcpServer(cfg, { remote: true }));
  apiKey = readFileSync(apiKeyPath(), "utf8").trim();
  base = `http://127.0.0.1:${handle.port}`;
});
after(async () => {
  await handle.close();
  delete process.env["APPLE_MCP_CONFIG_DIR"];
  rmSync(dir, { recursive: true, force: true });
});

const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
});

async function connectClient(key: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "http-test", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe("streamable HTTP transport", () => {
  it("rejects unauthenticated requests with 401 + WWW-Authenticate", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /Bearer/);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata/);
  });

  it("rejects a wrong api key in constant-time comparison path", async () => {
    await assert.rejects(connectClient("0".repeat(64)));
  });

  it("serves protected-resource metadata without auth", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    assert.equal(res.status, 200);
    const meta = (await res.json()) as { bearer_methods_supported: string[] };
    assert.deepEqual(meta.bearer_methods_supported, ["header"]);
  });

  it("authenticated client completes the handshake and gets the REMOTE surface", async () => {
    const client = await connectClient(apiKey);
    const names = (await client.listTools()).tools.map((t) => t.name);
    // calendar enabled read-only → read tools present…
    assert.ok(names.includes("calendar_list_events"));
    // …but the local-only enable-request meta tool is absent remotely.
    assert.ok(names.includes("capabilities_list"));
    assert.ok(!names.includes("capabilities_request_enable"));
  });

  it("two clients get independent sessions", async () => {
    const a = await connectClient(apiKey);
    const b = await connectClient(apiKey);
    const [ra, rb] = await Promise.all([
      a.callTool({ name: "capabilities_list", arguments: {} }),
      b.callTool({ name: "capabilities_list", arguments: {} }),
    ]);
    assert.notEqual(ra.isError, true);
    assert.notEqual(rb.isError, true);
  });

  it("unknown session id → 404", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${apiKey}`,
        "mcp-session-id": "not-a-real-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    assert.equal(res.status, 404);
  });
});
