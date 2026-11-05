import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const row = (i) => ({
  key: "ntag" + i,
  name: "Unrelated title " + i,
  publish_at: new Date(Date.UTC(2026, 10, 5) - i * 1000).toISOString(),
  user: { urlname: "writer_a", nickname: "Writer" },
  is_liked: false,
});
function harness() {
  const h = {
    owner: "alice",
    calls: [],
    statuses: [],
    progress: [],
    token: {},
    likes: new Set(),
    unknown: new Set(),
    count: 250,
    finished: false,
  };
  h.page = async (n) => ({
    data: {
      notes: Array.from(
        { length: Math.max(0, Math.min(50, h.count - (n - 1) * 50)) },
        (_, i) => row((n - 1) * 50 + i),
      ),
      next_page: n * 50 < h.count ? n + 1 : null,
      is_last_page: n * 50 >= h.count,
      count: h.count,
    },
  });
  const A = {
    currentAccount: async () => ({ ok: !!h.owner, owner: h.owner }),
    jobToken: (kind) => {
      assert.equal(kind, "watch_feed");
      return h.token;
    },
    finishJob: () => {
      h.finished = true;
    },
    progress: (_port, _id, value) => h.progress.push(value),
    noteAction: async (action, args) => {
      assert.equal(action, "status");
      assert.equal(args.force, true);
      h.statuses.push(args.articleUrl);
      const key = args.articleUrl.split("/n/")[1];
      await h.onStatus?.(key);
      return h.unknown.has(key)
        ? { ok: true }
        : { ok: true, liked: h.likes.has(key) };
    },
  };
  const ctx = vm.createContext({
    NeroAppApiCore: A,
    URL,
    AbortController,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    fetch: async (value, options) => {
      const url = new URL(value);
      h.calls.push(url);
      assert.equal(url.origin, "https://note.com");
      assert.match(url.pathname, /^\/api\/v3\/hashtags\/[^/]+\/notes$/);
      assert.equal(url.searchParams.get("order"), "new");
      assert.equal(options.credentials, "include");
      assert.equal(options.cache, "no-store");
      const result = await h.page(Number(url.searchParams.get("page")));
      return {
        ok: !(h.http >= 400),
        status: h.http || 200,
        json: async () => result,
      };
    },
  });
  vm.runInContext(fs.readFileSync("members/member-feed.js", "utf8"), ctx);
  vm.runInContext(fs.readFileSync("members/member-hashtag.js", "utf8"), ctx);
  h.api = ctx.NeroMemberHashtag;
  h.run = (args = {}) =>
    h.api.fetch({}, "1", {
      hashtag: "#企画",
      expectedAccount: "alice",
      ...args,
    });
  return h;
}
for (const limit of [50, 100, 200]) {
  const h = harness(),
    r = await h.run({ includeLiked: true, limit });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, limit);
  assert.equal(r.limit, limit);
  assert.equal(h.statuses.length, 0);
  assert.equal(h.calls.length, limit / 50);
  assert.equal(r.hasMore, true);
  assert.equal(r.limitReached, true);
  assert.equal(h.finished, true);
  assert.equal(decodeURIComponent(h.calls[0].pathname.split("/")[4]), "企画");
  assert.equal(new Set(Array.from(r.items, (x) => x.url)).size, limit);
  assert.ok(
    r.items.every((x) => x.publishAt.includes(":")),
    "full publication times survive normalization",
  );
}
{
  const h = harness();
  h.count = 105;
  for (let i = 0; i < 55; i++) h.likes.add("ntag" + i);
  const r = await h.run({ limit: 50 });
  assert.equal(r.items.length, 50);
  assert.equal(r.likedCount, 55);
  assert.equal(r.checkedArticles, 105);
  assert.equal(r.hasMore, false);
  assert.equal(h.calls.length, 3);
  assert.ok(
    r.items.every((x) => x.liked === false && Number(x.key.slice(4)) >= 55),
  );
}
{
  const h = harness();
  h.count = 51;
  h.unknown.add("ntag0");
  const r = await h.run({ limit: 50 });
  assert.equal(r.items.length, 50);
  assert.equal(r.statusFailedCount, 1);
  assert.equal(r.partial, true);
  assert.equal(h.calls.length, 2);
  assert.ok(!r.items.some((x) => x.key === "ntag0"));
}
{
  const h = harness();
  for (let i = 0; i < 10; i++) h.unknown.add("ntag" + i);
  const r = await h.run();
  assert.equal(r.reason, "status_failed");
  assert.equal(r.partial, true);
  assert.ok(h.statuses.length <= 6);
}
{
  const h = harness();
  h.http = 404;
  const r = await h.run();
  assert.equal(r.ok, true);
  assert.equal(r.notFound, true);
  assert.equal(r.items.length, 0);
  assert.equal(r.hasMore, false);
}
{
  const h = harness();
  const originalPage = h.page;
  h.page = async (n) => {
    if (n === 2) h.http = 404;
    return originalPage(n);
  };
  const r = await h.run({ includeLiked: true });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 50);
  assert.equal(r.notFound, false);
  assert.equal(r.partial, true);
  assert.equal(r.reason, "request_failed");
  assert.equal(r.hasMore, true);
  assert.match(r.message, /404/);
}
{
  const h = harness();
  h.http = 403;
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.match(r.message, /403/);
}
{
  const h = harness();
  h.page = async () => ({ data: { contents: [] } });
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.match(r.message, /応答/);
}
{
  const h = harness();
  h.page = async () => {
    h.owner = "bob";
    return { data: { notes: [row(1)], is_last_page: true } };
  };
  const r = await h.run();
  assert.equal(r.code, "account_changed");
  assert.equal(r.items, undefined);
  assert.equal(h.statuses.length, 0);
}
{
  const h = harness();
  h.onStatus = async () => {
    h.owner = "bob";
  };
  const r = await h.run();
  assert.equal(r.code, "account_changed");
  assert.equal(r.items, undefined);
}
{
  const h = harness();
  h.onStatus = async () => {
    h.token.cancelled = true;
  };
  const r = await h.run();
  assert.equal(r.cancelled, true);
  assert.equal(r.partial, true);
  assert.ok(r.items.length <= 2);
  assert.equal(h.calls.length, 1);
}
{
  const h = harness();
  h.page = async () => ({
    data: { notes: [row(1), row(1)], next_page: 2, is_last_page: false },
  });
  const r = await h.run({ includeLiked: true });
  assert.equal(r.items.length, 1);
  assert.equal(r.reason, "pagination_stopped");
  assert.equal(r.partial, true);
  assert.equal(r.hasMore, true);
}
{
  const h = harness();
  h.page = async (n) => ({
    data: { notes: [row(n)], next_page: n + 1, is_last_page: false },
  });
  for (let i = 1; i <= 100; i++) h.likes.add("ntag" + i);
  const r = await h.run();
  assert.equal(r.reason, "page_limit");
  assert.equal(r.partial, true);
  assert.equal(h.calls.length, 100);
}
{
  const h = harness();
  for (const bad of [
    "",
    "#",
    "##企画",
    "a b",
    "a/b",
    "a\\b",
    "a#b",
    "https://evil.test/hashtag/a",
    "https://@note.com/hashtag/a",
    ".",
    "..",
    "a\u0000b",
    "\ud800",
    "a".repeat(81),
  ]) {
    assert.equal(h.api.normalizeTag(bad), "", bad);
    assert.equal((await h.run({ hashtag: bad })).code, "invalid_hashtag");
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.api.normalizeTag("＃企画"), "企画");
  assert.equal(
    h.api.normalizeTag("https://note.com/hashtag/%E4%BC%81%E7%94%BB?f=new"),
    "企画",
  );
  assert.equal(h.api.normalizeTag("https://note.com/tag/企画"), "企画");
}
console.log(
  "member-hashtag-check-ok: dedicated exact-tag API, 50/100/200 caps, unliked backfill, unknown states, paging, cancellation, account isolation and partial results",
);
