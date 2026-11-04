// Run the real reader handlers against a small DOM and extension Port mock.
// This checks feed wiring and stale results; live note access and layout need
// separate browser checks. Every username and article in this test is synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class Element {
  constructor(id = "", tagName = "DIV") {
    this.id = id;
    this.tagName = tagName;
    this.children = [];
    this.handlers = {};
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this._text = "";
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return (
      this._text + this.children.map((node) => node.textContent || "").join("")
    );
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this._text = "";
    this.children = nodes;
  }
  addEventListener(type, handler) {
    (this.handlers[type] ??= []).push(handler);
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  removeAttribute(name) {
    delete this[name];
  }
  focus() {}
  remove() {}
  async dispatch(type) {
    const event = { target: this, currentTarget: this, preventDefault() {} };
    await this["on" + type]?.(event);
    for (const handler of this.handlers[type] || []) await handler(event);
  }
  click() {
    return this.dispatch("click");
  }
}

const next = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(check, message = "UI did not reach expected state") {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await next();
  }
  throw new Error(message);
}

const storedList = (owner, creators) => ({
  owner,
  activeListId: "castle",
  lists: [
    { id: "castle", name: "Readers", users: creators, pending: [] },
    { id: "list-1", name: "Other readers", users: ["writer_c"], pending: [] },
  ],
});

async function harness() {
  const elements = {};
  for (const match of fs
    .readFileSync("members/reader/index.html", "utf8")
    .matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const element = (elements[match[2]] = new Element(
      match[2],
      match[1].toUpperCase(),
    ));
    element.hidden = /\bhidden\b/.test(match[0]);
    element.checked = /\bchecked\b/.test(match[0]);
  }
  for (const id of [
    "feedIncludeLiked",
    "deepCreator",
    "deepIncludeLiked",
    "deepFetch",
  ])
    assert.ok(elements[id], "missing feed HTML control " + id);
  const listeners = [];
  const h = {
    elements,
    owner: "alice",
    requests: [],
    feeds: [],
    statusByUrl: new Map(),
    storage: {
      "nero.members.v1.alice": storedList("alice", ["writer_a", "writer_b"]),
      "nero.members.v1.bob": storedList("bob", ["writer_d"]),
    },
  };
  const emit = (message) =>
    queueMicrotask(() => listeners.forEach((fn) => fn(message)));
  const respond = (message, result) =>
    emit({
      type: "response",
      requestId: message.requestId,
      result,
    });
  const browser = {
    runtime: {
      connect: () => ({
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onDisconnect: { addListener() {} },
        postMessage(message) {
          h.requests.push(structuredClone(message));
          if (message.action === "watch_feed") {
            h.feeds.push(structuredClone(message));
            return;
          }
          if (message.action === "health")
            return respond(message, {
              ok: true,
              noteOk: !!h.owner,
              owner: h.owner,
            });
          if (
            ["inbox_status", "pending_comment_likes"].includes(message.action)
          )
            return respond(message, { ok: true, items: [] });
          if (message.action === "note_action")
            return respond(message, {
              ok: true,
              liked: h.statusByUrl.get(message.args.articleUrl) === true,
            });
          if (message.action === "article")
            return respond(message, { ok: true, body: "Article body" });
          return respond(message, { ok: true });
        },
      }),
    },
    storage: {
      local: {
        get: async (keys) =>
          keys === null
            ? structuredClone(h.storage)
            : Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys]).map((key) => [
                  key,
                  structuredClone(h.storage[key]),
                ]),
              ),
        set: async (value) => {
          const saved = structuredClone(value);
          if (h.holdNextSave) {
            h.holdNextSave = false;
            await new Promise((resolve) => {
              h.releaseSave = resolve;
            });
          }
          Object.assign(h.storage, saved);
        },
        remove: async (keys) => keys.forEach((key) => delete h.storage[key]),
      },
    },
    tabs: { create: async () => {} },
  };
  const document = {
    getElementById(id) {
      assert.ok(elements[id], "app requested missing HTML element " + id);
      return elements[id];
    },
    createElement: (tag) => new Element("", tag.toUpperCase()),
    createDocumentFragment: () => new Element(),
    createTextNode: (value) =>
      Object.assign(new Element(), { textContent: value }),
    addEventListener() {},
    body: new Element(),
  };
  class DOMParser {
    parseFromString(value) {
      return {
        body: { childNodes: [{ nodeType: 3, nodeValue: String(value) }] },
      };
    }
  }
  const timers = new Set();
  const ctx = vm.createContext({
    browser,
    document,
    DOMParser,
    URL,
    Blob,
    console,
    queueMicrotask,
    setTimeout(fn, timeout) {
      const timer = setTimeout(fn, timeout);
      timers.add(timer);
      timer.unref();
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
      clearTimeout(timer);
    },
    confirm: () => false,
    prompt: () => null,
  });
  vm.runInContext(fs.readFileSync("members/reader/model.js", "utf8"), ctx);
  vm.runInContext(fs.readFileSync("members/reader/body.js", "utf8"), ctx);
  vm.runInContext(fs.readFileSync("members/reader/app.js", "utf8"), ctx);
  await waitFor(
    () =>
      elements.account.textContent === "接続中 @alice" &&
      h.requests.some((request) => request.action === "pending_comment_likes"),
  );
  h.start = async (id) => {
    const before = h.feeds.length;
    const finished = elements[id].click();
    await waitFor(
      () => h.feeds.length > before,
      id + " did not request a feed",
    );
    return { request: h.feeds[before], finished };
  };
  h.finish = async (call, items, extra = {}) => {
    for (const item of items) h.statusByUrl.set(item.url, item.liked);
    respond(call.request, { ok: true, items, ...extra });
    await call.finished;
    await next();
  };
  h.progress = async (call, message) => {
    emit({
      type: "progress",
      requestId: call.request.requestId,
      progress: { message, completed: 1, total: 2 },
    });
    await next();
  };
  h.change = async (id, value) => {
    if (typeof value === "boolean") elements[id].checked = value;
    else elements[id].value = value;
    await elements[id].dispatch("input");
    await elements[id].dispatch("change");
  };
  h.dispose = () => timers.forEach(clearTimeout);
  return h;
}

