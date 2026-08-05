/**
 * Music module (JXA fixed-template backend). Reads are library metadata and
 * playback state; writes are playback controls — audible side effects, but
 * they touch no user data and send nothing anywhere, so they are not
 * destructive and need no confirmation.
 */

import { z } from "zod";
import type { HelperClient } from "../../native/client.ts";
import { sharedMusicClient } from "../../native/music.ts";
import type { AppModule, Mode, ResourceDef, ToolDef } from "../_template/module.ts";
import {
  PlaybackOut,
  PlayTrackInput,
  SearchTracksInput,
  TrackOut,
  serializeControl,
  serializeNowPlaying,
  serializePlayTrack,
  serializeSearchTracks,
} from "./backend.ts";

export function createMusicModule(client: HelperClient = sharedMusicClient()): AppModule {
  const call = <T>(req: { op: string; args: Record<string, unknown> }) =>
    client.call<T>(req.op, req.args);

  const readTools: ToolDef[] = [
    {
      name: "music_now_playing",
      title: "Now playing",
      description: "Report the current playback state and track, if any.",
      inputSchema: {},
      outputSchema: { playback: PlaybackOut, _untrusted: z.boolean() },
      mode: "read",
      actionId: "music.now_playing",
      annotations: { idempotentHint: true },
      run: async () => ({ playback: await call(serializeNowPlaying()), _untrusted: true }),
    },
    {
      name: "music_search",
      title: "Search library",
      description:
        "Search the user's Music library by track, artist, or album text. " +
        "Returns track ids usable with music_play_track.",
      inputSchema: SearchTracksInput.shape,
      outputSchema: { tracks: z.array(TrackOut), _untrusted: z.boolean() },
      mode: "read",
      actionId: "music.search",
      annotations: { idempotentHint: true },
      run: async (input) => ({ tracks: await call(serializeSearchTracks(input)), _untrusted: true }),
    },
  ];

  const control = (
    name: string,
    action: "play" | "pause" | "next" | "previous",
    description: string,
  ): ToolDef => ({
    name,
    title: name.replace(/_/g, " "),
    description,
    inputSchema: {},
    outputSchema: { playback: PlaybackOut },
    mode: "write",
    actionId: `music.${action}`,
    annotations: { destructiveHint: false },
    run: async () => ({ playback: await call(serializeControl(action)) }),
  });

  const writeTools: ToolDef[] = [
    control("music_play", "play", "Resume playback."),
    control("music_pause", "pause", "Pause playback."),
    control("music_next", "next", "Skip to the next track."),
    control("music_previous", "previous", "Go back to the previous track."),
    {
      name: "music_play_track",
      title: "Play track",
      description: "Play a specific track by id (from music_search).",
      inputSchema: PlayTrackInput.shape,
      outputSchema: { playback: PlaybackOut },
      mode: "write",
      actionId: "music.play_track",
      annotations: { destructiveHint: false },
      run: async (input) => ({ playback: await call(serializePlayTrack(input)) }),
    },
  ];

  const resources: ResourceDef[] = [
    {
      uriTemplate: "music://now-playing",
      name: "music-now-playing",
      title: "Now playing",
      description: "Current playback state as JSON.",
      read: async () => await call(serializeNowPlaying()),
    },
  ];

  return {
    id: "music",
    resources: () => resources,
    tools: (mode: Mode) => (mode === "write" ? [...readTools, ...writeTools] : readTools),
  };
}
