import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const platformSource = fs.readFileSync("chrome/platform.js", "utf8");
const workerSource = fs.readFileSync("chrome/service-worker.js", "utf8");
const origin = "chrome-extension://test-extension/";
const readerUrl = origin + "reader/index.html";
const activeReaderKey = "nero.chrome.activeReader.v1";
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await turn();
  }
  throw new Error("Platform did not reach expected state");
}
function events() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    emit(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
  };
}
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this._text = "";
    Object.assign(this, events());
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return (
      this._text + this.children.map((child) => child.textContent).join("")
    );
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this._text = "";
    this.children = children;
  }
}
function locks() {
  const held = new Set();
  return {
    held,
    request(name, options, callback) {
      assert.equal(options.ifAvailable, true);
      if (held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      return Promise.resolve()
        .then(() => callback({ name }))
        .finally(() => held.delete(name));
    },
  };
}
function sharedState() {
  return {
    storage: {},
    tabs: new Map(),
    calls: [],
    nextTab: 100,
    locks: locks(),
  };
}
function chromeMock(state, tabId = 1) {
  const current = { id: tabId, url: readerUrl, windowId: 7 };
  state.tabs.set(tabId, current);
  const actionListeners = [];
  const nativeConnectListeners = [];
  const nativeMessageListeners = [];
  const native = {
    runtime: {
      id: "test-extension",
      getURL: (path) => origin + path,
      getManifest: () => ({ manifest_version: 3, version: "0.4.1" }),
      onConnect: { addListener: (fn) => nativeConnectListeners.push(fn) },
      onMessage: { addListener: (fn) => nativeMessageListeners.push(fn) },
    },
    action: { onClicked: { addListener: (fn) => actionListeners.push(fn) } },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: {
        get: async (key) => ({ [key]: structuredClone(state.storage[key]) }),
        set: async (values) =>
          Object.assign(state.storage, structuredClone(values)),
        remove: async (key) => {
          delete state.storage[key];
        },
      },
    },
    tabs: {
      async getCurrent() {
        return structuredClone(current);
      },
      async get(id) {
        if (!state.tabs.has(id)) throw Error("tab gone");
        return structuredClone(state.tabs.get(id));
      },
      async query(query) {
        state.calls.push({ kind: "query", query: structuredClone(query) });
        return [...state.tabs.values()]
          .filter((tab) => !query.url || tab.url === query.url)
          .map((tab) => structuredClone(tab));
      },
      async update(id, options) {
        state.calls.push({
          kind: "update",
          id,
          options: structuredClone(options),
        });
        if (!state.tabs.has(id)) throw Error("tab gone");
        Object.assign(state.tabs.get(id), options);
        return structuredClone(state.tabs.get(id));
      },
      async create(options) {
        const tab = { id: ++state.nextTab, windowId: 8, ...options };
        state.tabs.set(tab.id, tab);
        state.calls.push({ kind: "create", options: structuredClone(options) });
        return structuredClone(tab);
      },
    },
    windows: {
      update: async (id, options) => {
        state.calls.push({
          kind: "window",
          id,
          options: structuredClone(options),
        });
      },
    },
  };
  return {
    native,
    actionListeners,
    nativeConnectListeners,
    nativeMessageListeners,
  };
}
function harness({
  state = sharedState(),
  tabId = 1,
  readyState = "complete",
  load = "success",
  lockManager = state.locks,
  nativeMissing = false,
  transport = "ready",
} = {}) {
  const m = chromeMock(state, tabId);
  const document = {
    readyState,
    head: new Element("head"),
    body: new Element("body"),
    createElement: (tag) => new Element(tag),
    ...events(),
  };
  const scripts = [];
  document.head.append = (script) => {
    scripts.push(script);
    if (load !== "hold")
      queueMicrotask(() => script.emit(load === "success" ? "load" : "error"));
  };
  const pageEvents = events(),
    errors = [],
    oldBrowser = { nativeBrowser: true },
    transportRequests = [];
  let transportCreations = 0,
    nativeFetchCalls = 0;
  const transportRecord = {
    fetch(input, options) {
      assert.equal(this, transportRecord);
      transportRequests.push({ input, options });
      return Promise.resolve({ ok: true, source: "note-tab" });
    },
  };
  const transportFactory =
    transport === "missing"
      ? undefined
      : {
          create(instance) {
            transportCreations++;
            assert.equal(instance, m.native);
            if (transport === "throws")
              throw Error("transport fixture init failed");
            return transport === "invalid" ? {} : transportRecord;
          },
        };
  const nativeFetch = () => {
    nativeFetchCalls++;
    throw Error("Native fetch must remain unused");
  };
  let reloads = 0;
  const ctx = vm.createContext({
    chrome: nativeMissing ? undefined : m.native,
    browser: oldBrowser,
    NeroChromeNoteTransport: transportFactory,
    fetch: nativeFetch,
    navigator: { locks: lockManager },
    document,
    crypto: webcrypto,
    structuredClone,
    queueMicrotask,
    URL,
    console: { error: (...args) => errors.push(args) },
    addEventListener: pageEvents.addEventListener,
    location: {
      reload() {
        reloads++;
      },
    },
  });
  vm.runInContext(platformSource, ctx);
  return {
    state,
    m,
    ctx,
    platform: ctx.NeroChromePlatform,
    scripts,
    errors,
    document,
    pageEvents,
    oldBrowser,
    nativeFetch,
    nativeFetchCalls: () => nativeFetchCalls,
    transportRequests,
    transportCreations: () => transportCreations,
    reloads: () => reloads,
  };
}

