// Run the generated Chrome bundle, the shipped local Port transport, and the
// real note API implementation together. HTTP replies and browser UI are
// synthetic. Extension-origin fetch is intentionally blocked: HTTP must run
// through the real transport inside a separate, persistent note top-frame VM.
// This is a runtime integration check, not a Chromium layout test.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const out = "dist/chrome-members/";
const manifest = JSON.parse(fs.readFileSync(out + "manifest.json", "utf8"));
const engine = fs.readFileSync(out + "reader/engine.js", "utf8");
const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const extensionUrl = "chrome-extension://" + extensionId + "/";
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(check, description) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (check()) return;
    await turn();
  }
  throw new Error(description);
}

class Element {
  constructor(tag = "DIV", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.handlers = new Map();
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.scrollTop = 0;
    this._text = "";
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent || "").join("");
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this._text = "";
    this.children = children;
  }
  addEventListener(type, fn) {
    const listeners = this.handlers.get(type) || [];
    listeners.push(fn);
    this.handlers.set(type, listeners);
  }
  removeEventListener(type, fn) {
    this.handlers.set(
      type,
      (this.handlers.get(type) || []).filter((f) => f !== fn),
    );
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  removeAttribute(name) {
    delete this[name];
  }
  focus() {}
  remove() {}
  async emit(type, extra = {}) {
    const event = {
      target: this,
      currentTarget: this,
      preventDefault() {},
      ...extra,
    };
    await this["on" + type]?.(event);
    for (const fn of this.handlers.get(type) || []) await fn(event);
  }
  click() {
    return this.emit("click");
  }
}

