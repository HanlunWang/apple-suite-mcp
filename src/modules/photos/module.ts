/**
 * Photos module (PhotosKit via photos-helper — its own revocable TCC
 * subject). Read-only metadata: albums and asset attributes. Image data is
 * never read or transmitted, and nothing in the library is ever modified.
 */

import { z } from "zod";
import type { HelperClient } from "../../native/client.ts";
import { sharedPhotosClient } from "../../native/photos.ts";
import type { AppModule, Mode, ResourceDef, ToolDef } from "../_template/module.ts";
import {
  AlbumOut,
  AssetOut,
  ListAssetsInput,
  serializeListAlbums,
  serializeListAssets,
} from "./backend.ts";

export function createPhotosModule(client: HelperClient = sharedPhotosClient()): AppModule {
  const call = <T>(req: { op: string; args: Record<string, unknown> }) =>
    client.call<T>(req.op, req.args);

  const readTools: ToolDef[] = [
    {
      name: "photos_list_albums",
      title: "List albums",
      description: "List the user's photo albums (id, title, asset count).",
      inputSchema: {},
      outputSchema: { albums: z.array(AlbumOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "photos.list",
      annotations: { idempotentHint: true },
      run: async () => ({ albums: await call(serializeListAlbums()), _untrusted: true }),
    },
    {
      name: "photos_list",
      title: "List photo metadata",
      description:
        "List photo/video METADATA (id, creation time, dimensions, favorite " +
        "flag), newest first, optionally filtered by album, date range, or " +
        "favorites. Image data is never returned.",
      inputSchema: ListAssetsInput.shape,
      outputSchema: { assets: z.array(AssetOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "photos.list",
      annotations: { idempotentHint: true },
      run: async (input) => ({ assets: await call(serializeListAssets(input)), _untrusted: true }),
    },
  ];

  const resources: ResourceDef[] = [
    {
      uriTemplate: "photos://albums",
      name: "photos-albums",
      title: "Photo albums",
      description: "The user's photo albums as JSON.",
      read: async () => await call(serializeListAlbums()),
    },
  ];

  return {
    id: "photos",
    resources: () => resources,
    tools: (_mode: Mode) => readTools,
  };
}
