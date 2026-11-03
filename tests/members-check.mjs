import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const out = "dist/firefox-members/";
const manifest = JSON.parse(fs.readFileSync(out + "manifest.json"));
assert.deepEqual(manifest.permissions, ["storage", "https://note.com/*"]);
assert.equal(manifest.content_scripts, undefined);
for (const f of manifest.background.scripts)
  assert.ok(fs.existsSync(out + f), f);
const storage = {};
let account = "alice",
  posts = 0,
  failPost = false,
  statusLike = false,
  statusRequests = 0;
const listeners = [];
const browser = {
  runtime: {
    id: "test-extension",
    getURL: (p) => "moz-extension://test/" + p,
    onMessage: { addListener() {} },
    onConnect: { addListener: (f) => listeners.push(f) },
  },
  browserAction: { onClicked: { addListener() {} } },
  tabs: { create: async () => ({}) },
  storage: {
    local: {
      get: async (key) =>
        key === null
          ? { ...storage }
          : Object.fromEntries(
              (Array.isArray(key) ? key : [key]).map((k) => [k, storage[k]]),
            ),
      set: async (v) => Object.assign(storage, v),
      remove: async (keys) =>
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete storage[k]),
    },
  },
};
const ctx = vm.createContext({
  browser,
  console,
  URL,
  URLSearchParams,
  AbortController,
  TextEncoder,
  crypto: webcrypto,
  setTimeout,
  clearTimeout,
  fetch: async (url, opts = {}) => {
    if (url.endsWith("/v3/notes/nstatus")) {
      statusRequests++;
      const liked = statusLike;
      return {
        ok: true,
        json: async () => ({
          data: {
            ...(typeof liked === "boolean" ? { is_liked: liked } : {}),
            user: { urlname: "bob" },
          },
        }),
      };
    }
    if (url.includes("/note_comments?")) {
      const page = Number(new URL(url).searchParams.get("page"));
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              key: "c" + page,
              user: { urlname: "reader" },
              comment: { type: "text", value: "hello" },
              reply_count: 0,
            },
          ],
          next_page: page < 12 ? page + 1 : null,
        }),
      };
    }
    if (url.endsWith("/v2/current_user"))
      return {
        ok: true,
        json: async () => ({ data: { key: account, urlname: account } }),
      };
    if (opts.method === "POST") {
      posts++;
      if (failPost) throw new Error("network lost");
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { key: "comment-1" } }),
      };
    }
    throw new Error("Unexpected URL " + url);
  },
});
for (const file of manifest.background.scripts)
  vm.runInContext(fs.readFileSync(out + file, "utf8"), ctx, { filename: file });
vm.runInContext(fs.readFileSync("members/reader/model.js", "utf8"), ctx);
const M = ctx.NeroMemberModel,
  A = ctx.NeroAppApiCore;
