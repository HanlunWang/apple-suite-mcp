/**
 * Parameterized read-only queries against the Messages chat.db.
 *
 * SECURITY (DESIGN.md §5.1): every statement is a PREPARED better-sqlite3
 * statement with bound parameters. SQL text is constant; untrusted values
 * (search queries, chat guids) travel exclusively as bind values. LIKE
 * patterns escape the SQLite wildcards so a query is always a literal
 * substring match. Pinned by the injection regression suite against a real
 * in-memory database.
 *
 * Pure functions over an injected Database handle — unit-testable without
 * Full Disk Access.
 */

import type { Database } from "better-sqlite3";

/** Apple epoch (2001-01-01) offset; message.date is nanoseconds since then. */
const APPLE_EPOCH_MS = 978_307_200_000;

export function appleNsToIso(ns: number | bigint | null): string | null {
  if (ns === null || ns === undefined) return null;
  const n = typeof ns === "bigint" ? Number(ns) : ns;
  if (!Number.isFinite(n) || n === 0) return null;
  return new Date(APPLE_EPOCH_MS + n / 1e6).toISOString();
}

/** Escape LIKE wildcards so user input matches literally (ESCAPE '\'). */
export function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * On modern macOS the plain-text column is often NULL and the content lives
 * in the attributedBody typedstream blob. This extracts the NSString payload
 * heuristically; returns null when the layout is unrecognized.
 */
export function extractText(text: string | null, blob: Buffer | null): string | null {
  if (text) return text;
  if (!blob) return null;
  try {
    const marker = blob.indexOf("NSString");
    if (marker === -1) return null;
    // Layout: "NSString" + 01 94 84 01 2b ('+') + length (1 byte, or 0x81 + uint16le)
    let i = marker + 8 + 5;
    const lead = blob[i];
    if (lead === undefined) return null;
    let length: number;
    if (lead === 0x81) {
      length = blob.readUInt16LE(i + 1);
      i += 3;
    } else {
      length = lead;
      i += 1;
    }
    if (i + length > blob.length) return null;
    return blob.subarray(i, i + length).toString("utf8");
  } catch {
    return null;
  }
}

export interface ChatRow {
  guid: string;
  identifier: string;
  displayName: string | null;
  participants: string | null;
  lastMessageAt: string | null;
}

export interface MessageRow {
  guid: string;
  chatGuid: string;
  sender: string | null;
  fromMe: boolean;
  at: string | null;
  text: string | null;
}

interface RawChat {
  guid: string;
  chat_identifier: string;
  display_name: string | null;
  participants: string | null;
  last_date: number | null;
}

interface RawMessage {
  guid: string;
  chat_guid: string;
  sender: string | null;
  is_from_me: number;
  date: number | null;
  text: string | null;
  attributedBody: Buffer | null;
}

const CHATS_SQL = `
  SELECT c.guid, c.chat_identifier, c.display_name,
         (SELECT GROUP_CONCAT(h.id, ', ')
            FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
           WHERE chj.chat_id = c.ROWID) AS participants,
         MAX(m.date) AS last_date
    FROM chat c
    JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    JOIN message m ON m.ROWID = cmj.message_id
   GROUP BY c.ROWID
   ORDER BY last_date DESC
   LIMIT @limit`;

const MESSAGES_SQL = `
  SELECT m.guid, c.guid AS chat_guid, h.id AS sender, m.is_from_me, m.date,
         m.text, m.attributedBody
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
   WHERE (@chatGuid IS NULL OR c.guid = @chatGuid)
   ORDER BY m.date DESC
   LIMIT @limit`;

const SEARCH_SQL = `
  SELECT m.guid, c.guid AS chat_guid, h.id AS sender, m.is_from_me, m.date,
         m.text, m.attributedBody
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
   WHERE m.text LIKE @pattern ESCAPE '\\'
   ORDER BY m.date DESC
   LIMIT @limit`;

function toMessageRow(r: RawMessage): MessageRow {
  return {
    guid: r.guid,
    chatGuid: r.chat_guid,
    sender: r.is_from_me ? null : r.sender,
    fromMe: r.is_from_me === 1,
    at: appleNsToIso(r.date),
    text: extractText(r.text, r.attributedBody),
  };
}

export function listChats(db: Database, limit: number): ChatRow[] {
  const rows = db.prepare(CHATS_SQL).all({ limit }) as RawChat[];
  return rows.map((r) => ({
    guid: r.guid,
    identifier: r.chat_identifier,
    displayName: r.display_name || null,
    participants: r.participants,
    lastMessageAt: appleNsToIso(r.last_date),
  }));
}

export function listMessages(db: Database, chatGuid: string | null, limit: number): MessageRow[] {
  const rows = db.prepare(MESSAGES_SQL).all({ chatGuid, limit }) as RawMessage[];
  return rows.map(toMessageRow);
}

export function searchMessages(db: Database, query: string, limit: number): MessageRow[] {
  const pattern = `%${escapeLike(query)}%`;
  const rows = db.prepare(SEARCH_SQL).all({ pattern, limit }) as RawMessage[];
  return rows.map(toMessageRow);
}
