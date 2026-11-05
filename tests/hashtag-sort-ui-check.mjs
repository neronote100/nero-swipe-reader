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
          if (["watch_feed", "hashtag_feed"].includes(message.action)) {
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
  const originalRender = ctx.NeroArticleBody.render;
  ctx.NeroArticleBody.render = (value, options) => {
    h.follow = options.onArticleLink;
    return originalRender(value, options);
  };
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

const timed = [
  {
    key: "nnew",
    url: "https://note.com/writer_a/n/nnew",
    name: "New",
    liked: false,
    publishAt: "2026-11-05T12:00:03+09:00",
  },
  {
    key: "nold",
    url: "https://note.com/writer_a/n/nold",
    name: "Old",
    liked: false,
    publishAt: "2026-11-05T12:00:01+09:00",
  },
  {
    key: "nmid",
    url: "https://note.com/writer_a/n/nmid",
    name: "Middle",
    liked: false,
    publishAt: "2026-11-05T12:00:02+09:00",
  },
];
await withHarness(async (h) => {
  const call = await h.start("refreshFeed");
  await h.finish(call, timed);
  const feeds = h.feeds.length,
    requests = h.requests.length;
  assert.equal(h.elements.title.textContent, "New");
  assert.match(
    h.elements.author.textContent,
    /:03$/,
    "article dates display seconds",
  );
  await h.change("articleOrder", "date_asc");
  assert.equal(h.elements.title.textContent, "New");
  assert.equal(h.elements.position.textContent, "3 / 3");
  assert.equal(h.feeds.length, feeds);
  assert.equal(
    h.requests.length,
    requests,
    "ordering does not refetch feeds or body",
  );
  await h.elements.prev.click();
  await next();
  assert.equal(h.elements.title.textContent, "Middle");
  await h.change("articleOrder", "date_desc");
  assert.equal(h.elements.position.textContent, "2 / 3");
  const before = h.requests.length;
  await h.change("articleOrder", "random");
  assert.equal(h.elements.position.textContent, "3 / 3");
  assert.equal(h.elements.title.textContent, "Middle");
  assert.equal(h.requests.length, before);
  assert.match(h.elements.readerListName.textContent, /ランダム/);
});
await withHarness(async (h) => {
  await h.change("watchSelect", "list-2");
  await h.change(
    "hashtagInput",
    "https://note.com/hashtag/%E4%BC%81%E7%94%BB?f=new",
  );
  await h.change("hashtagIncludeLiked", true);
  await h.change("hashtagLimit", "200");
  const call = await h.start("hashtagFetch");
  assert.equal(call.request.action, "hashtag_feed");
  assert.deepEqual(call.request.args, {
    hashtag: "企画",
    limit: 200,
    expectedAccount: "alice",
    includeLiked: true,
  });
  for (const id of ["refreshFeed", "deepFetch", "hashtagFetch"])
    assert.equal(h.elements[id].disabled, true);
  await h.progress(call, "searching");
  await h.change("articleOrder", "date_asc");
  assert.equal(
    h.elements.feedStatus.textContent,
    "searching",
    "sort changes do not cancel in-flight collection",
  );
  await h.finish(call, [timed[0], timed[2], timed[1]], {
    mode: "hashtag",
    hashtag: "企画",
    limit: 200,
    includeLiked: true,
    hasMore: true,
    limitReached: true,
  });
  assert.equal(h.elements.title.textContent, "Old");
  assert.match(h.elements.readerListName.textContent, /#企画.*古い順/);
  assert.match(h.elements.feedStatus.textContent, /未取得/);
  for (const id of ["refreshFeed", "deepFetch", "hashtagFetch"])
    assert.equal(h.elements[id].disabled, false);
  const saved = h.storage["nero.members.v1.alice"].feedOptions;
  assert.equal(saved.hashtag, "企画");
  assert.equal(saved.hashtagLimit, 200);
  assert.equal(saved.hashtagIncludeLiked, true);
  assert.equal(saved.articleOrder, "date_asc");
  h.owner = "bob";
  await h.elements.connect.click();
  assert.equal(h.elements.hashtagInput.value, "");
  assert.equal(h.elements.hashtagIncludeLiked.checked, false);
  assert.equal(h.elements.hashtagLimit.value, "100");
  assert.equal(h.elements.articleOrder.value, "random");
  h.owner = "alice";
  await h.elements.connect.click();
  assert.equal(h.elements.hashtagInput.value, "企画");
  assert.equal(h.elements.articleOrder.value, "date_asc");
});
await withHarness(async (h) => {
  await h.change("hashtagInput", "#企画");
  const call = await h.start("hashtagFetch");
  await h.change("hashtagInput", "#別企画");
  const status = h.elements.feedStatus.textContent;
  await h.finish(call, timed, { mode: "hashtag", hashtag: "企画", limit: 100 });
  assert.equal(h.elements.position.textContent, "0 / 0");
  assert.equal(h.elements.feedStatus.textContent, status);
  assert.ok(
    h.requests.some(
      (r) => r.action === "cancel_job" && r.args.kind === "watch_feed",
    ),
  );
});
await withHarness(async (h) => {
  for (const value of [
    "",
    "#",
    "a b",
    "##企画",
    "https://evil.test/hashtag/x",
  ]) {
    await h.change("hashtagInput", value);
    await h.elements.hashtagFetch.click();
  }
  assert.equal(h.feeds.length, 0);
  assert.match(h.elements.notice.textContent, /ハッシュタグ/);
  await h.change("hashtagInput", "企画");
  const call = await h.start("hashtagFetch");
  await h.elements.cancelFeed.click();
  await h.finish(call, [timed[0]], {
    cancelled: true,
    mode: "hashtag",
    hashtag: "企画",
    limit: 100,
    partial: true,
    hasMore: true,
  });
  assert.equal(h.elements.position.textContent, "1 / 1");
  assert.match(h.elements.feedStatus.textContent, /中断/);
});
await withHarness(async (h) => {
  const call = await h.start("refreshFeed");
  await h.finish(call, [timed[1], timed[0], timed[2]]);
  h.elements.articleScroll.scrollTop = 123;
  await waitFor(() => typeof h.follow === "function");
  h.follow({
    key: "nlinked",
    url: "https://note.com/linked_writer/n/nlinked",
    urlname: "linked_writer",
  });
  await next();
  assert.equal(h.elements.title.textContent, "リンク先の記事");
  const requests = h.requests.length;
  await h.change("articleOrder", "date_desc");
  assert.equal(h.elements.title.textContent, "リンク先の記事");
  assert.equal(h.requests.length, requests);
  await h.elements.articleBack.click();
  await next();
  assert.equal(h.elements.title.textContent, "Old");
  assert.equal(h.elements.position.textContent, "3 / 3");
  assert.equal(h.elements.articleScroll.scrollTop, 123);
});
console.log(
  "hashtag-sort-ui-check-ok: full-second ordering without refetch, retained current article and linked history, exact tag requests, caps, independent liked option, stale/cancel guards and account preferences",
);