// Exercise the built runNoteOperation/runStatusApi path, not a mocked helper.
// A refreshed feed must see a newly added like even while the status cache lives.
const statusUrl = "https://note.com/bob/n/nstatus";
assert.equal(
  (await A.noteAction("status", { articleUrl: statusUrl, force: true })).liked,
  false,
);
assert.equal(statusRequests, 1);
statusLike = true;
const cachedStatus = await A.noteAction("status", { articleUrl: statusUrl });
assert.equal(cachedStatus.liked, false);
assert.equal(cachedStatus.cached, true);
assert.equal(statusRequests, 1, "the fixture must exercise a live cache entry");
assert.equal(
  (await A.noteAction("status", { articleUrl: statusUrl, force: true })).liked,
  true,
);
assert.equal(statusRequests, 2, "force must bypass the cached unliked status");
statusLike = undefined;
const unknownStatus = await A.noteAction("status", {
  articleUrl: statusUrl,
  force: true,
});
assert.equal(statusRequests, 3);
assert.equal(unknownStatus.ok, false);
assert.equal(unknownStatus.code, "status_api_failed");
assert.equal(
  unknownStatus.liked,
  undefined,
  "missing is_liked must not become false",
);
assert.equal(M.watchName("https://note.com/Alice/n/n123"), "alice");
assert.equal(M.watchName("https://evil.example/alice"), "");
assert.equal(M.watchName("javascript:alert(1)"), "");
assert.notEqual(
  M.draftKey({ key: "reply-1", articleUrl: "same" }),
  M.draftKey({ key: "reply-2", articleUrl: "same" }),
);
assert.equal(
  M.canSwipe(
    { x: 10, y: 200 },
    { x: 15, y: 40 },
    { top: 10, height: 500, total: 2000 },
  ),
  false,
);
assert.equal(
  M.canSwipe(
    { x: 10, y: 200 },
    { x: 15, y: 40 },
    { top: 1500, height: 500, total: 2000 },
  ),
  true,
);
assert.equal(
  A.isReaderPort({
    sender: {
      id: browser.runtime.id,
      url: "https://cosmos-invest.github.io/nero-swipe-reader/",
    },
  }),
  false,
);
assert.equal(
  A.isReaderPort({
    sender: {
      id: browser.runtime.id,
      url: browser.runtime.getURL("reader/index.html"),
    },
  }),
  true,
);
const args = {
  expectedAccount: "alice",
  articleUrl: "https://note.com/bob/n/n123",
  comment: "ありがとうございます",
};
assert.equal(
  (await A.noteAction("comment", { ...args, expectedAccount: "bob" })).code,
  "account_changed",
);
assert.equal(posts, 0);
assert.equal(
  (await A.noteAction("comment", { ...args, comment: "x".repeat(501) })).code,
  "invalid_comment",
);
assert.equal(posts, 0);
assert.equal((await A.noteAction("comment", args)).ok, true);
assert.equal(posts, 1);
assert.equal((await A.noteAction("comment", args)).already, true);
assert.equal(posts, 1, "persistent deduplication must prevent reposting");
account = "bob";
assert.equal(
  (await A.noteAction("comment", { ...args, comment: "別の返信" })).code,
  "account_changed",
);
assert.equal(posts, 1);
account = "alice";
failPost = true;
assert.equal(
  (
    await A.noteAction("comment", {
      ...args,
      articleUrl: "https://note.com/bob/n/n999",
      comment: "結果不明",
    })
  ).ok,
  false,
);
const attempts = posts;
assert.equal(
  (
    await A.noteAction("comment", {
      ...args,
      articleUrl: "https://note.com/bob/n/n999",
      comment: "結果不明",
    })
  ).code,
  "comment_result_unknown",
);
assert.equal(posts, attempts, "unknown results must never be retried");
const unresolved = ctx.NeroAppInbox.unresolvedReplyComments(
  [
    {
      key: "1",
      threadIndex: 0,
      authorUrlname: "bob",
      body: "a",
      creatorLiked: true,
    },
    { key: "2", threadIndex: 0, authorUrlname: "alice", body: "b" },
    {
      key: "3",
      threadIndex: 0,
      authorUrlname: "bob",
      body: "c",
      creatorLiked: true,
    },
    {
      key: "4",
      threadIndex: 0,
      authorUrlname: "bob",
      body: "viewer liked",
      viewerLiked: true,
    },
    {
      key: "5",
      threadIndex: 0,
      authorUrlname: "bob",
      body: "unhandled",
      creatorLiked: false,
      viewerLiked: false,
    },
    {
      key: "6",
      threadIndex: 1,
      authorUrlname: "carol",
      body: "root liked",
      creatorLiked: true,
    },
    {
      key: "7",
      threadIndex: 1,
      depth: 1,
      authorUrlname: "carol",
      body: "unliked reply",
      rootKey: "6",
    },
    {
      key: "8",
      threadIndex: 2,
      authorUrlname: "dave",
      body: "likes from others",
      creatorLiked: false,
      viewerLiked: false,
      likeCount: 10,
    },
  ],
  "alice",
);
assert.equal(unresolved.length, 3);
assert.equal(
  unresolved.map((c) => c.key).join(","),
  "5,7,8",
  "owner-liked comments are excluded without hiding unliked replies or others' likes",
);
// Cached results from v0.2.0 must follow the new policy before a new scan.
const cacheKey = A.cacheKey(A.C.INBOX_PREFIX, "alice");
const articleUrl = "https://note.com/alice/n/ncached";
storage[cacheKey] = {
  articles: {
    [articleUrl]: {
      articleUrl,
      articleTitle: "Cached article",
      commentCount: 4,
      checkedAt: Date.now(),
      unresolved: [
        {
          key: "liked-creator",
          authorUrlname: "bob",
          body: "handled",
          creatorLiked: true,
        },
        {
          key: "liked-viewer",
          authorUrlname: "bob",
          body: "handled",
          viewerLiked: true,
        },
        {
          key: "liked-legacy",
          authorUrlname: "bob",
          body: "handled",
          liked: true,
        },
        {
          key: "pending",
          authorUrlname: "bob",
          body: "pending",
          creatorLiked: false,
          viewerLiked: false,
        },
      ],
    },
  },
};
assert.equal(
  (await ctx.NeroAppInbox.status("alice")).items
    .map((x) => x.comment.key)
    .join(","),
  "pending",
);
const noteAction = A.noteAction,
  creatorArticles = A.creatorArticles;
try {
  A.creatorArticles = async () => [
    { url: articleUrl, name: "Article", commentCount: 2 },
  ];
  A.noteAction = async (action) =>
    action === "account"
      ? { ok: true, urlname: "alice" }
      : {
          ok: true,
          viewerUrlname: "alice",
          comments: [
            {
              key: "remote-liked",
              threadIndex: 0,
              authorUrlname: "bob",
              body: "handled on note",
              creatorLiked: true,
              viewerLiked: true,
            },
            {
              key: "remote-pending",
              threadIndex: 1,
              authorUrlname: "carol",
              body: "not handled",
              creatorLiked: false,
              viewerLiked: false,
            },
          ],
        };
  const scanned = await ctx.NeroAppInbox.scan(
    { postMessage() {} },
    "scan-test",
  );
  assert.equal(scanned.ok, true);
  assert.equal(scanned.checkedArticles, 1);
  assert.equal(
    scanned.items.map((x) => x.comment.key).join(","),
    "remote-pending",
  );
  assert.equal(
    storage[cacheKey].articles[articleUrl].unresolved
      .map((c) => c.key)
      .join(","),
    "remote-pending",
    "liked comments must not be saved as pending",
  );
} finally {
  A.noteAction = noteAction;
  A.creatorArticles = creatorArticles;
}
assert.equal(A.C.VERSION, manifest.version);
const source = fs.readFileSync(out + "background.js", "utf8");
const manyComments = await ctx.NeroBackgroundTest.fetchNoteComments(
  "npages",
  true,
);
assert.equal(manyComments.length, 12, "scan must follow more than ten pages");
assert.ok(!source.includes("slice(0, summaryOnly ? 1000 : 2000)"));
for (const file of [
  "reader/model.js",
  "reader/app.js",
  ...manifest.background.scripts,
])
  new vm.Script(fs.readFileSync(out + file, "utf8"), { filename: file });
console.log(
  "members-check-ok: isolation, account switch, validated mutations, durable deduplication, inbox, swipe, package",
);
