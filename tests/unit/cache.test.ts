import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ReadCache } from "../../src/cache.ts";

describe("ReadCache", () => {
  it("is disabled at ttl 0 and never stores anything", () => {
    const cache = new ReadCache(0, 10);
    assert.equal(cache.enabled, false);
    cache.set("calendar", "list", {}, "value");
    assert.equal(cache.get("calendar", "list", {}), undefined);
  });

  it("keys on module + tool + arguments", () => {
    const cache = new ReadCache(30, 10);
    cache.set("calendar", "list", { a: 1 }, "one");
    assert.equal(cache.get("calendar", "list", { a: 1 }), "one");
    assert.equal(cache.get("calendar", "list", { a: 2 }), undefined, "different args miss");
    assert.equal(cache.get("calendar", "other", { a: 1 }), undefined, "different tool misses");
    assert.equal(cache.get("notes", "list", { a: 1 }), undefined, "different module misses");
  });

  it("expires entries after the ttl", () => {
    const cache = new ReadCache(10, 10);
    const t0 = 1_000_000;
    cache.set("music", "now", {}, "playing", t0);
    assert.equal(cache.get("music", "now", {}, t0 + 9_000), "playing");
    assert.equal(cache.get("music", "now", {}, t0 + 10_001), undefined);
  });

  it("invalidateModule drops only that module's entries", () => {
    const cache = new ReadCache(30, 10);
    cache.set("music", "now", {}, "a");
    cache.set("maps", "search", {}, "b");
    cache.invalidateModule("music");
    assert.equal(cache.get("music", "now", {}), undefined);
    assert.equal(cache.get("maps", "search", {}), "b");
  });

  it("evicts the oldest entry past maxEntries", () => {
    const cache = new ReadCache(30, 2);
    cache.set("m", "t", { i: 1 }, "one");
    cache.set("m", "t", { i: 2 }, "two");
    cache.set("m", "t", { i: 3 }, "three");
    assert.equal(cache.get("m", "t", { i: 1 }), undefined, "oldest evicted");
    assert.equal(cache.get("m", "t", { i: 3 }), "three");
  });
});
