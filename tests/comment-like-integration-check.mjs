import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

// Exercise the shipped member wrapper, common operation validator, and note
// mutation code together. Every HTTP response is local to this test harness.
const out = "dist/firefox-members/";
const manifest = JSON.parse(fs.readFileSync(out + "manifest.json", "utf8"));
const storage = {};
const calls = [];
let scenario;
let accountReads = 0;
let sequence = 0;
let failConfirmedReceiptWrite = false;
const articleUrl = "https://note.com/alice/n/nintegration";
const rootKey = "thread-root";
const targetKey = "child-target";
const listeners = [];
const browser = {
  runtime: {
    id: "comment-like-integration",
    getURL: (p) => "moz-extension://integration/" + p,
    onMessage: { addListener() {} },
    onConnect: { addListener: (f) => listeners.push(f) },
  },
  browserAction: { onClicked: { addListener() {} } },
  tabs: {
    create: async () => {
      throw new Error("comment likes must not open a tab");
    },
  },
  storage: {
    local: {
      get: async (key) =>
        key === null
          ? structuredClone(storage)
          : structuredClone(
              Object.fromEntries(
                (Array.isArray(key) ? key : [key]).map((k) => [k, storage[k]]),
              ),
            ),
      set: async (values) => {
        if (
          failConfirmedReceiptWrite &&
          Object.entries(values).some(
            ([key, value]) =>
              key.startsWith("nero.members.sent.") && value?.sent === true,
          )
        )
          throw new Error("confirmed receipt write unavailable");
        return Object.assign(storage, structuredClone(values));
      },
      remove: async (keys) =>
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete storage[k]),
    },
  },
};
function response(ok, status, payload) {
  return { ok, status, json: async () => structuredClone(payload) };
}
function comment(key, liked, extra = {}) {
  return {
    key,
    user: { urlname: "reader", nickname: "Reader" },
    comment: {
      type: "root",
      children: [{ type: "text", value: key + " text" }],
    },
    created_at: "2026-11-03T00:00:00Z",
    is_liked: liked,
    reply_count: 0,
    ...extra,
  };
}
const context = vm.createContext({
  browser,
  URL,
  URLSearchParams,
  AbortController,
  TextEncoder,
  crypto: webcrypto,
  console,
  setTimeout,
  clearTimeout,
  fetch: async (urlValue, options = {}) => {
    const url = new URL(urlValue);
    const method = options.method || "GET";
    calls.push({ method, url: url.href, body: options.body });
    if (url.pathname === "/api/v2/current_user") {
      accountReads++;
      const owner = scenario.accounts?.[accountReads - 1] || "alice";
      return response(true, 200, {
        data: { key: owner + "-key", urlname: owner },
      });
    }
    if (method === "POST") {
      if (scenario.mutation === "reply") {
        assert.equal(url.pathname, "/api/v3/notes/nintegration/note_comments");
        const body = JSON.parse(options.body);
        assert.equal(
          body.parent_key,
          rootKey,
          "the ordinary reply must target the parent thread",
        );
        return response(true, 200, { data: { key: "posted-reply" } });
      }
      assert.equal(
        url.pathname,
        "/api/v3/notes/nintegration/note_comments/child-target/likes",
        "POST must like the specific child comment, not the root or article",
      );
      assert.equal(
        options.body,
        undefined,
        "liking must not send a reply body",
      );
      if (scenario.mutation === "network")
        throw new TypeError("response lost after the like request");
      if (scenario.mutation === "abort") {
        const error = new Error("request timed out");
        error.name = "AbortError";
        throw error;
      }
      if (scenario.mutation === "conflict")
        return response(false, 409, { error: { message: "already liked" } });
      return response(true, 200, { data: {} });
    }
    if (url.pathname === "/api/v3/notes/nintegration/note_comments") {
      if (!url.searchParams.has("parent_key"))
        return response(true, 200, {
          data: [
            comment(rootKey, Boolean(scenario.rootLiked), { reply_count: 2 }),
          ],
          next_page: null,
        });
      assert.equal(url.searchParams.get("parent_key"), rootKey);
      return response(true, 200, {
        data: [
          comment(targetKey, Boolean(scenario.targetLiked)),
          comment("other-child", Boolean(scenario.otherLiked)),
        ],
        next_page: null,
      });
    }
    throw new Error("Unexpected network request: " + method + " " + url.href);
  },
});
for (const file of manifest.background.scripts)
  vm.runInContext(fs.readFileSync(out + file, "utf8"), context, {
    filename: file,
  });
