import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = fs.readFileSync("members/member-feed.js", "utf8");
function article(creator, key, rank) {
  return {
    url: `https://note.com/${creator}/n/n${key}`,
    key: `n${key}`,
    publishAt: new Date(Date.UTC(2026, 10, 1) + rank * 60000).toISOString(),
    name: key,
  };
}
function fixture({
  pages = {},
  statuses = {},
  accounts = ["owner"],
  getAccount,
  onPage,
  onStatus,
  onProgress,
  statusDelay = false,
} = {}) {
  let current = 0,
    activeStatuses = 0,
    maxStatuses = 0;
  const statusCalls = [],
    creatorCalls = [],
    tokens = new Map();
  const activeByCreator = new Map(),
    maxByCreator = new Map();
  const A = {
    currentAccount: async () => ({
      ok: true,
      owner: getAccount
        ? getAccount()
        : accounts[Math.min(current++, accounts.length - 1)],
    }),
    bg: () => ({
      fetchCreatorContentsPage: async (name, page) => {
        creatorCalls.push([name, page]);
        const rows = pages[name];
        const result =
          typeof rows === "function"
            ? await rows(page)
            : Array.isArray(rows)
              ? page === 1
                ? rows
                : []
              : rows instanceof Error
                ? rows
                : (rows?.[page] ?? []);
        await onPage?.(name, page, tokens.get("watch_feed"));
        if (result instanceof Error) throw result;
        return result;
      },
    }),
    noteAction: async (action, args) => {
      assert.equal(action, "status");
      assert.equal(args.force, true);
      statusCalls.push(args.articleUrl);
      const creator = new URL(args.articleUrl).pathname.split("/")[1];
      activeStatuses++;
      activeByCreator.set(creator, (activeByCreator.get(creator) || 0) + 1);
      maxStatuses = Math.max(maxStatuses, activeStatuses);
      maxByCreator.set(
        creator,
        Math.max(maxByCreator.get(creator) || 0, activeByCreator.get(creator)),
      );
      try {
        if (statusDelay) await new Promise((resolve) => setTimeout(resolve, 1));
        await onStatus?.(args.articleUrl, tokens.get("watch_feed"));
        const value =
          typeof statuses === "function"
            ? await statuses(args.articleUrl)
            : statuses[args.articleUrl];
        if (value instanceof Error) throw value;
        return value === undefined ? { ok: true, liked: false } : value;
      } finally {
        activeStatuses--;
        activeByCreator.set(creator, activeByCreator.get(creator) - 1);
      }
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
  return {
    api: ctx.NeroMemberFeed,
    statusCalls,
    creatorCalls,
    tokens,
    maxByCreator,
    get maxStatuses() {
      return maxStatuses;
    },
  };
}
function fetch(f, args = {}) {
  return f.api.fetch({}, "request", {
    expectedAccount: "owner",
    creators: ["alice"],
    ...args,
  });
}
const keys = (result) => [...result.items].map((item) => item.key).sort();
const a = Array.from({ length: 8 }, (_, i) =>
  article("alice", `a${i + 1}`, i + 1),
);

// Sort each page before selection, skip liked/unknown, and backfill older rows.
let f = fixture({
  pages: {
    alice: { 1: [a[7], a[5], a[6], a[7]], 2: [a[6], a[4], a[3]], 3: [a[2]] },
    bob: [article("bob", "b1", 1)],
  },
  statuses: {
    [a[7].url]: { ok: true, liked: true },
    [a[6].url]: { ok: true },
    [a[5].url]: { ok: false },
    [a[4].url]: { ok: true, liked: true },
  },
});
let result = await fetch(f, {
  creators: ["alice", "bob", "alice", "bad user"],
});
assert.equal(result.ok, true);
assert.equal(result.totalCreators, 2);
assert.deepEqual(keys(result), ["na3", "na4", "nb1"]);
assert.equal(result.candidateCount, 7);
assert.equal(result.checkedArticles, 7);
assert.equal(result.likedCount, 2);
assert.equal(result.statusFailedCount, 2);
assert.equal(result.partial, true);
assert.equal(result.shortfallCreators[0].creator, "alice");
assert.equal(result.shortfallCreators[0].reason, "exhausted");
assert.equal(
  f.statusCalls.filter((url) => url === a[6].url).length,
  1,
  "no duplicate status calls across pages",
);
assert.equal(f.tokens.size, 0);

// A short page continues. Stop as soon as three unliked posts are found.
f = fixture({
  pages: { alice: { 1: [a[7]], 2: [a[6]], 3: [a[5], a[4], a[3]] } },
});
result = await fetch(f);
assert.deepEqual(keys(result), ["na6", "na7", "na8"]);
assert.equal(f.statusCalls.length, 3);
assert.equal(result.candidateCount, 3);
assert.equal(f.creatorCalls.length, 3);
assert.equal(result.shortfallCreators.length, 0);

// Include-liked mode never depends on a status endpoint or invents false metadata.
f = fixture({
  pages: {
    alice: [
      { ...a[2], liked: true },
      a[7],
      { ...a[6], liked: "unknown" },
      a[5],
    ],
  },
  statuses: () => {
    throw new Error("must not run");
  },
});
result = await fetch(f, { includeLiked: true });
assert.deepEqual(keys(result), ["na6", "na7", "na8"]);
assert.equal(result.includeLiked, true);
assert.equal(result.candidateCount, 3);
assert.equal(result.checkedArticles, 0);
assert.equal(f.statusCalls.length, 0);
assert.equal(
  result.items.every((item) => item.liked === undefined),
  true,
);
f = fixture({ pages: { alice: [{ ...a[7], liked: true }, a[6], a[5]] } });
result = await fetch(f, { includeLiked: true });
assert.equal(result.items.find((item) => item.key === "na8").liked, true);

// Deep mode examines a single requested creator, backfills to fifty, and has no 30-item cap.
const deepRows = Array.from({ length: 90 }, (_, i) =>
  article("alice", `deep${i}`, 100 - i),
);
const deepPages = Object.fromEntries(
  Array.from({ length: 5 }, (_, i) => [
    i + 1,
    deepRows.slice(i * 20, (i + 1) * 20),
  ]),
);
f = fixture({
  pages: { alice: deepPages },
  statuses: (url) => ({
    ok: true,
    liked: Number(url.match(/deep(\d+)$/)[1]) < 12,
  }),
});
result = await fetch(f, { mode: "deep", creator: "alice", creators: ["bob"] });
assert.equal(result.mode, "deep");
assert.equal(result.items.length, 50);
assert.equal(result.checkedArticles, 62);
assert.equal(result.likedCount, 12);
assert.equal(new Set(result.items.map((item) => item.url)).size, 50);
assert.equal(
  result.items.some((item) => item.key === "ndeep62"),
  false,
  "do not inspect an extra status after fifty places fill",
);
assert.equal(f.creatorCalls.length, 4);
f = fixture({ pages: { alice: deepPages } });
result = await fetch(f, { mode: "deep", creator: "alice", includeLiked: true });
assert.equal(result.items.length, 50);
assert.equal(result.candidateCount, 50);
assert.equal(result.checkedArticles, 0);
assert.equal(f.creatorCalls.length, 3);
assert.equal(f.statusCalls.length, 0);

// Every creator contributes; global/per-creator status concurrency is bounded.
const creators = Array.from({ length: 15 }, (_, i) => `user${i}`);
f = fixture({
  pages: Object.fromEntries(
    creators.map((name, i) => [
      name,
      [1, 2, 3, 4].map((rank) => article(name, `${i}_${rank}`, rank)),
    ]),
  ),
  statusDelay: true,
});
result = await fetch(f, { creators });
assert.equal(result.items.length, 45);
assert.equal(f.statusCalls.length, 45);
assert.ok(f.maxStatuses <= 4 && f.maxStatuses >= 2);
assert.ok([...f.maxByCreator.values()].every((count) => count <= 2));

// Invalid URLs and another author's posts are omitted; repeated pages terminate.
f = fixture({
  pages: {
    alice: () => [
      a[7],
      a[7],
      { ...a[6], url: "https://evil.example/alice/n/na7" },
      article("bob", "wrong", 2),
    ],
  },
});
result = await fetch(f);
assert.equal(result.items.length, 1);
assert.equal(result.shortfallCreators[0].reason, "exhausted");
assert.equal(f.creatorCalls.length, 2);
assert.equal(f.statusCalls.length, 1);

// Fetch failure and natural exhaustion remain distinct, including partial articles.
f = fixture({
  pages: {
    alice: { 1: [a[7]], 2: new Error("offline") },
    bob: () => ({ invalid: true }),
    empty: [],
  },
});
result = await fetch(f, { creators: ["alice", "bob", "empty"] });
assert.equal(result.items.length, 1);
assert.equal([...result.failedCreators].sort().join(), "alice,bob");
assert.equal(result.emptyCreators.join(), "empty");
assert.equal(result.partial, true);
assert.equal(
  result.shortfallCreators.find((item) => item.creator === "alice").reason,
  "failed",
);

// Ten consecutive status failures stop that creator; a single unknown still backfills.
f = fixture({ pages: { alice: deepPages }, statuses: () => ({ ok: true }) });
result = await fetch(f, { mode: "deep", creator: "alice" });
assert.equal(result.statusFailedCount, 10);
assert.equal(result.candidateCount, 10);
assert.equal(f.creatorCalls.length, 1);
assert.equal(result.shortfallCreators[0].reason, "status_failed");
assert.equal(result.failedCreators.join(), "alice");
assert.equal(result.partial, true);

// A pathological API that never ends hits an explicit page cap instead of silently completing.
f = fixture({
  pages: { alice: (page) => [article("alice", `forever${page}`, -page)] },
  statuses: () => ({ ok: true, liked: true }),
});
result = await fetch(f);
assert.equal(f.creatorCalls.length, 1000);
assert.equal(result.checkedArticles, 1000);
assert.equal(result.limitReachedCreators.join(), "alice");
assert.equal(result.shortfallCreators[0].reason, "limit");
assert.equal(result.partial, true);

// Account checks fail closed at start, after fetching a page, and after checking statuses.
for (const accounts of [
  ["other"],
  ["owner", "other"],
  ["owner", "owner", "other"],
]) {
  f = fixture({ pages: { alice: [a[7], a[6], a[5]] }, accounts });
  result = await fetch(f);
  assert.equal(result.code, "account_changed");
  assert.equal(result.items, undefined);
  assert.equal(f.tokens.size, 0);
}
let owner = "owner";
f = fixture({
  pages: { alice: deepPages },
  getAccount: () => owner,
  onStatus: () => {
    owner = "other";
  },
});
result = await fetch(f, { mode: "deep", creator: "alice" });
assert.equal(result.code, "account_changed");
assert.equal(result.items, undefined);

// Cancellation preserves finished results and starts no further page/status batches.
f = fixture({
  pages: { alice: deepPages },
  onProgress: (p, token) => {
    if (p.checkedArticles >= 2) token.cancelled = true;
  },
});
result = await fetch(f, { mode: "deep", creator: "alice" });
assert.equal(result.cancelled, true);
assert.equal(result.partial, true);
assert.equal(result.items.length, 2);
assert.equal(f.statusCalls.length, 2);
assert.equal(f.creatorCalls.length, 1);
assert.equal(result.shortfallCreators[0].reason, "cancelled");
f = fixture({
  pages: { alice: [a[7]] },
  onProgress: (p, token) => {
    if (p.phase === "likes") token.cancelled = true;
  },
});
result = await fetch(f);
assert.equal(result.cancelled, true);
assert.equal(result.items.length, 0);
assert.equal(f.statusCalls.length, 0);
assert.equal(result.candidateCount, 0);

f = fixture();
result = await fetch(f, { creators: [] });
assert.equal(result.ok, true);
assert.equal(result.items.length, 0);
assert.equal(f.statusCalls.length, 0);
assert.equal(f.creatorCalls.length, 0);
assert.equal(
  (await fetch(f, { creators: Array.from({ length: 201 }, (_, i) => `u${i}`) }))
    .code,
  "watchlist_limit",
);
assert.equal(
  (await fetch(f, { mode: "deep", creator: "bad user" })).code,
  "invalid_creator",
);

// Fisher-Yates is a permutation, independent of registration-order concatenation.
const original = ["first", "second", "third", "fourth"];
assert.equal(
  f.api.shuffle(original, () => 0).join(),
  "second,third,fourth,first",
);
assert.equal(original.join(), "first,second,third,fourth");
assert.equal(f.api.articleUrl("javascript:alert(1)"), "");
console.log(
  "member-feed-check-ok: backfill, paging, deep fifty, include liked, unknowns, bounds, accounts, cancellation, shuffle",
);