// Startup is idempotent and waits for the DOM. No native Chrome listeners or
// globals are replaced; only the generated engine receives the local facade.
{
  const h = harness({ readyState: "loading" });
  assert.equal(h.scripts.length, 0);
  h.document.emit("DOMContentLoaded");
  assert.equal((await h.platform.ready).ok, true);
  assert.equal(h.platform.start(), h.platform.start());
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].src, origin + "reader/engine.js");
  assert.equal(h.ctx.browser, h.oldBrowser);
  assert.equal(h.ctx.chrome, h.m.native);
  assert.equal(h.ctx.fetch, h.nativeFetch);
  assert.equal(h.transportCreations(), 1);
  const requestOptions = { method: "GET", credentials: "include" };
  assert.equal(
    (
      await h.platform.fetch(
        "https://note.com/api/v2/current_user",
        requestOptions,
      )
    ).source,
    "note-tab",
  );
  assert.equal(h.transportRequests.length, 1);
  assert.equal(
    h.transportRequests[0].input,
    "https://note.com/api/v2/current_user",
  );
  assert.equal(h.transportRequests[0].options, requestOptions);
  assert.equal(h.nativeFetchCalls(), 0);
  assert.notEqual(h.platform.browser, h.ctx.browser);
  assert.equal(h.platform.browser.storage, h.m.native.storage);
  assert.equal(
    h.platform.browser.runtime.getURL("reader/index.html"),
    readerUrl,
  );
  assert.equal(h.m.nativeConnectListeners.length, 0);
  assert.equal(h.m.nativeMessageListeners.length, 0);
  h.platform.browser.browserAction.onClicked.addListener(() => {});
  assert.equal(h.m.actionListeners.length, 0);
  assert.equal(h.state.storage[activeReaderKey].tabId, 1);
  assert.ok(
    h.state.calls.some(
      (call) =>
        call.kind === "update" &&
        call.id === 1 &&
        call.options.autoDiscardable === false,
    ),
  );
  h.pageEvents.emit("pagehide");
  await waitFor(() => h.state.locks.held.size === 0);
  assert.equal(h.state.storage[activeReaderKey], undefined);
  h.pageEvents.emit("pageshow", { persisted: true });
  assert.equal(h.reloads(), 1);
}

