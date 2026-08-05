#!/usr/bin/env node
/**
 * CI guard (DESIGN.md §5.1): fail the build if any source file interpolates a
 * variable into what looks like AppleScript / osascript / shell text. This is
 * the static counterpart to tests/injection.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

// The JXA templates are executable source — the guard must cover them too.
const ROOTS = [
  "src",
  "cli",
  "native/notes-jxa",
  "native/mail-jxa",
  "native/messages-jxa",
  "native/music-jxa",
];
const BAD = [
  // `runAppleScript(` ... ${...}
  /runAppleScript\s*\(\s*`[^`]*\$\{/s,
  // template literal containing shell/AppleScript primitives AND an interpolation
  /`[^`]*(do shell script|osascript|tell application)[^`]*\$\{/is,
  // exec/execSync/spawn with an interpolated command string
  /(exec|execSync|spawn)\s*\(\s*`[^`]*\$\{/s,
];

let failures = [];
function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (![".ts", ".mjs", ".js"].includes(extname(p))) continue;
    const src = readFileSync(p, "utf8");
    for (const re of BAD) if (re.test(src)) failures.push(`${p}  ::  ${re}`);
  }
}
for (const r of ROOTS) { try { walk(r); } catch {} }

if (failures.length) {
  console.error("✖ Forbidden script/shell interpolation detected:");
  for (const f of failures) console.error("  " + f);
  console.error("\nPass untrusted data as structured args to the native helper. See DESIGN.md §5.1.");
  process.exit(1);
}
console.log("✓ no script/shell interpolation found");