function articles(count, prefix = "article", liked = (i) => i % 2 === 0) {
  return Array.from({ length: count }, (_, i) => ({
    key: "n" + prefix + i,
    url: `https://note.com/writer_a/n/n${prefix}${i}`,
    name: prefix + " " + i,
    urlname: "writer_a",
    liked: liked(i),
  }));
}

async function withHarness(check) {
  const h = await harness();
  try {
    await check(h);
  } finally {
    h.dispose();
  }
}

await withHarness(async (h) => {
  await h.change("feedIncludeLiked", false);
  const call = await h.start("refreshFeed");
  assert.deepEqual(call.request.args, {
    creators: ["writer_a", "writer_b"],
    expectedAccount: "alice",
    includeLiked: false,
    mode: "watch",
  });
  const items = articles(4, "unliked");
  delete items[2].liked;
  items[3].liked = null;
  await h.finish(call, items);
  assert.equal(
    h.elements.position.textContent,
    "1 / 1",
    "unliked mode fails closed for unknown status",
  );
  assert.equal(h.elements.title.textContent, items[1].name);
});

await withHarness(async (h) => {
  await h.change("feedIncludeLiked", true);
  const call = await h.start("refreshFeed");
  assert.equal(call.request.args.includeLiked, true);
  assert.equal(call.request.args.mode, "watch");
  const items = articles(5, "watchorder");
  await h.finish(call, items);
  assert.equal(h.elements.position.textContent, "1 / 5");
  assert.equal(h.elements.like.textContent, "♥ スキ済み");
  assert.equal(h.elements.like.disabled, true);
  for (const [i, item] of items.entries()) {
    assert.equal(
      h.elements.title.textContent,
      item.name,
      "watch preserves backend order",
    );
    assert.equal(h.elements.position.textContent, `${i + 1} / ${items.length}`);
    if (i < items.length - 1) await h.elements.next.click();
  }
});

