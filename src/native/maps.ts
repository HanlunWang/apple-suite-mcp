/**
 * Client for the resident maps-helper process (MapKit). No TCC subject —
 * MapKit search needs no user-data permission — but it does reach Apple's
 * map service, so the module's tools carry openWorldHint.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HelperCallError,
  type HelperClient,
  HelperProcessClient,
  packageRoot,
} from "./client.ts";

export const MAPS_HELPER_BIN = "maps-helper";
export const MAPS_HELPER_ARGV: readonly string[] = Object.freeze(["--json-stdin"]);

export function resolveMapsHelperPath(): string {
  const override = process.env["APPLE_MCP_MAPS_HELPER"];
  if (override) return override;

  const root = packageRoot(import.meta.dirname);
  const candidates = [
    join(root, "native", "maps-helper", ".build", "release", MAPS_HELPER_BIN),
    join(root, "native", "maps-helper", ".build", "debug", MAPS_HELPER_BIN),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new HelperCallError(
    "helper_missing",
    `${MAPS_HELPER_BIN} binary not found`,
    `Build it with "npm run build:native" (requires Xcode command line tools), ` +
      `or point APPLE_MCP_MAPS_HELPER at the binary.`,
  );
}

export class MapsHelperClient extends HelperProcessClient {
  constructor(binPath?: string, timeoutMs?: number) {
    super(binPath ?? resolveMapsHelperPath(), MAPS_HELPER_ARGV, timeoutMs);
  }
}

let shared: MapsHelperClient | undefined;

export function sharedMapsClient(): HelperClient {
  return (shared ??= new MapsHelperClient());
}
