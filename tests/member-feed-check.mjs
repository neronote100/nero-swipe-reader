import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = fs.readFileSync("members/member-feed.js", "utf8");
function article(creator, key, day) {
  return {
    url: `https://note.com/${creator}/n/n${key}`,
    key: `n${key}`,
    publishAt: `2026-11-${String(day).padStart(2, "0")}`,
    name: key,
  };
}
function fixture({
  pages = {},
  statuses = {},
  accounts = ["owner"],
  onProgress,
} = {}) {
  let current = 0;
  const statusCalls = [],
    creatorCalls = [],
    tokens = new Map();
  const A = {
    currentAccount: async () => ({
      ok: true,
      owner: accounts[Math.min(current++, accounts.length - 1)],
    }),
    bg: () => ({
      fetchCreatorContentsPage: async (name, page) => {
        creatorCalls.push([name, page]);
        const rows = pages[name];
        if (rows instanceof Error) throw rows;
        return rows || [];
      },
    }),
    noteAction: async (action, args) => {
      assert.equal(action, "status");
      assert.equal(args.force, true);
      statusCalls.push(args.articleUrl);
      const value = statuses[args.articleUrl];
      if (value instanceof Error) throw value;
      return value === undefined ? { ok: true, liked: false } : value;
    },
    progress: (port, id, value) =>
      onProgress?.(value, tokens.get("watch_feed")),
    jobToken: (name) => {
      const token = { cancelled: false };
      tokens.set(name, token);
      return token;
    },
    finishJob: (name) => tokens.delete(name),
  };
  const ctx = vm.createContext({
    NeroAppApiCore: A,
    crypto: webcrypto,
    URL,
    console,
  });
  vm.runInContext(source, ctx);
  return { api: ctx.NeroMemberFeed, statusCalls, creatorCalls, tokens };
}

// Sort each author's complete first page, take exactly 3, then filter liked.
// A fourth older post must not backfill a liked recent post.
const a1 = article("alice", "a1", 1),
  a2 = article("alice", "a2", 2),
  a3 = article("alice", "a3", 3),
  a4 = article("alice", "a4", 4);
const b1 = article("bob", "b1", 1);
let f = fixture({
  pages: {
    alice: [
      a1,
      a4,
      a3,
      a2,
      a3,
      { ...a4, url: "https://evil.example/alice/n/na4" },
    ],
    bob: [b1],
  },
  statuses: { [a3.url]: { ok: true, liked: true }, [b1.url]: { ok: false } },
});
let result = await f.api.fetch({}, "1", {
  expectedAccount: "owner",
  creators: ["alice", "bob", "alice", "bad user"],
});
assert.equal(result.ok, true);
assert.equal(result.totalCreators, 2);
assert.equal(result.candidateCount, 4);
assert.deepEqual([...result.items].map((x) => x.key).sort(), ["na2", "na4"]);
assert.equal(result.likedCount, 1);
assert.equal(result.statusFailedCount, 1);
assert.equal(result.partial, true);
assert.ok(!f.statusCalls.includes(a1.url));
assert.equal(f.creatorCalls.length, 2);
assert.equal(f.tokens.size, 0);

// The full pool is checked; there is no hidden 30-article batch cap.
const creators = Array.from({ length: 15 }, (_, i) => `user${i}`);
const pages = Object.fromEntries(
  creators.map((name, i) => [
    name,
    [1, 2, 3, 4].map((day) => article(name, `${i}_${day}`, day)),
  ]),
);
f = fixture({ pages });
result = await f.api.fetch({}, "many", { expectedAccount: "owner", creators });
assert.equal(result.items.length, 45);
assert.equal(f.statusCalls.length, 45);
assert.equal(new Set(result.items.map((x) => x.url)).size, 45);

f = fixture({
  pages: { alice: [a4], bob: new Error("offline"), empty: [] },
  statuses: { [a4.url]: { ok: true } },
});
result = await f.api.fetch({}, "unknown", {
  expectedAccount: "owner",
  creators: ["alice", "bob", "empty"],
});
assert.equal(result.items.length, 0);
assert.equal(result.statusFailedCount, 1, "missing like metadata is unknown");
assert.equal(result.failedCreators.join(), "bob");
assert.equal(result.emptyCreators.join(), "empty");

// Discard the complete result if the signed-in account changes during either phase.
for (const accounts of [
  ["other"],
  ["owner", "other"],
  ["owner", "owner", "other"],
]) {
  f = fixture({ pages: { alice: [a4] }, accounts });
  result = await f.api.fetch({}, "changed", {
    expectedAccount: "owner",
    creators: ["alice"],
  });
  assert.equal(result.code, "account_changed");
  assert.equal(result.items, undefined);
}

f = fixture();
result = await f.api.fetch({}, "empty", {
  expectedAccount: "owner",
  creators: [],
});
assert.equal(result.ok, true);
assert.equal(result.items.length, 0);
assert.equal(f.statusCalls.length, 0);
assert.equal(f.creatorCalls.length, 0);
assert.equal(
  (
    await f.api.fetch({}, "limit", {
      expectedAccount: "owner",
      creators: Array.from({ length: 201 }, (_, i) => `u${i}`),
    })
  ).code,
  "watchlist_limit",
);

f = fixture({
  pages: { alice: [a4] },
  onProgress: (p, token) => {
    if (p.phase === "likes") token.cancelled = true;
  },
});
result = await f.api.fetch({}, "cancel", {
  expectedAccount: "owner",
  creators: ["alice"],
});
assert.equal(result.cancelled, true);
assert.equal(result.items.length, 0);
assert.equal(f.statusCalls.length, 0);

// Deterministically prove Fisher-Yates performs a permutation without mutating its input.
const original = ["first", "second", "third", "fourth"];
assert.equal(
  f.api.shuffle(original, () => 0).join(),
  "second,third,fourth,first",
);
assert.equal(original.join(), "first,second,third,fourth");
assert.equal(f.api.articleUrl("javascript:alert(1)"), "");
console.log(
  "member-feed-check-ok: latest three, liked exclusion, full pool, failures, accounts, cancellation, shuffle",
);