await withHarness(async (h) => {
  await h.change("deepCreator", "https://note.com/WRITER_X?from=profile");
  await h.change("deepIncludeLiked", true);
  const call = await h.start("deepFetch");
  assert.deepEqual(call.request.args, {
    creator: "writer_x",
    expectedAccount: "alice",
    includeLiked: true,
    mode: "deep",
  });
  assert.equal(
    h.elements.refreshFeed.disabled,
    true,
    "feed actions share a running job",
  );
  assert.equal(h.elements.deepFetch.disabled, true);
  assert.equal(h.elements.cancelFeed.hidden, false);
  const items = articles(50, "deeporder");
  await h.finish(call, items);
  assert.equal(
    h.elements.position.textContent,
    "1 / 50",
    "deep feed retains all 50 returned articles",
  );
  assert.equal(
    h.elements.like.textContent,
    "♥ スキ済み",
    "deep mode displays liked articles",
  );
  for (const [i, item] of items.entries()) {
    assert.equal(
      h.elements.title.textContent,
      item.name,
      "deep preserves backend order",
    );
    if (i < items.length - 1) await h.elements.next.click();
  }
  assert.equal(h.elements.position.textContent, "50 / 50");
});

await withHarness(async (h) => {
  await h.change("deepCreator", "@WRITER_Z");
  await h.change("deepIncludeLiked", false);
  const call = await h.start("deepFetch");
  assert.deepEqual(call.request.args, {
    creator: "writer_z",
    expectedAccount: "alice",
    includeLiked: false,
    mode: "deep",
  });
  await h.finish(
    call,
    articles(50, "deepunliked", () => false),
  );
  assert.equal(h.elements.position.textContent, "1 / 50");
  assert.equal(h.elements.like.textContent, "♡ スキ");
  for (const value of [
    "",
    "invalid username",
    "https://example.com/writer_a",
    "http://note.com/writer_a",
    "https://note.com/",
  ]) {
    await h.change("deepCreator", value);
    const before = h.feeds.length;
    await h.elements.deepFetch.click();
    assert.equal(
      h.feeds.length,
      before,
      "invalid deep creator must not request a feed: " + value,
    );
    assert.equal(h.elements.notice.hidden, false);
  }
});

for (const scenario of [
  { button: "refreshFeed", field: "feedIncludeLiked", value: true },
  { button: "deepFetch", field: "deepIncludeLiked", value: true },
  { button: "deepFetch", field: "deepCreator", value: "writer_new" },
])
  await withHarness(async (h) => {
    await h.change("deepCreator", "writer_a");
    await h.change(
      scenario.field,
      scenario.field === "deepCreator" ? "writer_a" : false,
    );
    const call = await h.start(scenario.button);
    await h.progress(call, "Before option change");
    assert.equal(h.elements.feedStatus.textContent, "Before option change");
    await h.change(scenario.field, scenario.value);
    const status = h.elements.feedStatus.textContent;
    await h.progress(call, "Stale progress");
    assert.equal(
      h.elements.feedStatus.textContent,
      status,
      "stale progress must not replace option-change status",
    );
    await h.finish(
      call,
      articles(2, "staleoption", () => false),
    );
    assert.equal(
      h.elements.position.textContent,
      "0 / 0",
      "option changes invalidate inflight results: " + scenario.field,
    );
    assert.equal(h.elements.article.hidden, true);
    assert.ok(
      h.requests.some(
        (r) => r.action === "cancel_job" && r.args.kind === "watch_feed",
      ),
    );
  });

