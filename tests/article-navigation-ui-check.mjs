// Execute the real reader state and mutation handlers with a small DOM/Port.
// Body sanitizing is covered separately; this fixture captures its link callback.
// All people and articles are synthetic. No note requests are made.
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
    this.scrollTop = 0;
    this.clientHeight = 300;
    this.scrollHeight = 1200;
    this._text = "";
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((n) => n.textContent || "").join("");
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
  getAttribute(name) {
    return this[name] ?? null;
  }
  removeAttribute(name) {
    delete this[name];
  }
  focus() {}
  remove() {}
  scrollIntoView() {}
  async dispatch(type, extra = {}) {
    const event = {
      target: this,
      currentTarget: this,
      preventDefault() {},
      ...extra,
    };
    await this["on" + type]?.(event);
    for (const handler of this.handlers[type] || []) await handler(event);
  }
  click() {
    return this.disabled ? Promise.resolve() : this.dispatch("click");
  }
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(check, message = "UI did not reach expected state") {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await turn();
  }
  throw Error(message);
}
const source = (index) => ({
  key: "nsource" + index,
  url: "https://note.com/writer_a/n/nsource" + index,
  name: "Source " + index,
  urlname: "writer_a",
  liked: false,
});
const linked = {
  key: "nlinked",
  url: "https://note.com/writer_b/n/nlinked",
  urlname: "writer_b",
};
const nested = {
  key: "nnested",
  url: "https://note.com/writer_c/n/nnested",
  urlname: "writer_c",
};
function article(target, title) {
  return {
    ok: true,
    key: target.key,
    url: target.url,
    urlname: target.urlname,
    nickname: target.urlname,
    title,
    body: title + " body",
    publishAt: "2026-01-01T00:00:00Z",
  };
}
const storedList = (owner, creators) => ({
  owner,
  activeListId: "castle",
  lists: [
    { id: "castle", name: "Readers", users: creators, pending: [] },
    { id: "list-1", name: "Other", users: ["writer_c"], pending: [] },
  ],
});
async function harness() {
  const elements = {};
  for (const match of fs
    .readFileSync("members/reader/index.html", "utf8")
    .matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const el = (elements[match[2]] = new Element(
      match[2],
      match[1].toUpperCase(),
    ));
    el.hidden = /\bhidden\b/.test(match[0]);
    el.checked = /\bchecked\b/.test(match[0]);
  }
  assert.ok(elements.articleBack, "missing article return control");
  const listeners = [],
    timers = new Set();
  const h = {
    elements,
    owner: "alice",
    requests: [],
    rendered: [],
    held: [],
    holdKeys: new Set(),
    cardsByBody: new Map(),
    createdCards: [],
    articles: new Map([
      ["nsource0", article(source(0), "Source 0")],
      ["nsource1", article(source(1), "Source 1")],
      [linked.key, article(linked, "Linked")],
      [nested.key, article(nested, "Nested")],
    ]),
    storage: {
      "nero.members.v1.alice": storedList("alice", ["writer_a"]),
      "nero.members.v1.bob": storedList("bob", ["writer_d"]),
    },
  };
  const respond = (request, result) =>
    queueMicrotask(() =>
      listeners.forEach((fn) =>
        fn({ type: "response", requestId: request.requestId, result }),
      ),
    );
  const browser = {
    runtime: {
      connect: () => ({
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onDisconnect: { addListener() {} },
        postMessage(request) {
          h.requests.push(structuredClone(request));
          if (request.action === "health")
            return respond(request, {
              ok: true,
              noteOk: !!h.owner,
              owner: h.owner,
            });
          if (
            ["inbox_status", "pending_comment_likes"].includes(request.action)
          )
            return respond(request, { ok: true, items: [] });
          if (request.action === "watch_feed")
            return respond(request, {
              ok: true,
              items: [source(0), source(1)],
            });
          if (request.action === "article") {
            if (h.holdKeys.has(request.args.key)) {
              h.held.push(request);
              return;
            }
            return respond(
              request,
              h.articles.get(request.args.key) || {
                ok: false,
                message: "No synthetic article",
              },
            );
          }
          if (request.action === "note_action")
            return respond(request, {
              ok: true,
              liked: false,
              commentSent: request.args.noteAction === "comment",
            });
          return respond(request, { ok: true });
        },
      }),
    },
    storage: {
      local: {
        get: async (keys) =>
          keys === null
            ? structuredClone(h.storage)
            : Object.fromEntries(
                (Array.isArray(keys) ? keys : [keys]).map((k) => [
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
      return elements[id] || null;
    },
    createElement: (tag) => new Element("", tag.toUpperCase()),
    createDocumentFragment: () => new Element(),
    createTextNode: (text) =>
      Object.assign(new Element(), { textContent: text }),
    addEventListener() {},
    body: new Element(),
  };
  const ctx = vm.createContext({
    browser,
    document,
    URL,
    Blob,
    console,
    queueMicrotask,
    DOMParser: class {
      parseFromString(text) {
        return {
          body: {
            textContent: String(text),
            childNodes: [{ nodeType: 3, nodeValue: String(text) }],
          },
        };
      }
    },
    setTimeout(fn, delay) {
      const timer = setTimeout(fn, delay);
      timer.unref();
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      clearTimeout(timer);
      timers.delete(timer);
    },
    requestAnimationFrame: (fn) => {
      fn();
      return 1;
    },
    confirm: () => false,
    prompt: () => null,
  });
  vm.runInContext(fs.readFileSync("members/reader/model.js", "utf8"), ctx);
  vm.runInContext(fs.readFileSync("members/reader/body.js", "utf8"), ctx);
  ctx.NeroArticleBody.render = (body, options) => {
    h.rendered.push({ body, options });
    for (const spec of h.cardsByBody.get(body) || []) {
      const card = {
        ...spec,
        element: new Element(),
        link: new Element("", "A"),
        title: new Element("", "STRONG"),
        description: new Element(),
        meta: new Element(),
        image: new Element("", "IMG"),
      };
      card.title.textContent = "Visible link";
      card.link.href = spec.url;
      card.image.hidden = true;
      card.description.hidden = true;
      h.createdCards.push(card);
      options.onCard?.(card);
    }
    return Object.assign(new Element(), { textContent: String(body) });
  };
  vm.runInContext(fs.readFileSync("members/reader/app.js", "utf8"), ctx);
  await waitFor(
    () =>
      elements.account.textContent === "接続中 @alice" &&
      h.requests.some((r) => r.action === "pending_comment_likes"),
  );
  h.feed = async () => {
    await elements.refreshFeed.click();
    await waitFor(() => elements.body.textContent === "Source 0 body");
  };
  h.follow = (target) => {
    const options = h.rendered.at(-1)?.options;
    assert.equal(
      typeof options?.onArticleLink,
      "function",
      "reader must wire note-link callback",
    );
    return options.onArticleLink(target, {
      button: 0,
      preventDefault() {},
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });
  };
  h.release = (key, result) => {
    const request = h.held.find((r) => r.args.key === key);
    assert.ok(request, "missing held article request " + key);
    h.held.splice(h.held.indexOf(request), 1);
    respond(request, result || h.articles.get(key));
  };
  h.change = async (id, value) => {
    elements[id].value = value;
    await elements[id].dispatch("change");
  };
  h.mutations = (action) =>
    h.requests.filter(
      (r) => r.action === "note_action" && r.args.noteAction === action,
    );
  h.dispose = () => timers.forEach(clearTimeout);
  return h;
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
  await h.feed();
  h.elements.articleScroll.scrollTop = 317;
  await h.follow(linked);
  await waitFor(() => h.elements.body.textContent === "Linked body");
  assert.equal(h.elements.original.href, linked.url);
  assert.equal(h.elements.articleBack.hidden, false);
  assert.equal(h.elements.prev.disabled, true);
  assert.equal(h.elements.next.disabled, true);
  await h.elements.next.click();
  assert.equal(h.elements.title.textContent, "Linked");
  h.elements.articleScroll.scrollTop = 900;
  await h.elements.articleScroll.dispatch("touchstart", {
    touches: [{ clientX: 30, clientY: 300 }],
  });
  await h.elements.articleScroll.dispatch("touchend", {
    changedTouches: [{ clientX: 30, clientY: 80 }],
  });
  assert.equal(
    h.elements.title.textContent,
    "Linked",
    "linked views must not swipe the hidden feed",
  );
  h.elements.articleScroll.scrollTop = 79;
  await h.follow(nested);
  await waitFor(() => h.elements.body.textContent === "Nested body");
  await h.elements.articleBack.click();
  await waitFor(() => h.elements.body.textContent === "Linked body");
  assert.equal(h.elements.articleScroll.scrollTop, 79);
  await h.elements.articleBack.click();
  await waitFor(() => h.elements.body.textContent === "Source 0 body");
  assert.equal(h.elements.articleScroll.scrollTop, 317);
  assert.equal(
    h.elements.position.textContent,
    "1 / 2",
    "link traversal must preserve feed position",
  );
  assert.equal(h.elements.articleBack.hidden, true);
  await h.elements.next.click();
  await waitFor(() => h.elements.body.textContent === "Source 1 body");
  assert.equal(
    h.elements.position.textContent,
    "2 / 2",
    "link traversal must preserve original feed order",
  );
});

await withHarness(async (h) => {
  await h.feed();
  h.holdKeys.add(linked.key);
  const opening = h.follow({
    key: linked.key,
    url: "https://note.com/embed/notes/nlinked",
    urlname: "",
  });
  await waitFor(() => h.held.length === 1);
  assert.equal(
    h.elements.like.disabled,
    true,
    "key-only link must resolve its canonical URL before liking",
  );
  assert.equal(h.elements.articleComment.disabled, true);
  h.release(linked.key);
  await opening;
  await waitFor(
    () =>
      h.elements.body.textContent === "Linked body" &&
      !h.elements.like.disabled,
  );
  assert.equal(h.elements.original.href, linked.url);
  await h.elements.like.click();
  assert.equal(h.mutations("like").at(-1).args.articleUrl, linked.url);
  await h.elements.articleComment.click();
  h.elements.draft.value = "Linked comment";
  await h.elements.draft.dispatch("input");
  await h.elements.send.click();
  assert.equal(
    h.mutations("comment").at(-1).args.articleUrl,
    linked.url,
    "a linked article comment must never target the hidden source feed article",
  );
  assert.equal(h.mutations("comment").at(-1).args.expectedAccount, "alice");
});

await withHarness(async (h) => {
  await h.feed();
  await h.elements.articleComment.click();
  h.elements.draft.value = "Source draft";
  await h.elements.draft.dispatch("input");
  await h.follow(linked);
  await waitFor(() => h.elements.body.textContent === "Linked body");
  assert.equal(h.elements.draft.value, "Source draft");
  await h.elements.send.click();
  assert.equal(
    h.mutations("comment").at(-1).args.articleUrl,
    source(0).url,
    "an already-open composer must keep its original destination",
  );
});

await withHarness(async (h) => {
  await h.feed();
  h.articles.set("nunknown", {
    ok: true,
    key: "nunknown",
    title: "Unknown creator",
    body: "Unresolved body",
    url: "",
  });
  await h.follow({
    key: "nunknown",
    url: "https://note.com/embed/notes/nunknown",
    urlname: "",
  });
  await waitFor(() => h.elements.body.textContent === "Unresolved body");
  assert.equal(h.elements.like.disabled, true);
  assert.equal(h.elements.articleComment.disabled, true);
  await h.elements.like.onclick();
  await h.elements.articleComment.onclick();
  assert.equal(
    h.mutations("like").length,
    0,
    "unresolved URLs must not issue likes",
  );
  assert.equal(
    h.elements.composer.hidden,
    true,
    "unresolved URLs must not create a sendable composer",
  );
  await h.elements.articleBack.click();
  await waitFor(() => h.elements.body.textContent === "Source 0 body");
});

for (const reset of ["back", "list", "account"])
  await withHarness(async (h) => {
    await h.feed();
    h.holdKeys.add(linked.key);
    const opening = h.follow({
      key: linked.key,
      url: "https://note.com/embed/notes/nlinked",
      urlname: "",
    });
    await waitFor(() => h.held.length === 1);
    if (reset === "back") {
      await h.elements.articleBack.click();
      await waitFor(() => h.elements.body.textContent === "Source 0 body");
    } else if (reset === "list") {
      await h.change("watchSelect", "list-1");
    } else {
      h.owner = "bob";
      await h.elements.connect.click();
      assert.equal(h.elements.account.textContent, "接続中 @bob");
    }
    h.release(linked.key);
    await opening;
    await turn();
    assert.notEqual(
      h.elements.body.textContent,
      "Linked body",
      "late linked article must not replace the current view: " + reset,
    );
    assert.equal(
      h.elements.articleBack.hidden,
      true,
      "reset must clear linked history: " + reset,
    );
    if (reset === "back") {
      assert.equal(h.elements.original.href, source(0).url);
      await h.elements.like.click();
      assert.equal(h.mutations("like").at(-1).args.articleUrl, source(0).url);
    } else {
      assert.equal(h.elements.article.hidden, true);
      assert.equal(h.elements.position.textContent, "0 / 0");
    }
  });
await withHarness(async (h) => {
  const target = {
    key: "ncard",
    url: "https://note.com/writer_card/n/ncard",
    urlname: "writer_card",
  };
  h.articles.set(target.key, {
    ...article(target, "Card article"),
    description: "Card description",
    imageUrl: "https://images.example/cover.jpg",
  });
  h.cardsByBody.set("Source 0 body", [
    { key: target.key, url: "https://note.com/embed/notes/ncard" },
    { key: target.key, url: "https://note.com/embed/notes/ncard" },
    { key: "", url: "https://external.example/article" },
  ]);
  await h.feed();
  await waitFor(() => h.createdCards[0]?.title.textContent === "Card article");
  assert.equal(
    h.requests.filter(
      (r) => r.action === "article" && r.args.key === target.key,
    ).length,
    1,
    "duplicate visible note cards must share their metadata request",
  );
  for (const card of h.createdCards.filter((c) => c.key)) {
    assert.equal(card.link.href, target.url);
    assert.equal(card.description.textContent, "Card description");
    assert.equal(card.description.hidden, false);
    assert.equal(card.image.hidden, false);
    assert.equal(card.image.src, "https://images.example/cover.jpg");
  }
  const external = h.createdCards.find((card) => !card.key);
  assert.equal(external.title.textContent, "Visible link");
  assert.equal(
    h.requests.some((r) => r.action === "article" && !r.args.key),
    false,
    "external link cards must not trigger article metadata fetches",
  );
});

await withHarness(async (h) => {
  h.holdKeys.add("ncard");
  h.cardsByBody.set("Source 0 body", [
    { key: "ncard", url: "https://note.com/embed/notes/ncard" },
  ]);
  h.articles.set("ncard", {
    ...article(
      {
        key: "ncard",
        url: "https://note.com/writer_card/n/ncard",
        urlname: "writer_card",
      },
      "Late card",
    ),
    imageUrl: "https://images.example/late.jpg",
  });
  await h.feed();
  await waitFor(() => h.held.some((r) => r.args.key === "ncard"));
  const oldCard = h.createdCards[0];
  await h.follow(linked);
  await waitFor(() => h.elements.body.textContent === "Linked body");
  h.release("ncard");
  await turn();
  assert.equal(
    oldCard.title.textContent,
    "Visible link",
    "late metadata must not mutate an old article's card",
  );
  assert.equal(oldCard.image.hidden, true);
  assert.equal(h.elements.body.textContent, "Linked body");
});
console.log(
  "article-navigation-ui-check-ok: internal history, scroll and feed retention, canonical resolution, displayed mutation targets, pinned composer, unresolved guards, stale back/list/account isolation, card metadata hydration/deduplication/stale guards",
);