const A = context.NeroAppApiCore;
async function runCase(config) {
  scenario = config;
  accountReads = 0;
  const start = calls.length;
  sequence++;
  const result = await A.noteAction("comment_like", {
    expectedAccount: "alice",
    articleUrl,
    replyTarget: {
      key: rootKey,
      rootKey,
      commentKey: targetKey,
      authorUrlname: "reader",
      authorName: "Reader",
      // The legacy throttle includes body and timestamp. Each scenario is a
      // distinct operation while retaining a fixed child key for URL checks.
      body: "case " + sequence,
      publishedAt:
        "2026-11-03T00:00:" + String(sequence).padStart(2, "0") + "Z",
      depth: 1,
      rootAuthorUrlname: "reader",
      rootBody: "thread root",
      liked: true,
    },
  });
  const requests = calls.slice(start);
  const posts = requests.filter((c) => c.method === "POST");
  assert.equal(
    posts.length,
    config.postCount ?? 1,
    "never repeat a like POST to resolve an uncertain response",
  );
  assert.equal(
    requests.filter(
      (c) =>
        c.method === "POST" &&
        new URL(c.url).pathname.endsWith("/note_comments"),
    ).length,
    0,
    "comment likes must not post comments",
  );
  return { result, requests };
}

{
  const { result, requests } = await runCase({ mutation: "success" });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(
    requests.some((c) => c.url.includes("/note_comments?")),
    false,
    "a known HTTP success requires no recovery read",
  );
}
{
  const { result } = await runCase({
    mutation: "success",
    accounts: ["carol"],
    postCount: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "account_changed");
}
{
  const { result, requests } = await runCase({
    mutation: "conflict",
    targetLiked: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.source, "note_comments_verified");
  assert.equal(
    requests.some((c) => c.url.includes("/note_comments?")),
    true,
  );
}
{
  const { result } = await runCase({
    mutation: "conflict",
    targetLiked: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
}
{
  const { result } = await runCase({ mutation: "network", targetLiked: true });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.source, "note_comments_verified");
}
{
  const { result } = await runCase({ mutation: "abort", targetLiked: true });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
}
{
  const { result } = await runCase({ mutation: "network", targetLiked: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, "comment_like_api_unavailable");
}
{
  const { result } = await runCase({ mutation: "abort", targetLiked: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, "comment_like_result_unknown");
}
// A liked root or another reply is not proof that this specific child is liked.
{
  const { result } = await runCase({
    mutation: "conflict",
    targetLiked: false,
    rootLiked: true,
    otherLiked: true,
  });
  assert.equal(result.ok, false);
}
// The current account must agree both with the comment response's viewer and
// with a fresh account read after verification.
{
  const { result } = await runCase({
    mutation: "conflict",
    targetLiked: true,
    accounts: ["alice", "carol", "alice"],
  });
  assert.equal(
    result.ok,
    false,
    "another viewer's like flag must not verify the mutation",
  );
}
{
  const { result } = await runCase({
    mutation: "network",
    targetLiked: true,
    accounts: ["alice", "alice", "carol"],
  });
  assert.equal(
    result.ok,
    false,
    "an account change during recovery must fail closed",
  );
}
assert.equal(
  calls.filter(
    (c) =>
      c.method === "POST" && new URL(c.url).pathname.endsWith("/note_comments"),
  ).length,
  0,
);
// Once note confirms a reply, a failure saving sent:true must not change
// that known success into an unknown/failed post. The earlier sent:false
// marker also prevents a user retry from creating a second comment.
{
  scenario = { mutation: "reply" };
  accountReads = 0;
  failConfirmedReceiptWrite = true;
  const start = calls.length;
  const args = {
    owner: "alice",
    articleUrl,
    comment: "confirmed reply with failed local receipt",
    likeComment: false,
    inboxKey: "receipt-fixture",
    replyTarget: {
      key: rootKey,
      rootKey,
      commentKey: targetKey,
      authorUrlname: "reader",
      body: "original comment",
      depth: 1,
    },
  };
  const result = await context.NeroAppInbox.reply(args);
  assert.equal(result.ok, true);
  assert.equal(result.replySent, true);
  assert.equal(result.commentSent, true);
  assert.equal(result.receiptSaved, false);
  assert.equal(result.likeRequested, false);
  const attempts = calls.slice(start).filter((c) => c.method === "POST");
  assert.equal(attempts.length, 1);
  assert.equal(
    new URL(attempts[0].url).pathname,
    "/api/v3/notes/nintegration/note_comments",
  );
  const receipt = Object.entries(storage).find(([key]) =>
    key.startsWith("nero.members.sent.alice."),
  );
  assert.ok(
    receipt,
    "the preflight record must survive the confirmed-record failure",
  );
  assert.equal(receipt[1].sent, false);
  const retry = await context.NeroAppInbox.reply(args);
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "comment_result_unknown");
  assert.equal(
    calls.slice(start).filter((c) => c.method === "POST").length,
    1,
    "a retry must never post the confirmed reply twice",
  );
  failConfirmedReceiptWrite = false;
}
console.log(
  "comment-like-integration-check-ok: specific child HTTP target, fresh accounts, 200/409/unknown verification, no reply POSTs for likes, confirmed reply preserved after receipt failure, no reposts",
);
