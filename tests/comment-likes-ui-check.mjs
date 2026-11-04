// Execute real page handlers with a minimal DOM and mocked extension Port.
// Layout and live note.com access are outside this test's scope.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
class Element {
  constructor(id = "") {
    this.id = id;
    this.children = [];
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.handlers = {};
    this._text = "";
    this.tagName = "DIV";
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((x) => x.textContent || "").join("");
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
    this._text = "";
  }
  addEventListener(type, fn) {
    (this.handlers[type] ??= []).push(fn);
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  focus() {}
  remove() {}
  async click() {
    const event = { target: this, currentTarget: this, preventDefault() {} };
    if (this.onclick) await this.onclick(event);
    for (const fn of this.handlers.click || []) await fn(event);
  }
}
const next = () => new Promise((r) => setImmediate(r));
async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await next();
  }
  throw Error("UI did not reach expected state");
}
async function harness() {
  const elements = {};
  for (const match of fs
    .readFileSync("members/reader/index.html", "utf8")
    .matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const e = (elements[match[1]] = new Element(match[1]));
    e.hidden = /\bhidden\b/.test(match[0]);
    e.checked = /\bchecked\b/.test(match[0]);
  }
  const target = {
    key: "root",
    rootKey: "root",
    commentKey: "child",
    authorUrlname: "bob",
    body: "コメント",
    depth: 1,
  };
  const item = {
    key: "inbox-one",
    articleUrl: "https://note.com/alice/n/narticle",
    articleTitle: "記事",
    comment: { body: "コメント", authorName: "Bob", replyTarget: target },
  };
  const h = {
    elements,
    storage: {},
    requests: [],
    items: [item],
    queue: [],
    replyMode: "partial",
    holdHealth: false,
    releaseHealth: null,
  };
  const listeners = [];
  const respond = (m, result) =>
    queueMicrotask(() =>
      listeners.forEach((fn) =>
        fn({ type: "response", requestId: m.requestId, result }),
      ),
    );
  const browser = {
    runtime: {
      connect: () => ({
        onMessage: { addListener: (f) => listeners.push(f) },
        onDisconnect: { addListener() {} },
        postMessage(m) {
          h.requests.push(structuredClone(m));
          if (m.action === "health") {
            if (h.holdHealth) {
              h.releaseHealth = () =>
                respond(m, { ok: true, noteOk: true, owner: "bob" });
              return;
            }
            return respond(m, { ok: true, noteOk: true, owner: "alice" });
          }
          if (m.action === "inbox_status")
            return respond(m, { ok: true, items: h.items });
          if (m.action === "pending_comment_likes")
            return respond(m, { ok: true, items: h.queue });
          if (m.action === "reply_comment") {
            if (h.replyMode === "unknown")
              return respond(m, {
                ok: false,
                code: "comment_result_unknown",
                message: "返信結果未確認",
              });
            h.items = [];
            if (m.args.likeComment === false)
              return respond(m, {
                ok: true,
                replySent: true,
                likeRequested: false,
              });
            if (h.replyMode === "success")
              return respond(m, { ok: true, replySent: true, liked: true });
            h.queue = [
              {
                id: "pending-one",
                ...item,
                inboxKey: item.key,
                replyTarget: target,
                replySent: true,
              },
            ];
            return respond(m, {
              ok: true,
              replySent: true,
              commentSent: true,
              partial: true,
              likePending: true,
              message: "返信は送信済み。スキのみ再試行してください。",
            });
          }
          if (m.action === "comment_like") {
            h.queue = [];
            h.items = [];
            return respond(m, { ok: true, liked: true });
          }
          respond(m, { ok: true });
        },
      }),
    },
    storage: {
      local: {
        get: async (key) =>
          key === null
            ? structuredClone(h.storage)
            : Object.fromEntries(
                (Array.isArray(key) ? key : [key]).map((k) => [
                  k,
                  structuredClone(h.storage[k]),
                ]),
              ),
        set: async (value) => Object.assign(h.storage, structuredClone(value)),
        remove: async (keys) => keys.forEach((k) => delete h.storage[k]),
      },
    },
    tabs: { create: async () => {} },
  };
  const document = {
    getElementById(id) {
      assert.ok(elements[id], "missing HTML element " + id);
      return elements[id];
    },
    createElement: () => new Element(),
    addEventListener() {},
    body: new Element(),
  };
  const ctx = vm.createContext({
    browser,
    document,
    URL,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Blob,
    confirm: () => false,
    prompt: () => null,
  });
  vm.runInContext(fs.readFileSync("members/reader/model.js", "utf8"), ctx);
  vm.runInContext(fs.readFileSync("members/reader/body.js", "utf8"), ctx);
  vm.runInContext(fs.readFileSync("members/reader/app.js", "utf8"), ctx);
  await waitFor(() => elements.inboxList.children.length === 1);
  await waitFor(() =>
    h.requests.some((r) => r.action === "pending_comment_likes"),
  );
  h.click = async (text) => {
    const all = [];
    const visit = (e) => {
      all.push(e);
      e.children.forEach(visit);
    };
    Object.values(elements).forEach(visit);
    const control = all.find(
      (e) => e.textContent === text && e.handlers.click?.length,
    );
    assert.ok(control, "button " + text);
    await control.click();
  };
  h.open = async () => {
    await h.click("返信を書く");
    elements.draft.value = "ありがとうございます";
    elements.draft.oninput();
  };
  return h;
}
{
  const h = await harness();
  await h.open();
  assert.equal(h.elements.replyLike.checked, true);
  assert.match(h.elements.send.textContent, /返信＋スキ/);
  await h.elements.send.click();
  assert.equal(
    h.requests.filter((r) => r.action === "reply_comment").length,
    1,
  );
  assert.equal(h.elements.draft.value, "");
  assert.equal(h.elements.inboxList.children.length, 0);
  assert.match(h.elements.sendStatus.textContent, /返信は送信済み/);
  assert.equal(h.elements.pendingLikesPanel.hidden, false);
  await h.click("スキのみ再試行");
  assert.equal(
    h.requests.filter((r) => r.action === "reply_comment").length,
    1,
    "like retry must not resend a reply",
  );
  assert.equal(h.requests.filter((r) => r.action === "comment_like").length, 1);
  assert.equal(h.elements.pendingLikesPanel.hidden, true);
}
{
  const h = await harness();
  await h.click("♡ コメントにスキ");
  assert.equal(
    h.requests.filter((r) => r.action === "reply_comment").length,
    0,
  );
  assert.equal(
    h.requests.find((r) => r.action === "comment_like").args.replyTarget
      .commentKey,
    "child",
  );
  assert.equal(h.elements.inboxList.children.length, 0);
}
{
  const h = await harness();
  await h.open();
  h.elements.replyLike.checked = false;
  h.elements.replyLike.onchange();
  await h.elements.send.click();
  assert.equal(
    h.requests.find((r) => r.action === "reply_comment").args.likeComment,
    false,
  );
  assert.equal(h.elements.sendStatus.textContent, "返信しました。");
}
{
  const h = await harness();
  h.replyMode = "unknown";
  await h.open();
  await h.elements.send.click();
  assert.equal(h.elements.send.disabled, true);
  assert.equal(h.elements.draft.value, "ありがとうございます");
  assert.equal(h.requests.filter((r) => r.action === "comment_like").length, 0);
  assert.equal(h.storage["nero.members.v1.alice"].uncertain["inbox-one"], true);
}
{
  const h = await harness();
  h.replyMode = "success";
  await h.open();
  h.holdHealth = true;
  const diagnosing = h.elements.connect.onclick();
  await waitFor(() => h.releaseHealth);
  // Release the earlier health response during the send's storage await.
  const sending = h.elements.send.click();
  h.releaseHealth();
  await sending;
  await diagnosing;
  assert.equal(
    h.requests.find((r) => r.action === "reply_comment").args.owner,
    "alice",
  );
  assert.equal(
    h.elements.account.textContent,
    "接続中 @alice",
    "stale health must not replace the active sending account",
  );
  assert.equal(h.elements.sendStatus.textContent, "返信とスキを送信しました。");
}
console.log(
  "comment-likes-ui-check-ok: standalone like, partial reply, like-only retry, opt-out, unknown reply, stale health isolation",
);
