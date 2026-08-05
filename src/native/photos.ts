/**
 * Client for the resident photos-helper process (Photos.framework) — its own
 * revocable TCC subject. Metadata reads only; no pixels, no mutations.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HelperCallError,
  type HelperClient,
  HelperProcessClient,
  packageRoot,
} from "./client.ts";

export const PHOTOS_HELPER_BIN = "photos-helper";
export const PHOTOS_HELPER_ARGV: readonly string[] = Object.freeze(["--json-stdin"]);

export function resolvePhotosHelperPath(): string {
  const override = process.env["APPLE_MCP_PHOTOS_HELPER"];
  if (override) return override;

  const root = packageRoot(import.meta.dirname);
  const candidates = [
    join(root, "native", "photos-helper", ".build", "release", PHOTOS_HELPER_BIN),
    join(root, "native", "photos-helper", ".build", "debug", PHOTOS_HELPER_BIN),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new HelperCallError(
    "helper_missing",
    `${PHOTOS_HELPER_BIN} binary not found`,
    `Build it with "npm run build:native" (requires Xcode command line tools), ` +
      `or point APPLE_MCP_PHOTOS_HELPER at the binary.`,
  );
}

export class PhotosHelperClient extends HelperProcessClient {
  constructor(binPath?: string, timeoutMs?: number) {
    super(binPath ?? resolvePhotosHelperPath(), PHOTOS_HELPER_ARGV, timeoutMs);
  }
}

let shared: PhotosHelperClient | undefined;

export function sharedPhotosClient(): HelperClient {
  return (shared ??= new PhotosHelperClient());
}