await withHarness(async (h) => {
  const call = await h.start("refreshFeed");
  await h.change("watchSelect", "list-1");
  await h.finish(
    call,
    articles(1, "oldlist", () => false),
  );
  assert.equal(
    h.elements.position.textContent,
    "0 / 0",
    "list changes reject old results",
  );
  const nextCall = await h.start("refreshFeed");
  assert.deepEqual(nextCall.request.args.creators, ["writer_c"]);
  await h.finish(
    nextCall,
    articles(1, "newlist", () => false),
  );
  assert.equal(h.elements.title.textContent, "newlist 0");
});

for (const button of ["refreshFeed", "deepFetch"])
  await withHarness(async (h) => {
    await h.change("deepCreator", "writer_a");
    h.holdNextSave = true;
    const fetching = h.elements[button].click();
    await waitFor(() => h.releaseSave, "feed did not wait for option storage");
    assert.equal(h.feeds.length, 0, "feed RPC must wait for option storage");
    assert.equal(h.elements.cancelFeed.hidden, false);
    await h.elements.cancelFeed.click();
    h.releaseSave();
    await fetching;
    assert.equal(
      h.feeds.length,
      0,
      "cancel while saving must prevent a later feed RPC",
    );
    assert.equal(
      h.requests.filter((request) => request.action === "cancel_job").length,
      0,
      "a job that has not started needs no backend cancellation",
    );
    assert.equal(h.elements.position.textContent, "0 / 0");
    assert.equal(h.elements.cancelFeed.hidden, true);
    assert.equal(h.elements.refreshFeed.disabled, false);
    assert.equal(h.elements.deepFetch.disabled, false);
    const nextCall = await h.start(button);
    await h.finish(
      nextCall,
      articles(1, "afterearlycancel", () => false),
    );
    assert.equal(
      h.elements.title.textContent,
      "afterearlycancel 0",
      "an early cancellation must not cancel the next fetch",
    );
  });

for (const button of ["refreshFeed", "deepFetch"])
  await withHarness(async (h) => {
    await h.change("deepCreator", "writer_a");
    const call = await h.start(button);
    assert.equal(call.request.args.expectedAccount, "alice");
    h.owner = "bob";
    await h.elements.connect.click();
    assert.equal(h.elements.account.textContent, "接続中 @bob");
    await h.finish(
      call,
      articles(1, "oldowner", () => false),
    );
    assert.equal(
      h.elements.position.textContent,
      "0 / 0",
      "account changes reject old feed results",
    );
    assert.equal(h.elements.article.hidden, true);
    if (button === "deepFetch") await h.change("deepCreator", "writer_a");
    const nextCall = await h.start(button);
    assert.equal(nextCall.request.args.expectedAccount, "bob");
    if (button === "refreshFeed")
      assert.deepEqual(nextCall.request.args.creators, ["writer_d"]);
    await h.elements.cancelFeed.click();
    assert.ok(
      h.requests.some(
        (r) => r.action === "cancel_job" && r.args.kind === "watch_feed",
      ),
      "both feed modes share cancellation",
    );
    await h.finish(
      nextCall,
      articles(1, "partialcancel", () => false),
      { cancelled: true },
    );
    assert.equal(
      h.elements.position.textContent,
      "1 / 1",
      "cancel keeps partial results already collected",
    );
    assert.equal(h.elements.title.textContent, "partialcancel 0");
    assert.match(h.elements.feedStatus.textContent, /中断/);
    assert.equal(h.elements.cancelFeed.hidden, true);
    assert.equal(h.elements.refreshFeed.disabled, false);
    assert.equal(h.elements.deepFetch.disabled, false);
  });

console.log(
  "feed-modes-ui-check-ok: watch/deep options, 50 articles, backend order, liked articles, validation, stale option/list/account isolation, cancel before RPC, partial results",
);