// Local Ports preserve order and clone payloads. Native sender fields cannot
// be forged using connect options, and message callbacks receive their own
// receiving Port as in Chrome's API.
{
  const h = harness();
  await h.platform.ready;
  const runtime = h.platform.browser.runtime;
  let backend;
  const received = [],
    replies = [];
  runtime.onConnect.addListener((port) => {
    backend = port;
    port.postMessage({ type: "hello" });
    port.onMessage.addListener((message, receivingPort) => {
      assert.equal(receivingPort, backend);
      received.push(message);
      port.postMessage({ type: "progress", count: message.nested.count });
    });
  });
  const client = runtime.connect({
    name: "NERO_APP_V2",
    sender: { id: "foreign", url: "https://evil.example" },
  });
  client.onMessage.addListener((message, receivingPort) => {
    assert.equal(receivingPort, client);
    replies.push(message);
  });
  const input = { nested: { count: 1 } };
  client.postMessage(input);
  input.nested.count = 9;
  await turn();
  assert.equal(backend.sender.id, "test-extension");
  assert.equal(backend.sender.url, readerUrl);
  assert.equal(received[0].nested.count, 1);
  assert.deepEqual(
    replies.map((message) => message.type),
    ["hello", "progress"],
  );
  assert.equal(replies[1].count, 1);
  assert.throws(() => client.postMessage({ callback() {} }), /clone|cloned/i);
  let surviving = 0;
  backend.onMessage.addListener(() => {
    throw Error("isolated fixture listener");
  });
  backend.onMessage.addListener(() => surviving++);
  client.postMessage({ nested: { count: 2 } });
  await turn();
  assert.equal(surviving, 1);
  assert.equal(h.errors.length, 1);
  let clientClosed = 0,
    backendClosed = 0;
  client.onDisconnect.addListener((port) => {
    assert.equal(port, client);
    clientClosed++;
  });
  backend.onDisconnect.addListener((port) => {
    assert.equal(port, backend);
    backendClosed++;
  });
  const before = received.length;
  client.postMessage({ nested: { count: 3 } });
  backend.disconnect();
  client.disconnect();
  await turn();
  assert.equal(
    received.length,
    before,
    "queued messages cannot cross a disconnected channel",
  );
  assert.equal(clientClosed, 1);
  assert.equal(backendClosed, 1);
  assert.throws(() => client.postMessage({}), /closed/);
  assert.throws(() => runtime.connect("foreign-extension"), /options object/);
  runtime.onMessage.addListener(() => undefined);
  const callbackHandler = (message, from, respond) => {
    assert.equal(from.url, readerUrl);
    respond({ count: message.count });
  };
  runtime.onMessage.addListener(callbackHandler);
  assert.equal((await runtime.sendMessage({ count: 8 })).count, 8);
  runtime.onMessage.removeListener(callbackHandler);
  runtime.onMessage.addListener(async () => ({ ok: true }));
  assert.equal((await runtime.sendMessage({})).ok, true);
  h.pageEvents.emit("pagehide");
  assert.throws(() => runtime.connect({}), /closed/);
}

// Web Locks, not optional focus metadata, enforce one active reader context.
// Duplicate pages show a route back instead of starting another sender.
{
  const state = sharedState();
  const first = harness({ state, tabId: 1 });
  assert.equal((await first.platform.ready).ok, true);
  const duplicate = harness({ state, tabId: 2 });
  assert.equal((await duplicate.platform.ready).code, "reader_already_open");
  assert.equal(duplicate.scripts.length, 0);
  assert.match(duplicate.document.body.textContent, /別のタブ/);
  const button = duplicate.document.body.children[0].children.find(
    (element) => element.tagName === "BUTTON",
  );
  await button.onclick();
  assert.ok(
    state.calls.some(
      (call) => call.kind === "update" && call.id === 1 && call.options.active,
    ),
  );
  assert.ok(
    state.calls.some(
      (call) => call.kind === "window" && call.id === 7 && call.options.focused,
    ),
  );
  assert.equal(state.calls.filter((call) => call.kind === "create").length, 0);
  first.pageEvents.emit("pagehide");
  await waitFor(() => state.locks.held.size === 0);
  const replacement = harness({ state, tabId: 3 });
  assert.equal((await replacement.platform.ready).ok, true);
  assert.equal(state.storage[activeReaderKey].tabId, 3);
  replacement.pageEvents.emit("pagehide");
}

