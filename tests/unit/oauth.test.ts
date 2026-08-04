/**
 * OAuth 2.1 resource-server verification against a local mock authorization
 * server. The load-bearing assertion is AUDIENCE REJECTION: a validly-signed
 * token minted for a DIFFERENT service must not authenticate here
 * (confused-deputy / token-passthrough defense, DESIGN.md §1/§4).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

import { OAuthAuthenticator } from "../../src/transport/auth.ts";

const AUDIENCE = "https://mcp.example.test/mcp";

let asServer: Server;
let issuer: string;
let privateKey: CryptoKey;

before(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), alg: "RS256", use: "sig", kid: "test-key" };

  asServer = createServer((req, res) => {
    if (req.url === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    } else if (req.url === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => asServer.listen(0, "127.0.0.1", resolve));
  const addr = asServer.address();
  issuer = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(() => new Promise<void>((resolve) => asServer.close(() => resolve())));

async function mintToken(opts: { aud?: string; iss?: string; expired?: boolean }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: "mcp" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(opts.iss ?? issuer)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject("user-1")
    .setIssuedAt(opts.expired ? now - 7200 : now)
    .setExpirationTime(opts.expired ? now - 3600 : now + 3600)
    .sign(privateKey);
}

describe("OAuth 2.1 resource server", () => {
  it("accepts a valid token for THIS server's audience", async () => {
    const auth = new OAuthAuthenticator({ issuer, audience: AUDIENCE });
    const result = await auth.authenticate(`Bearer ${await mintToken({})}`);
    assert.equal(result.ok, true);
  });

  it("REJECTS a validly-signed token minted for another service", async () => {
    const auth = new OAuthAuthenticator({ issuer, audience: AUDIENCE });
    const foreign = await mintToken({ aud: "https://some-other-api.example.test" });
    const result = await auth.authenticate(`Bearer ${foreign}`);
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_token");
  });

  it("rejects an expired token", async () => {
    const auth = new OAuthAuthenticator({ issuer, audience: AUDIENCE });
    const result = await auth.authenticate(`Bearer ${await mintToken({ expired: true })}`);
    assert.equal(result.ok, false);
  });

  it("rejects tokens from a different issuer", async () => {
    const auth = new OAuthAuthenticator({ issuer, audience: AUDIENCE });
    const result = await auth.authenticate(
      `Bearer ${await mintToken({ iss: "https://evil.example.test" })}`,
    );
    assert.equal(result.ok, false);
  });

  it("rejects garbage and missing tokens", async () => {
    const auth = new OAuthAuthenticator({ issuer, audience: AUDIENCE });
    assert.equal((await auth.authenticate(undefined)).ok, false);
    assert.equal((await auth.authenticate("Bearer not.a.jwt")).ok, false);
    assert.equal((await auth.authenticate("Basic dXNlcjpwdw==")).ok, false);
  });
});
