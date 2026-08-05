// music.js — FIXED JXA template for the music module (DESIGN.md §5.1).
//
// SECURITY CONTRACT: identical to the other JXA templates — constant file,
// one JSON request on stdin, untrusted data only as parsed JSON values and
// structured whose-predicates. Scanned by the CI injection guard.
//
// Playback control has audible side effects but touches no user data and
// sends nothing anywhere; the library is read-only metadata.

ObjC.import("Foundation");

function readStdin() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
}

function clampLimit(limit, fallback) {
  const n = Number.isFinite(limit) ? Math.trunc(limit) : fallback;
  return Math.min(Math.max(n, 1), 100);
}

function trackDTO(t) {
  return {
    id: t.persistentID(),
    name: t.name(),
    artist: t.artist(),
    album: t.album(),
    durationSeconds: t.duration(),
  };
}

function nowPlaying(app) {
  const state = app.playerState();
  const info = { state: String(state) };
  if (state !== "stopped") {
    try {
      info.track = trackDTO(app.currentTrack);
      info.positionSeconds = app.playerPosition();
    } catch (e) {
      // No current track — leave info.track unset.
    }
  }
  return info;
}

function handle(req) {
  const app = Application("Music");
  const args = req.args || {};
  switch (req.op) {
    case "ping":
      return { pong: true, version: "1.0.0" };

    case "music.now_playing":
      return nowPlaying(app);

    case "music.play":
      app.play();
      return nowPlaying(app);

    case "music.pause":
      app.pause();
      return nowPlaying(app);

    case "music.next":
      app.nextTrack();
      return nowPlaying(app);

    case "music.previous":
      app.previousTrack();
      return nowPlaying(app);

    case "music.search": {
      const query = String(args.query || "");
      if (!query) {
        const err = new Error("query must not be empty");
        err.code = "invalid_request";
        throw err;
      }
      const limit = clampLimit(args.limit, 25);
      // Structured whose-predicate: the query is a VALUE, not script text.
      const tracks = app.tracks.whose({
        _or: [
          { name: { _contains: query } },
          { artist: { _contains: query } },
          { album: { _contains: query } },
        ],
      })();
      return tracks.slice(0, limit).map(trackDTO);
    }

    case "music.play_track": {
      const id = String(args.id || "");
      if (!id) {
        const err = new Error("id is required (from music_search)");
        err.code = "invalid_request";
        throw err;
      }
      const tracks = app.tracks.whose({ persistentID: id })();
      if (tracks.length === 0) {
        const err = new Error("no track with id " + id);
        err.code = "not_found";
        throw err;
      }
      app.play(tracks[0]);
      return nowPlaying(app);
    }

    default: {
      const err = new Error("unknown op " + String(req.op));
      err.code = "invalid_request";
      throw err;
    }
  }
}

function run() {
  let id = 0;
  try {
    const req = JSON.parse(readStdin());
    id = req.id || 0;
    return JSON.stringify({ id: id, ok: true, data: handle(req) });
  } catch (e) {
    const message = e && e.message ? String(e.message) : "internal error";
    const code = e && e.code ? String(e.code) : inferCode(message);
    const hint = e && e.hint ? String(e.hint) : hintFor(code);
    return JSON.stringify({
      id: id,
      ok: false,
      error: { code: code, message: message, hint: hint },
    });
  }
}

function inferCode(message) {
  if (message.indexOf("-1743") !== -1 || /not allowed/i.test(message)) return "permission_denied";
  return "internal";
}

function hintFor(code) {
  if (code === "permission_denied") {
    return (
      "Allow automation of Music in System Settings → Privacy & Security → " +
      "Automation for the process running the MCP server, then retry."
    );
  }
  return undefined;
}