// Startup failures fail closed, while tab closure resolves readiness even
// during loading or before DOMContentLoaded.
for (const transport of ["missing", "throws", "invalid"]) {
  const h = harness({ transport });
  assert.equal((await h.platform.ready).code, "transport_unavailable");
  assert.equal(h.platform.fetch, null);
  assert.equal(h.scripts.length, 0);
  assert.equal(h.state.locks.held.size, 0);
  assert.equal(h.nativeFetchCalls(), 0);
  assert.match(h.document.body.textContent, /拡張機能を読み込み直して/);
  assert.throws(() => h.platform.browser.runtime.connect({}), /closed/);
}
for (const missing of ["browser", "locks"]) {
  const h = harness({
    nativeMissing: missing === "browser",
    lockManager: missing === "locks" ? null : locks(),
  });
  assert.equal((await h.platform.ready).code, "unsupported_browser");
  assert.equal(h.scripts.length, 0);
  assert.match(h.document.body.textContent, /最新版/);
}
{
  const h = harness({ load: "error" });
  assert.equal((await h.platform.ready).code, "reader_start_failed");
  await waitFor(() => h.state.locks.held.size === 0);
  assert.equal(h.state.storage[activeReaderKey], undefined);
  assert.throws(() => h.platform.browser.runtime.connect({}), /closed/);
}
{
  const h = harness({ load: "hold" });
  await waitFor(() => h.scripts.length === 1);
  h.pageEvents.emit("error", { filename: origin + "reader/engine.js" });
  assert.equal((await h.platform.ready).code, "reader_start_failed");
  await waitFor(() => h.state.locks.held.size === 0);
}
{
  const h = harness({ load: "hold" });
  await waitFor(() => h.scripts.length === 1);
  h.pageEvents.emit("pagehide");
  assert.equal((await h.platform.ready).code, "reader_closed");
  await waitFor(() => h.state.locks.held.size === 0);
}
{
  const h = harness({ readyState: "loading" });
  h.pageEvents.emit("pagehide");
  h.document.emit("DOMContentLoaded");
  assert.equal((await h.platform.ready).code, "reader_closed");
  assert.equal(h.scripts.length, 0);
}
{
  const h = harness({
    lockManager: {
      request() {
        throw Error("unavailable");
      },
    },
  });
  assert.equal((await h.platform.ready).code, "reader_start_failed");
  assert.equal(h.scripts.length, 0);
}

function worker(state = sharedState()) {
  const m = chromeMock(state, 999);
  state.tabs.delete(999);
  vm.runInNewContext(workerSource, { chrome: m.native });
  assert.equal(
    m.actionListeners.length,
    1,
    "toolbar listener registers synchronously",
  );
  return { state, ...m, click: () => m.actionListeners[0]() };
}
// One open operation handles repeated clicks. Existing readers are focused,
// and a suspended/restarted worker can discover the reader without in-memory
// state or the optional session hint.
{
  const w = worker();
  w.click();
  w.click();
  await waitFor(() => w.state.calls.some((call) => call.kind === "window"));
  assert.equal(
    w.state.calls.filter((call) => call.kind === "create").length,
    1,
  );
  const tab = [...w.state.tabs.values()][0];
  assert.equal(tab.url, readerUrl);
  assert.equal(tab.autoDiscardable, false);
  const restarted = worker(w.state);
  restarted.click();
  await waitFor(
    () => w.state.calls.filter((call) => call.kind === "window").length === 2,
  );
  assert.equal(
    w.state.calls.filter((call) => call.kind === "create").length,
    1,
  );
  assert.ok(
    w.state.calls.some(
      (call) =>
        call.kind === "update" && call.id === tab.id && call.options.active,
    ),
  );
}
{
  const state = sharedState();
  state.tabs.set(5, { id: 5, url: readerUrl, windowId: 2 });
  state.tabs.set(6, { id: 6, url: readerUrl, windowId: 3 });
  state.storage[activeReaderKey] = { tabId: 6 };
  const w = worker(state);
  w.click();
  await waitFor(() => state.calls.some((call) => call.kind === "window"));
  assert.ok(
    state.calls.some(
      (call) => call.kind === "update" && call.id === 6 && call.options.active,
    ),
  );
  assert.equal(state.calls.filter((call) => call.kind === "create").length, 0);
  // Stale or unrelated metadata cannot focus an arbitrary external tab.
  state.tabs.set(6, { id: 6, url: "https://external.example/", windowId: 3 });
  state.calls = [];
  const restart = worker(state);
  restart.click();
  await waitFor(() => state.calls.some((call) => call.kind === "window"));
  assert.ok(
    state.calls.some(
      (call) => call.kind === "update" && call.id === 5 && call.options.active,
    ),
  );
  assert.equal(state.calls.filter((call) => call.kind === "create").length, 0);
}

console.log(
  "chrome-platform-check-ok: local Port ordering/cloning/sender isolation, exclusive reader lifetime, close/error handling, native globals, toolbar reuse and worker restarts",
);
