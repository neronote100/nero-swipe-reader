import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto, createHash } from "node:crypto";

const source = fs.readFileSync("members/member-inbox.js", "utf8");
const articleUrl = "https://note.com/alice/n/narticle";
const target = {
  key: "root-comment",
  rootKey: "root-comment",
  commentKey: "child-comment",
  authorUrlname: "bob",
  authorName: "Bob",
  body: "読者のコメント",
  depth: 1,
  rootAuthorUrlname: "bob",
  rootBody: "親コメント",
};
const base = {
  owner: "alice",
  articleUrl,
  articleTitle: "記事",
  inboxKey: "inbox-key",
  replyTarget: target,
};
const queueKey = "nero.members.commentLikes.v1.alice";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function harness() {
  const h = {
    storage: {},
    calls: [],
    removed: [],
    account: "alice",
    replyResult: { ok: true, commentSent: true },
    likeResult: { ok: true, verified: true },
    failWrites: false,
  };
  const local = {
    get: async (keys) => {
      if (h.failReads) throw Error("read unavailable");
      await h.beforeGet?.(keys);
      return structuredClone(
        Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).map((k) => [k, h.storage[k]]),
        ),
      );
    },
    set: async (value) => {
      if (h.failWrites) throw Error("storage unavailable");
      await h.beforeSet?.(value);
      Object.assign(h.storage, structuredClone(value));
    },
  };
  const I = {
    scan: async () => ({ ok: true }),
    remove: async (owner, key) => h.removed.push({ owner, key }),
  };
  const A = {
    currentAccount: async () => ({ ok: true, owner: h.account }),
    noteAction: async (action, args) => {
      h.calls.push({ action, args: structuredClone(args) });
      assert.equal(
        args.expectedAccount,
        h.account,
        "each mutation must target the verified current account",
      );
      if (action === "comment") {
        await h.beforeComment?.();
        if (h.throwReply) throw Error("lost response");
        const result = h.replyResult;
        if (result.ok || result.commentSent) {
          const fingerprint = JSON.stringify([
            args.expectedAccount,
            args.articleUrl,
            args.replyTarget.key,
            args.comment,
          ]);
          const key =
            "nero.members.sent." +
            args.expectedAccount +
            "." +
            createHash("sha256").update(fingerprint).digest("hex");
          h.storage[key] = { sent: true, at: Date.now() };
        }
        h.afterComment?.();
        return result;
      }
      if (action === "comment_like") {
        if (h.throwLike) throw Error("lost like response");
        return h.likeResult;
      }
      throw Error("unexpected action " + action);
    },
  };
  const ctx = vm.createContext({
    NeroAppApiCore: A,
    NeroAppInbox: I,
    browser: { storage: { local } },
    URL,
    TextEncoder,
    crypto: webcrypto,
    console,
  });
  vm.runInContext(source, ctx);
  h.api = I;
  return h;
}

