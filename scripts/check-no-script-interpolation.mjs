#!/usr/bin/env node
/**
 * CI guard (DESIGN.md §5.1): fail the build if any source file interpolates a
 * variable into what looks like AppleScript / osascript / shell text. This is
 * the static counterpart to tests/injection.
 *
 * Scope note, so a green run is not mistaken for proof: this is a coarse
 * lexical check, not a taint analysis. The real guarantee comes from the
 * architecture (fixed JXA templates, JSON on stdin, parameterized SQL,
 * execFile with array argv) and from tests/injection/. What this catches is
 * an accidental reintroduction of the upstream pattern.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, resolve, dirname } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

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
  // a command string built by interpolation or concatenation, in any spawn form
  /(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(\s*`[^`]*\$\{/s,
  /(exec|execSync|spawn|spawnSync)\s*\(\s*["'][^"']*["']\s*\+/s,
  // shell: true opts out of argv safety
  /shell\s*:\s*true/,
  // dynamic code evaluation
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
];

const failures = [];
let scanned = 0;

function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (![".ts", ".mjs", ".js"].includes(extname(p))) continue;
    scanned++;
    const src = readFileSync(p, "utf8");
    for (const re of BAD) if (re.test(src)) failures.push(`${p}  ::  ${re}`);
  }
}

// Fail closed: a missing or renamed root must break the build rather than
// silently scanning nothing and reporting success.
for (const r of ROOTS) {
  const abs = join(REPO_ROOT, r);
  try {
    if (!statSync(abs).isDirectory()) throw new Error("not a directory");
  } catch {
    console.error(`✖ scan root missing: ${r}`);
    console.error("  Update ROOTS in scripts/check-no-script-interpolation.mjs.");
    process.exit(1);
  }
  walk(abs);
}

// A guard that scans nothing passes vacuously; assert it actually saw files.
const MIN_FILES = 40;
if (scanned < MIN_FILES) {
  console.error(`✖ only ${scanned} files scanned (expected >= ${MIN_FILES}) — the guard is not covering the tree`);
  process.exit(1);
}

if (failures.length) {
  console.error("✖ Forbidden script/shell interpolation detected:");
  for (const f of failures) console.error("  " + f);
  console.error("\nPass untrusted data as structured args to the native helper. See DESIGN.md §5.1.");
  process.exit(1);
}
console.log(`✓ no script/shell interpolation found (${scanned} files scanned)`);
