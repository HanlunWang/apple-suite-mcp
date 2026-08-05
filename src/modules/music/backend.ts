/**
 * Music backend — serialization boundary to the fixed JXA template
 * (native/music-jxa/music.js).
 */

import { z } from "zod";
import type { HelperRequest } from "../_template/module.ts";

export const SearchTracksInput = z.object({
  query: z.string().min(1).max(500).describe("Text to match against track, artist, or album."),
  limit: z.coerce.number().int().min(1).max(100).default(25).describe("Max results. Hard cap 100."),
});

export const PlayTrackInput = z.object({
  id: z.string().min(1).max(300).describe("Track persistent id (from music_search)."),
});

export type { HelperRequest };

export function serializeNowPlaying(): HelperRequest {
  return { op: "music.now_playing", args: {} };
}

export function serializeSearchTracks(input: unknown): HelperRequest {
  return { op: "music.search", args: SearchTracksInput.parse(input) };
}

export function serializePlayTrack(input: unknown): HelperRequest {
  return { op: "music.play_track", args: PlayTrackInput.parse(input) };
}

export function serializeControl(action: "play" | "pause" | "next" | "previous"): HelperRequest {
  return { op: `music.${action}`, args: {} };
}

/* Output shapes */

export const TrackOut = z.object({
  id: z.string(),
  name: z.string(),
  artist: z.string(),
  album: z.string(),
  durationSeconds: z.number(),
});

export const PlaybackOut = z.object({
  state: z.string(),
  track: TrackOut.optional(),
  positionSeconds: z.number().optional(),
});
