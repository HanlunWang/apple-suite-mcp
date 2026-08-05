/**
 * Runner for the Music JXA backend — the fixed template at
 * native/music-jxa/music.js. See src/native/jxa.ts for the contract.
 */

import { join } from "node:path";
import { type HelperClient, packageRoot } from "./client.ts";
import { JxaScriptClient } from "./jxa.ts";

export function musicScriptPath(): string {
  return join(packageRoot(import.meta.dirname), "native", "music-jxa", "music.js");
}

export class JxaMusicClient extends JxaScriptClient {
  constructor(timeoutMs?: number) {
    super(musicScriptPath(), "music", timeoutMs);
  }
}

let shared: JxaMusicClient | undefined;

export function sharedMusicClient(): HelperClient {
  return (shared ??= new JxaMusicClient());
}
