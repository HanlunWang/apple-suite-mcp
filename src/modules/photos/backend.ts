/**
 * Photos backend — serialization boundary to the native photos-helper.
 * Metadata only; the helper never returns image data.
 */

import { z } from "zod";

const isoDateTime = () => z.iso.datetime({ offset: true });

export const ListAssetsInput = z.object({
  albumId: z
    .string()
    .max(300)
    .optional()
    .describe("Restrict to one album (id from photos_list_albums). Default: whole library."),
  from: isoDateTime().optional().describe("Only assets created at/after this time (ISO 8601)."),
  to: isoDateTime().optional().describe("Only assets created at/before this time (ISO 8601)."),
  favoritesOnly: z.boolean().default(false).describe("Only favorites."),
  limit: z.coerce.number().int().min(1).max(500).default(50).describe("Max assets. Hard cap 500."),
});

export interface HelperRequest {
  op: string;
  args: Record<string, unknown>;
}

export function serializeListAlbums(): HelperRequest {
  return { op: "photos.list_albums", args: {} };
}

export function serializeListAssets(input: unknown): HelperRequest {
  return { op: "photos.list", args: ListAssetsInput.parse(input) };
}

/* Output shapes */

export const AlbumOut = z.object({
  id: z.string(),
  title: z.string(),
  count: z.number(),
});

export const AssetOut = z.object({
  id: z.string(),
  createdAt: z.string().nullable().optional(),
  mediaType: z.string(),
  favorite: z.boolean(),
  width: z.number(),
  height: z.number(),
});
