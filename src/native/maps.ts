/**
 * Client for the resident maps-helper process (MapKit). No TCC subject —
 * MapKit search needs no user-data permission — but it does reach Apple's
 * map service, so the module's tools carry openWorldHint.
 */

import { type HelperClient, HelperProcessClient, resolveHelperBin } from "./client.ts";

export const MAPS_HELPER_BIN = "maps-helper";
export const MAPS_HELPER_ARGV: readonly string[] = Object.freeze(["--json-stdin"]);

export function resolveMapsHelperPath(): string {
  return resolveHelperBin(MAPS_HELPER_BIN, "APPLE_MCP_MAPS_HELPER", import.meta.dirname);
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