// A child reply is posted under its root, but the like targets the actual child.
{
  const h = harness();
  h.beforeComment = () =>
    assert.equal(
      Object.values(h.storage[queueKey].items)[0].stage,
      "reply_pending",
    );
  const r = await h.api.reply({ ...base, comment: "ありがとうございます" });
  assert.equal(r.ok, true);
  assert.equal(r.replySent, true);
  assert.equal(r.liked, true);
  assert.equal(h.calls.map((c) => c.action).join(","), "comment,comment_like");
  assert.equal(h.calls[0].args.replyTarget.key, "root-comment");
  assert.equal(h.calls[1].args.replyTarget.commentKey, "child-comment");
  assert.equal(
    h.calls[1].args.replyTarget.liked,
    false,
    "do not trust a cached liked flag",
  );
  assert.equal((await h.api.pendingLikes("alice")).items.length, 0);
}
// Standalone like removes a handled inbox item without posting any reply.
{
  const h = harness();
  const r = await h.api.like({
    ...base,
    replyTarget: {
      ...target,
      key: "root-comment",
      commentKey: "root-comment",
      depth: 0,
      liked: true,
    },
  });
  assert.equal(r.liked, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].action, "comment_like");
  assert.equal(h.calls[0].args.replyTarget.commentKey, "root-comment");
  assert.equal(h.removed.length, 1);
}
// The user may explicitly opt out of the companion like.
{
  const h = harness();
  const r = await h.api.reply({
    ...base,
    comment: "返信だけ",
    likeComment: false,
  });
  assert.equal(r.replySent, true);
  assert.equal(r.likeRequested, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.storage[queueKey], undefined);
}
// A partial result is a successful reply. Retrying is ALWAYS like-only, even
// after reloading the service and using just the durable pending ID.
{
  const h = harness();
  h.likeResult = {
    ok: false,
    code: "comment_like_api_unavailable",
    message: "offline",
  };
  const r = await h.api.reply({ ...base, comment: "返信は届いている" });
  assert.equal(r.ok, true);
  assert.equal(r.replySent, true);
  assert.equal(r.partial, true);
  assert.equal(r.likePending, true);
  const pending = await h.api.pendingLikes("alice");
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0].replySent, true);
  h.likeResult = { ok: true };
  const retried = await h.api.retryLike({
    owner: "alice",
    pendingId: r.pendingId,
  });
  assert.equal(retried.liked, true);
  assert.equal(h.calls.filter((c) => c.action === "comment").length, 1);
  assert.equal(h.calls.filter((c) => c.action === "comment_like").length, 2);
  assert.equal((await h.api.pendingLikes("alice")).items.length, 0);
}
// An unknown reply result never triggers an automatic like or a reply retry.
{
  const h = harness();
  h.throwReply = true;
  const r = await h.api.reply({ ...base, comment: "結果不明" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "comment_result_unknown");
  assert.equal(h.calls.length, 1);
  const pending = await h.api.pendingLikes("alice");
  assert.equal(pending.items.length, 0);
  assert.equal(pending.unknownReplyCount, 1);
}
// Cross-account operations and pending queue reads must fail closed.
{
  const h = harness();
  h.account = "carol";
  assert.equal((await h.api.like(base)).code, "account_changed");
  assert.equal(
    (await h.api.reply({ ...base, comment: "wrong account" })).code,
    "account_changed",
  );
  assert.equal((await h.api.pendingLikes("alice")).code, "account_changed");
  assert.equal(h.calls.length, 0);
}
// A switch after the reply stops the like, while preserving the posted reply.
{
  const h = harness();
  h.afterComment = () => (h.account = "carol");
  const r = await h.api.reply({ ...base, comment: "送信中に切替" });
  assert.equal(r.replySent, true);
  assert.equal(r.likePending, true);
  assert.equal(h.calls.length, 1);
  h.account = "alice";
  assert.equal((await h.api.pendingLikes("alice")).items.length, 1);
}
// Missing specific comment IDs must never silently like a thread root, and
// missing reply metadata must never silently post a new top-level comment.
{
  const h = harness();
  assert.equal(
    (await h.api.like({ ...base, replyTarget: { ...target, commentKey: "" } }))
      .code,
    "invalid_comment_target",
  );
  assert.equal(
    (
      await h.api.reply({
        ...base,
        comment: "返信",
        replyTarget: { ...target, authorUrlname: "" },
      })
    ).code,
    "invalid_comment_target",
  );
  assert.equal(
    (
      await h.api.reply({
        ...base,
        comment: "返信",
        replyTarget: { ...target, commentKey: "" },
      })
    ).code,
    "invalid_comment_target",
  );
  assert.equal(h.calls.length, 0);
}
// A known duplicate reply from the durable sender still permits the requested
// companion like, without requiring another comment post from the service.
{
  const h = harness();
  h.replyResult = { ok: true, commentSent: true, already: true };
  const r = await h.api.reply({ ...base, comment: "already sent" });
  assert.equal(r.replySent, true);
  assert.equal(r.liked, true);
  assert.equal(h.calls[1].action, "comment_like");
}
// Prevent concurrent clicks before awaiting account verification.
{
  const h = harness();
  let release;
  h.beforeComment = () => new Promise((r) => (release = r));
  const first = h.api.reply({ ...base, comment: "first" });
  await flush();
  assert.equal((await h.api.like(base)).code, "busy");
  assert.equal(
    (await h.api.pendingLikes("alice")).code,
    "busy",
    "a queue reader must not overwrite an in-flight reply",
  );
  release();
  assert.equal((await first).liked, true);
  assert.equal(h.calls.length, 2);
}
// Storage loss after note confirms the reply must never be reported as an
// unsent reply. Its preflight receipt allows recovery after storage returns.
{
  const h = harness();
  h.afterComment = () => (h.failWrites = true);
  const r = await h.api.reply({ ...base, comment: "保存できなくなった" });
  assert.equal(r.ok, true);
  assert.equal(r.replySent, true);
  assert.equal(r.likePending, true);
  assert.equal(r.pendingSaved, false);
  assert.equal(h.calls.length, 1);
  h.failWrites = false;
  const recovered = await h.api.pendingLikes("alice");
  assert.equal(recovered.items.length, 1);
  assert.equal(recovered.items[0].replySent, true);
  const retry = await h.api.like({ owner: "alice", pendingId: r.pendingId });
  assert.equal(retry.liked, true);
  assert.equal(h.calls.filter((c) => c.action === "comment").length, 1);
}
// A failed later reply must not discard an earlier pending like for the target.
{
  const h = harness();
  h.likeResult = { ok: false, code: "offline" };
  await h.api.reply({ ...base, comment: "first reply" });
  h.replyResult = { ok: false, code: "comment_api_rejected" };
  await h.api.reply({ ...base, comment: "later reply" });
  assert.equal((await h.api.pendingLikes("alice")).items.length, 1);
}
// Receipt recovery is a queue write. A second tab must not start a like or
// reply while the recovered snapshot is being committed to storage.
{
  const h = harness();
  h.likeResult = { ok: false, code: "offline" };
  await h.api.reply({ ...base, comment: "recover while another tab clicks" });
  const item = Object.values(h.storage[queueKey].items)[0];
  item.stage = "reply_pending";
  item.replySent = false;
  let release;
  h.beforeSet = (value) =>
    value[queueKey] ? new Promise((r) => (release = r)) : undefined;
  const recovering = h.api.pendingLikes("alice");
  await flush();
  assert.equal(
    typeof release,
    "function",
    "the fixture must block during the recovery write",
  );
  assert.equal((await h.api.like(base)).code, "busy");
  assert.equal(
    (await h.api.reply({ ...base, comment: "another tab" })).code,
    "busy",
  );
  assert.equal((await h.api.pendingLikes("alice")).code, "busy");
  release();
  const result = await recovering;
  h.beforeSet = null;
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(
    Object.values(h.storage[queueKey].items)[0].stage,
    "like_pending",
  );
  assert.equal(h.calls.filter((c) => c.action === "comment").length, 1);
  h.likeResult = { ok: true };
  assert.equal(
    (await h.api.like({ owner: "alice", pendingId: item.id })).liked,
    true,
    "recovery must release the operation lock",
  );
}
// A failed pending-list read also releases the operation lock.
{
  const h = harness();
  h.failReads = true;
  assert.equal(
    (await h.api.pendingLikes("alice")).code,
    "pending_likes_storage_failed",
  );
  h.failReads = false;
  assert.equal((await h.api.like(base)).liked, true);
}
console.log(
  "comment-likes-check-ok: specific targets, combined reply, like-only retry, account isolation, opt-out, durable recovery, no reposts",
);