const state = {
  owner: "alice",
  calls: [],
  posts: [],
  local: {
    "nero.members.v1.alice": {
      owner: "alice",
      activeListId: "castle",
      lists: [
        { id: "castle", name: "Readers", users: ["writer_a"], pending: [] },
      ],
    },
  },
  session: {},
  tabsUpdated: [],
  globals: new Map(),
  runtimeConnectCalls: 0,
  engineLoads: 0,
  engineErrors: [],
  liked: new Set(["n0", "n1", "n2"]),
  noteAvailable: true,
  extensionFetchCalls: 0,
  scriptCalls: [],
  authStatus: 200,
};
function storageArea(data) {
  return {
    async get(keys) {
      if (keys === null) return structuredClone(data);
      return Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((key) => [
          key,
          structuredClone(data[key]),
        ]),
      );
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
}
let noteContext;
const nativeChrome = {
  runtime: {
    id: extensionId,
    getURL: (path) => extensionUrl + path,
    getManifest: () => structuredClone(manifest),
    connect() {
      state.runtimeConnectCalls++;
      throw new Error(
        "The reader must not put long jobs in the service worker",
      );
    },
  },
  storage: {
    local: storageArea(state.local),
    session: storageArea(state.session),
  },
  tabs: {
    getCurrent: async () => ({
      id: 10,
      windowId: 2,
      url: extensionUrl + "reader/index.html",
    }),
    update: async (id, changes) => {
      state.tabsUpdated.push({ id, changes });
      return { id, windowId: 2, ...changes };
    },
    query: async (query = {}) => {
      const patterns = Array.isArray(query.url)
        ? query.url
        : query.url
          ? [query.url]
          : [];
      const reader = {
        id: 10,
        windowId: 2,
        url: extensionUrl + "reader/index.html",
        active: true,
      };
      const note = {
        id: 20,
        windowId: 2,
        url: "https://note.com/fixture",
        active: true,
      };
      if (patterns.some((url) => url.startsWith("https://note.com")))
        return state.noteAvailable ? [note] : [];
      if (patterns.some((url) => url.startsWith("chrome-extension:")))
        return [reader];
      return state.noteAvailable ? [reader, note] : [reader];
    },
    get: async (id) => {
      if (id === 20) {
        if (!state.noteAvailable) throw new Error("The note tab was closed");
        return {
          id,
          windowId: 2,
          url: "https://note.com/fixture",
          active: true,
        };
      }
      return { id, windowId: 2, url: extensionUrl + "reader/index.html" };
    },
    create: async () => {
      throw new Error("Fixture operations must not launch note tabs");
    },
    remove: async () => {},
  },
  windows: { update: async () => ({}) },
  permissions: {
    contains: async (request) => {
      assert.deepEqual(Array.from(request.permissions), ["scripting"]);
      assert.deepEqual(Array.from(request.origins), ["https://note.com/*"]);
      return true;
    },
  },
  scripting: {
    async executeScript(options) {
      assert.equal(
        options.target.tabId,
        20,
        "Only an existing note tab may receive API requests",
      );
      assert.deepEqual(
        Array.from(options.target.frameIds),
        [0],
        "Only the note top frame may execute requests",
      );
      assert.equal(
        options.world,
        "ISOLATED",
        "Site JavaScript must not become the transport",
      );
      assert.equal(state.noteAvailable, true);
      state.scriptCalls.push({
        tabId: options.target.tabId,
        world: options.world,
        name: options.func.name,
      });
      noteContext.__fixtureArgs = structuredClone(options.args || []);
      const beforePosts = state.posts.length;
      const result = await vm.runInContext(
        "(" + options.func.toString() + ")(...__fixtureArgs)",
        noteContext,
      );
      if (state.loseNextPostResult && state.posts.length > beforePosts) {
        state.loseNextPostResult = false;
        throw new Error("The note frame closed after accepting the request");
      }
      return [{ frameId: 0, result: structuredClone(result) }];
    },
  },
};
const elements = {};
for (const match of fs
  .readFileSync(out + "reader/index.html", "utf8")
  .matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
  const element = (elements[match[2]] = new Element(match[1], match[2]));
  element.hidden = /\bhidden\b/.test(match[0]);
  element.checked = /\bchecked\b/.test(match[0]);
}
let context;
const head = new Element("HEAD");
head.append = (script) => {
  assert.equal(
    script.src,
    extensionUrl + "reader/engine.js",
    "Bootstrap must load packaged code only",
  );
  state.engineLoads++;
  try {
    vm.runInContext(engine, context, { filename: "reader/engine.js" });
    queueMicrotask(() => script.emit("load"));
  } catch (error) {
    state.engineErrors.push(error);
    queueMicrotask(() => script.emit("error"));
  }
};
const document = {
  readyState: "complete",
  head,
  body: new Element("BODY"),
  getElementById(id) {
    assert.ok(elements[id], "Missing reader control " + id);
    return elements[id];
  },
  createElement: (tag) => new Element(tag),
  createDocumentFragment: () => new Element("FRAGMENT"),
  createTextNode: (value) =>
    Object.assign(new Element("TEXT"), { textContent: value }),
  addEventListener() {},
};
class DOMParser {
  parseFromString(text) {
    return { body: { childNodes: [{ nodeType: 3, nodeValue: String(text) }] } };
  }
}
const sourceRows = Array.from({ length: 53 }, (_, i) => ({
  key: "n" + i,
  name: "Fixture " + i,
  publishAt: new Date(Date.UTC(2026, 9, 31) - i * 86400000).toISOString(),
  noteUrl: "https://note.com/writer_a/n/n" + i,
  user: { urlname: "writer_a", nickname: "Writer A" },
}));
const response = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function fakeFetch(value, options = {}) {
  const url = new URL(value),
    method = options.method || "GET";
  assert.equal(
    url.origin,
    "https://note.com",
    "A test must never make a real or off-note request",
  );
  assert.equal(
    options.credentials,
    "include",
    "All note operations must reuse only the browser session",
  );
  state.calls.push({
    url: url.href,
    method,
    body: options.body,
    realm: "note-top-frame",
  });
  if (url.pathname === "/api/v2/current_user")
    return state.authStatus === 200
      ? response({ data: { key: state.owner + "-key", urlname: state.owner } })
      : response({ error: { message: "Session expired" } }, state.authStatus);
  if (url.pathname === "/api/v2/creators/writer_a/contents") {
    if (state.holdPage) {
      const wait = state.holdPage;
      state.holdPage = null;
      await wait;
    }
    const page = Number(url.searchParams.get("page"));
    return response({
      data: { contents: sourceRows.slice((page - 1) * 20, page * 20) },
    });
  }
  const note = url.pathname.match(/^\/api\/v3\/notes\/(n[\w-]+)$/);
  if (note) {
    const key = note[1],
      isLinked = key === "nlinked";
    return response({
      data: {
        key,
        name: isLinked ? "Linked fixture" : "Fixture " + key.slice(1),
        body: "Fixture article body",
        description: "Fixture description",
        user: {
          urlname: isLinked ? "writer_b" : "writer_a",
          nickname: "Writer",
        },
        is_liked: state.liked.has(key),
        publish_at: "2026-10-31T00:00:00Z",
      },
    });
  }
  if (method === "POST") {
    state.posts.push({ path: url.pathname, body: options.body });
    const like = url.pathname.match(/^\/api\/v3\/notes\/(n[\w-]+)\/likes$/);
    if (like) {
      state.liked.add(like[1]);
      return response({ data: {} });
    }
    if (/^\/api\/v3\/notes\/n[\w-]+\/note_comments$/.test(url.pathname))
      return response({ data: { key: "fixture-posted-comment" } });
  }
  throw new Error(
    "Unexpected synthetic API request " + method + " " + url.pathname,
  );
}
const timers = new Set();
const timed = (fn, delay) => {
  const timer = setTimeout(fn, delay);
  timer.unref();
  timers.add(timer);
  return timer;
};
const clearTimed = (timer) => {
  clearTimeout(timer);
  timers.delete(timer);
};
noteContext = vm.createContext({
  location: {
    href: "https://note.com/fixture",
    origin: "https://note.com",
    protocol: "https:",
    hostname: "note.com",
  },
  document: {
    get cookie() {
      throw new Error("The transport must never read Cookie contents");
    },
  },
  URL,
  URLSearchParams,
  Headers,
  Response,
  AbortController,
  TextEncoder,
  TextDecoder,
  crypto: webcrypto,
  structuredClone,
  queueMicrotask,
  console,
  setTimeout: timed,
  clearTimeout: clearTimed,
  fetch: async (value, options) => {
    const url = new URL(value, "https://note.com/fixture");
    const reply = await fakeFetch(url.href, options);
    Object.defineProperty(reply, "url", { value: url.href });
    return reply;
  },
});
vm.runInContext("self = top = window = globalThis", noteContext);
context = vm.createContext({
  chrome: nativeChrome,
  browser: nativeChrome,
  document,
  DOMParser,
  navigator: {
    locks: {
      request: async (name, options, callback) => {
        assert.equal(name, "nero-reader-runtime");
        assert.equal(options.ifAvailable, true);
        return callback({ name });
      },
    },
  },
  location: { href: extensionUrl + "reader/index.html", reload() {} },
  addEventListener(type, fn) {
    const listeners = state.globals.get(type) || [];
    listeners.push(fn);
    state.globals.set(type, listeners);
  },
  URL,
  URLSearchParams,
  AbortController,
  TextEncoder,
  TextDecoder,
  Headers,
  Response,
  Blob,
  crypto: webcrypto,
  structuredClone,
  queueMicrotask,
  fetch: async () => {
    state.extensionFetchCalls++;
    throw new TypeError(
      "Extension-origin note cookies are blocked in this fixture",
    );
  },
  console,
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
  confirm: () => false,
  prompt: () => null,
});
try {
  vm.runInContext(fs.readFileSync(out + "reader/model.js", "utf8"), context);
  vm.runInContext(fs.readFileSync(out + "reader/body.js", "utf8"), context);
  vm.runInContext(fs.readFileSync(out + "note-transport.js", "utf8"), context, {
    filename: "note-transport.js",
  });
  const platformPath = fs.existsSync(out + "platform.js")
    ? out + "platform.js"
    : out + "reader/platform.js";
  vm.runInContext(fs.readFileSync(platformPath, "utf8"), context, {
    filename: "platform.js",
  });
  const ready = await context.NeroChromePlatform.ready;
  assert.equal(
    ready.ok,
    true,
    String(state.engineErrors[0] || "Bootstrap failed"),
  );
  assert.equal(state.engineLoads, 1);
  assert.equal(context.chrome, nativeChrome);
  assert.equal(
    context.browser,
    nativeChrome,
    "Native browser namespace must not be replaced",
  );
  assert.equal(state.runtimeConnectCalls, 0);
  assert.equal(state.extensionFetchCalls, 0);
  await waitFor(
    () => elements.account.textContent === "接続中 @alice",
    "Real reader health request did not complete",
  );
  assert.equal(elements.watchCount.textContent, "1");
  assert.ok(
    state.tabsUpdated.some(
      (row) => row.id === 10 && row.changes.autoDiscardable === false,
    ),
  );

  let requestSequence = 0;
  async function rpc(action, args = {}, onProgress = () => {}) {
    const port = context.NeroChromePlatform.browser.runtime.connect({
      name: "NERO_APP_V2",
    });
    const requestId = "fixture-" + ++requestSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Local Port timed out for " + action)),
        5000,
      );
      port.onMessage.addListener((message) => {
        if (message.requestId !== requestId) return;
        if (message.type === "progress") return onProgress(message.progress);
        if (message.type === "response") {
          clearTimeout(timer);
          port.disconnect();
          resolve(message.result);
        }
      });
      port.postMessage({ type: "request", requestId, action, args });
    });
  }
  // Use the generated UI as well as direct local RPC. This reaches the actual
  // frontend, Port facade, router, current-account guards, and HTTP normalizers.
  await elements.refreshFeed.click();
  await waitFor(
    () => elements.position.textContent === "1 / 3",
    "Generated UI failed to display three unliked articles",
  );
  await waitFor(
    () => elements.body.textContent === "Fixture article body",
    "Generated reader failed to render fetched article text",
  );
  const normal = await rpc("watch_feed", {
    creators: ["writer_a"],
    expectedAccount: "alice",
  });
  assert.equal(normal.ok, true);
  assert.equal(normal.items.length, 3);
  assert.ok(
    normal.items.every(
      (row) => row.liked === false && !["n0", "n1", "n2"].includes(row.key),
    ),
  );
  const progress = [];
  const deep = await rpc(
    "watch_feed",
    { mode: "deep", creator: "writer_a", expectedAccount: "alice" },
    (p) => progress.push(p),
  );
  assert.equal(deep.ok, true);
  assert.equal(deep.items.length, 50);
  assert.equal(new Set(deep.items.map((r) => r.url)).size, 50);
  assert.ok(
    progress.length > 1,
    "Long jobs must publish progress over the local Port",
  );
  assert.ok(
    state.calls.some(
      (call) =>
        /creators\/writer_a\/contents/.test(call.url) &&
        new URL(call.url).searchParams.get("page") === "3",
    ),
  );
  const included = await rpc("watch_feed", {
    mode: "deep",
    creator: "writer_a",
    expectedAccount: "alice",
    includeLiked: true,
  });
  assert.equal(included.items.length, 50);
  assert.equal(included.checkedArticles, 0);
  assert.ok(included.items.some((row) => row.key === "n0"));
  const article = await rpc("article", { key: "nlinked" });
  assert.equal(article.url, "https://note.com/writer_b/n/nlinked");
  assert.equal(article.title, "Linked fixture");

  const target = "https://note.com/writer_b/n/nlinked";
  const liked = await rpc("note_action", {
    noteAction: "like",
    articleUrl: target,
    expectedAccount: "alice",
  });
  assert.equal(liked.ok, true);
  assert.equal(liked.verified, true);
  assert.equal(state.posts.at(-1).path, "/api/v3/notes/nlinked/likes");
  const commentArgs = {
    noteAction: "comment",
    articleUrl: target,
    expectedAccount: "alice",
    comment: "Synthetic browser fixture",
  };
  const commented = await rpc("note_action", commentArgs);
  assert.equal(commented.ok, true);
  assert.equal(commented.commentSent, true);
  assert.equal(state.posts.at(-1).path, "/api/v3/notes/nlinked/note_comments");
  assert.ok(
    Object.keys(state.local).some((key) =>
      key.startsWith("nero.members.sent.alice."),
    ),
  );
  const postCount = state.posts.length;
  const duplicate = await rpc("note_action", commentArgs);
  assert.equal(duplicate.already, true);
  assert.equal(state.posts.length, postCount);
  state.owner = "bob";
  const refused = await rpc("note_action", {
    noteAction: "like",
    articleUrl: target,
    expectedAccount: "alice",
  });
  assert.equal(refused.code, "account_changed");
  assert.equal(state.posts.length, postCount);
  state.owner = "alice";

  // An executeScript rejection can happen after note accepted a POST. The
  // transport must not automatically replay it, and the receipt stays unknown.
  state.loseNextPostResult = true;
  const unknownArgs = {
    ...commentArgs,
    articleUrl: "https://note.com/writer_b/n/nunknown",
    comment: "Unknown bridge response",
  };
  const beforeUnknown = state.posts.length;
  const unknown = await rpc("note_action", unknownArgs);
  assert.equal(unknown.ok, false);
  assert.equal(
    state.posts.length,
    beforeUnknown + 1,
    "A lost bridge reply must never retry a POST",
  );
  const heldUnknown = await rpc("note_action", unknownArgs);
  assert.equal(heldUnknown.code, "comment_result_unknown");
  assert.equal(state.posts.length, beforeUnknown + 1);

  // A login tab is required. Missing tabs and expired sessions must produce a
  // failed account check, rather than silently falling back to extension fetch.
  for (const status of [401, 403]) {
    state.authStatus = status;
    const health = await rpc("health");
    assert.equal(health.noteOk, false);
    assert.equal(health.owner, "");
    assert.match(
      health.noteError,
      status === 403 ? /拒否/ : /Chrome.*note|note.*タブ/,
    );
    await elements.connect.click();
    assert.equal(elements.account.textContent, "noteとの接続を確認できません");
    assert.equal(
      elements.notice.textContent,
      health.noteError,
      "The account error must reach the real reader UI",
    );
  }
  state.authStatus = 200;
  state.noteAvailable = false;
  const beforeMissingTab = state.calls.length;
  const missingTab = await rpc("health");
  assert.equal(missingTab.noteOk, false);
  assert.equal(missingTab.owner, "");
  assert.match(missingTab.noteError, /note.*タブ/);
  await elements.connect.click();
  assert.match(elements.notice.textContent, /同じChrome.*note.*タブ/);
  assert.equal(
    state.calls.length,
    beforeMissingTab,
    "No API call may run without an existing note tab",
  );
  state.noteAvailable = true;
  assert.equal((await rpc("health")).owner, "alice");
  await elements.connect.click();
  assert.equal(elements.account.textContent, "接続中 @alice");
  assert.equal(
    elements.watchCount.textContent,
    "1",
    "A failed account check must not erase the saved watchlist",
  );

  let releasePage;
  state.holdPage = new Promise((resolve) => {
    releasePage = resolve;
  });
  const callCount = state.calls.length;
  const pendingFeed = rpc("watch_feed", {
    creators: ["writer_a"],
    expectedAccount: "alice",
  });
  await waitFor(
    () =>
      state.calls
        .slice(callCount)
        .some((call) => call.url.includes("creators/writer_a/contents")),
    "Cancellation fixture failed to enter the real fetch",
  );
  assert.equal(
    (await rpc("cancel_job", { kind: "watch_feed" })).cancelled,
    true,
  );
  releasePage();
  assert.equal((await pendingFeed).cancelled, true);
  assert.equal(
    state.runtimeConnectCalls,
    0,
    "Jobs must stay independent of native worker Port lifetime",
  );
  assert.equal(
    state.extensionFetchCalls,
    0,
    "The extension global fetch must never bypass the note tab",
  );
  assert.ok(state.scriptCalls.length > 10);
  assert.ok(state.calls.every((call) => call.realm === "note-top-frame"));
  console.log(
    "chrome-runtime-integration-check-ok: same-origin note-tab transport, blocked extension fetch, no POST retry, missing tab and 401/403 handling, generated UI/engine startup, native namespace isolation, local Port progress and cancellation, three/deep-fifty backfill, include-liked, canonical metadata, guarded mutations and durable deduplication",
  );
} finally {
  for (const fn of state.globals.get("pagehide") || [])
    fn({ persisted: false });
  for (const timer of timers) clearTimeout(timer);
}
