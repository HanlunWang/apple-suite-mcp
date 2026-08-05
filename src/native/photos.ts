/**
 * Client for the resident photos-helper process (Photos.framework) — its own
 * revocable TCC subject. Metadata reads only; no pixels, no mutations.
 */

import { type HelperClient, HelperProcessClient, resolveHelperBin } from "./client.ts";

export const PHOTOS_HELPER_BIN = "photos-helper";
export const PHOTOS_HELPER_ARGV: readonly string[] = Object.freeze(["--json-stdin"]);

export function resolvePhotosHelperPath(): string {
  return resolveHelperBin(PHOTOS_HELPER_BIN, "APPLE_MCP_PHOTOS_HELPER", import.meta.dirname);
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
