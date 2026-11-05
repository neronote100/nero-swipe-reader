// Exercise the serialized ISOLATED function in a separate note realm. No real
// network requests, browser sessions, or Cookie values are used in this test.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = fs.readFileSync("chrome/note-transport.js", "utf8");
const account = "https://note.com/api/v2/current_user";
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await turn();
  }
  throw Error("Fixture did not reach expected state");
}
function harness() {
  const h = {
    tabs: [
      { id: 10, url: "https://note.com/", active: false, lastAccessed: 100 },
      {
        id: 20,
        url: "https://note.com/reader",
        active: true,
        lastAccessed: 50,
      },
    ],
    calls: [],
    executions: [],
    queries: 0,
    aborted: 0,
    now: Date.now(),
    clientTimers: [],
  };
  class ClockDate extends Date {
    static now() {
      return h.now;
    }
  }
  const note = vm.createContext({
    URL,
    Date: ClockDate,
    Map,
    Set,
    TextEncoder,
    TextDecoder,
    AbortController,
    Response,
    Headers,
    setTimeout,
    clearTimeout,
    location: { origin: "https://note.com" },
    fetch: async (url, options) => {
      h.calls.push({ url, options });
      assert.equal(note.location.origin, "https://note.com");
      assert.equal(new URL(url).origin, "https://note.com");
      assert.equal(options.credentials, "include");
      assert.equal(options.cache, "no-store");
      assert.equal(options.redirect, "error");
      if (h.fetchImpl) return h.fetchImpl(url, options);
      return new Response(
        JSON.stringify({ data: { key: "alice", urlname: "alice" } }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "not-exposed",
          },
        },
      );
    },
  });
  const native = {
    tabs: {
      query: async (query) => {
        assert.equal(query.url, "https://note.com/*");
        h.queries++;
        if (h.queryImpl) return h.queryImpl();
        return structuredClone(h.tabs);
      },
      get: async (id) => {
        const tab = h.tabs.find((t) => t.id === id);
        if (!tab) throw Error("closed");
        return structuredClone(tab);
      },
      create: () => assert.fail("Transport must not open note tabs"),
      update: () => assert.fail("Transport must not change note tabs"),
      remove: () => assert.fail("Transport must not close note tabs"),
    },
    scripting: {
      executeScript: async (args) => {
        assert.equal(args.world, "ISOLATED");
        assert.deepEqual(Array.from(args.target.frameIds), [0]);
        h.executions.push({ target: args.target, name: args.func.name });
        if (h.executeImpl) return h.executeImpl(args);
        note.input = structuredClone(args.args[0]);
        if (args.func.name === "pageRequest") h.lastPageFunction = args.func;
        const result = await vm.runInContext(
          "(" + args.func.toString() + ")(input)",
          note,
        );
        return [{ frameId: 0, result }];
      },
    },
  };
  const client = vm.createContext({
    Date: ClockDate,
    URL,
    Headers,
    Response,
    TextEncoder,
    crypto: webcrypto,
    Map,
    Set,
    setTimeout(fn, milliseconds) {
      h.clientTimers.push({ fn, milliseconds });
      return setTimeout(fn, milliseconds);
    },
    clearTimeout,
    console,
    fetch: () => assert.fail("Extension-origin requests must never be used"),
  });
  vm.runInContext(source, client);
  h.api = client.NeroChromeNoteTransport.create(native);
  h.note = note;
  h.native = native;
  h.page = (input) => {
    note.input = structuredClone(input);
    return vm.runInContext(
      "(" + h.lastPageFunction.toString() + ")(input)",
      note,
    );
  };
  return h;
}

{
  const h = harness();
  const response = await h.api.fetch(account, {
    headers: { Accept: "application/json" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: { key: "alice", urlname: "alice" },
  });
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(h.calls[0].url, account);
  assert.equal(
    h.executions[0].target.tabId,
    20,
    "prefer an already active note tab",
  );
  assert.equal(h.api.diagnostic.code, "note_connected");
  h.tabs[0].active = true;
  h.tabs[1].active = false;
  await h.api.fetch("https://note.com/api/v3/notes/nfixture");
  assert.equal(h.queries, 1);
  assert.equal(
    h.executions[1].target.tabId,
    20,
    "all requests keep the same note context",
  );
}
{
  const h = harness(),
    pending = deferred();
  h.queryImpl = () => pending.promise;
  const a = h.api.fetch(account),
    b = h.api.fetch(account);
  pending.resolve(h.tabs);
  await Promise.all([a, b]);
  assert.equal(
    h.queries,
    1,
    "concurrent initial requests must share the selected note tab",
  );
}
for (const denied of [false, "error"]) {
  const h = harness();
  h.native.permissions = {
    contains: async (query) => {
      assert.deepEqual(Array.from(query.permissions), ["scripting"]);
      assert.deepEqual(Array.from(query.origins), ["https://note.com/*"]);
      if (denied === "error") throw Error("permissions unavailable");
      return false;
    },
  };
  await assert.rejects(h.api.fetch(account), { code: "note_site_access" });
  assert.equal(
    h.queries,
    0,
    "denied permissions must not be misreported as a missing note tab",
  );
  assert.equal(h.executions.length, 0);
}
{
  const h = harness();
  h.native.permissions = { contains: async () => true };
  assert.equal((await h.api.fetch(account)).status, 200);
}
for (const url of [
  "https://evil.example/api/v2/current_user",
  "http://note.com/api/v2/current_user",
  "https://note.com:123/api/v2/current_user",
  "https://user:secret@note.com/api/v2/current_user",
  "https://note.com/api/v2/current_user#fragment",
  "https://note.com/api/v2/users/private",
  "https://note.com/api/v3/notes/nkey%2fprivate",
  "https://note.com.evil.example/api/v2/current_user",
]) {
  const h = harness();
  await assert.rejects(h.api.fetch(url), { code: "note_request_blocked" });
  assert.equal(h.executions.length, 0);
}
for (const options of [
  { method: "DELETE" },
  { method: "PUT" },
  { body: "a" },
  { headers: { Cookie: "do-not-copy" } },
  { headers: { Authorization: "not-a-token" } },
  { headers: { Origin: "https://note.com" } },
  { headers: { "X-Other": "arbitrary" } },
  { method: "POST", headers: { "content-type": "text/html" } },
]) {
  const h = harness();
  await assert.rejects(h.api.fetch(account, options), {
    code: "note_request_blocked",
  });
  assert.equal(h.calls.length, 0);
}
{
  const h = harness();
  await h.api.fetch(account);
  const before = h.calls.length;
  const valid = {
    id: "fixture_1",
    expiresAt: h.now + 12000,
    path: "/api/v2/current_user",
    method: "GET",
    headers: {},
  };
  for (const input of [
    { ...valid, path: "https://evil.example/api/v2/current_user" },
    { ...valid, path: "/api/v3/notes/nfixture/likes", method: "DELETE" },
    { ...valid, headers: { cookie: "forbidden" } },
    { ...valid, headers: { accept: "x\r\nforbidden" } },
  ])
    assert.equal((await h.page(input)).code, "note_request_blocked");
  h.note.location.origin = "https://evil.example";
  assert.equal((await h.page(valid)).code, "note_tab_changed");
  assert.equal(
    h.calls.length,
    before,
    "the page must validate independently of the client",
  );
}
for (const path of [
  "/api/v3/notes/nfixture/likes",
  "/api/v3/notes/nfixture/note_comments",
  "/api/v3/notes/nfixture/note_comments/child-comment/likes",
]) {
  const h = harness();
  h.fetchImpl = async () => new Response(null, { status: 204 });
  const response = await h.api.fetch("https://note.com" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-LS-Disabled": "true",
    },
    body: JSON.stringify({ comment: "synthetic" }),
  });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.method, "POST");
  assert.equal(h.calls[0].url, "https://note.com" + path);
}
{
  const h = harness();
  h.fetchImpl = async () =>
    new Response("blocked page", {
      status: 403,
      headers: {
        "content-type": "text/html",
        "retry-after": "30",
        "set-cookie": "not-returned",
      },
    });
  const response = await h.api.fetch(account);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(h.api.diagnostic.code, "note_http_403");
  assert.equal(h.api.diagnostic.status, 403);
  assert.ok(!JSON.stringify(h.api.diagnostic).includes("blocked page"));
}
{
  const h = harness();
  h.tabs = [];
  await assert.rejects(h.api.fetch(account), { code: "note_tab_required" });
  assert.equal(h.executions.length, 0);
  assert.equal(h.api.diagnostic.code, "note_tab_required");
}
{
  const h = harness();
  h.queryImpl = async () => {
    throw Error("permissions");
  };
  await assert.rejects(h.api.fetch(account), { code: "note_site_access" });
}
{
  const h = harness();
  await h.api.fetch(account);
  h.tabs = [{ id: 30, active: true, url: "https://note.com/new" }];
  const before = h.calls.length;
  await assert.rejects(
    h.api.fetch("https://note.com/api/v3/notes/nfixture/likes", {
      method: "POST",
    }),
    { code: "note_tab_changed" },
  );
  assert.equal(
    h.calls.length,
    before,
    "a missing pinned tab must not silently retry a mutation elsewhere",
  );
  await h.api.fetch(account);
  assert.equal(
    h.executions.at(-1).target.tabId,
    30,
    "the next explicit request may reconnect",
  );
}
{
  const h = harness();
  h.executeImpl = async () => {
    throw Error("lost reply after dispatch");
  };
  await assert.rejects(
    h.api.fetch("https://note.com/api/v3/notes/nfixture/likes", {
      method: "POST",
    }),
    { code: "note_page_unavailable" },
  );
  assert.equal(h.executions.length, 1, "ambiguous POST must never be retried");
}
{
  const h = harness(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(h.api.fetch(account, { signal: controller.signal }), {
    name: "AbortError",
  });
  assert.equal(h.queries, 0);
  assert.equal(h.executions.length, 0);
}
{
  const h = harness(),
    pending = deferred(),
    controller = new AbortController();
  h.queryImpl = () => pending.promise;
  const request = h.api.fetch("https://note.com/api/v3/notes/nfixture/likes", {
    method: "POST",
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  pending.resolve(h.tabs);
  await turn();
  assert.equal(
    h.executions.length,
    0,
    "abort while choosing a tab must prevent a later POST",
  );
}
{
  const h = harness(),
    controller = new AbortController();
  h.fetchImpl = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => {
          h.aborted++;
          reject(Object.assign(Error("aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
    });
  const request = h.api.fetch(account, { signal: controller.signal });
  await waitFor(() => h.calls.length === 1);
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  await waitFor(() => h.aborted === 1);
  assert.equal(h.note.__neroNoteRequestsV1.size, 0);
  assert.equal(h.executions.filter((e) => e.name === "pageRequest").length, 1);
  assert.equal(h.executions.filter((e) => e.name === "pageAbort").length, 1);
}
{
  const h = harness(),
    controller = new AbortController(),
    injection = deferred();
  let saved;
  h.executeImpl = async (args) => {
    if (args.func.name === "pageRequest") {
      saved = args;
      await injection.promise;
    }
    h.note.input = structuredClone(args.args[0]);
    return [
      {
        frameId: 0,
        result: await vm.runInContext(
          "(" + args.func.toString() + ")(input)",
          h.note,
        ),
      },
    ];
  };
  const request = h.api.fetch("https://note.com/api/v3/notes/nfixture/likes", {
    method: "POST",
    signal: controller.signal,
  });
  await waitFor(() => saved);
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  injection.resolve();
  await turn();
  assert.equal(
    h.calls.length,
    0,
    "cancel arriving before the request injection must prevent dispatch",
  );
}
// A queued injection can outlive the cancellation tombstone or lose its
// cancellation injection entirely. A client-minted deadline must still keep
// it from beginning an HTTP request later.
for (const lostCancel of [false, true]) {
  const h = harness(),
    injection = deferred(),
    controller = new AbortController();
  let queued;
  h.executeImpl = async (args) => {
    if (args.func.name === "pageRequest") {
      queued = args;
      await injection.promise;
    } else if (lostCancel) throw Error("cancellation injection lost");
    h.note.input = structuredClone(args.args[0]);
    return [
      {
        frameId: 0,
        result: await vm.runInContext(
          "(" + args.func.toString() + ")(input)",
          h.note,
        ),
      },
    ];
  };
  const request = h.api.fetch("https://note.com/api/v3/notes/nfixture/likes", {
    method: "POST",
    signal: controller.signal,
  });
  await waitFor(() => queued);
  assert.equal(queued.args[0].expiresAt, h.now + 12000);
  if (lostCancel) {
    assert.equal(h.clientTimers.at(-1).milliseconds, 12000);
    h.clientTimers.at(-1).fn(); // Simulate the reader's own deadline firing.
  } else controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  await turn();
  h.now += 31000;
  if (!lostCancel) {
    const until = h.note.__neroNoteCancelledV1.get(queued.args[0].id);
    assert.ok(
      until < h.now,
      "the old cancellation tombstone must have expired",
    );
    h.note.__neroNoteCancelledV1.clear(); // Simulate cleanup before the queued injection.
  }
  injection.resolve();
  await turn();
  assert.equal(
    h.calls.length,
    0,
    "an expired queued POST must not start even without a cancellation record",
  );
}
{
  const h = harness();
  await h.api.fetch(account);
  const before = h.calls.length;
  const request = {
    id: "expires_fixture",
    path: "/api/v3/notes/nfixture/likes",
    method: "POST",
    headers: {},
    expiresAt: h.now + 12000,
  };
  for (const expiresAt of [undefined, Infinity, NaN, h.now + 60000])
    assert.equal(
      (await h.page({ ...request, expiresAt })).code,
      "note_request_blocked",
    );
  assert.equal(
    (await h.page({ ...request, expiresAt: h.now - 1 })).code,
    "note_request_aborted",
  );
  h.note.TextEncoder = class extends TextEncoder {
    encode(value) {
      const bytes = super.encode(value);
      h.now += 13000;
      return bytes;
    }
  };
  assert.equal(
    (await h.page({ ...request, body: "{}" })).code,
    "note_request_aborted",
    "expiry must be rechecked immediately before HTTP dispatch",
  );
  assert.equal(h.calls.length, before);
}
for (const incognito of [false, true]) {
  const h = harness();
  h.native.tabs.getCurrent = async () => ({ id: 1, incognito });
  h.tabs[0].incognito = false;
  h.tabs[1].incognito = true;
  await h.api.fetch(account);
  assert.equal(
    h.executions[0].target.tabId,
    incognito ? 20 : 10,
    "normal readers must not select a private note session, or vice versa",
  );
}
{
  const h = harness();
  h.fetchImpl = async () => ({
    status: 200,
    headers: new Headers(),
    text: async () => "x".repeat(8 * 1024 * 1024 + 1),
  });
  await assert.rejects(h.api.fetch(account), {
    code: "note_response_too_large",
  });
}
console.log(
  "chrome-note-transport-check-ok: same-origin isolated fetch, pinned tabs, API/header guards, HTTP diagnostics, no credential export, bounded responses, real abort, absolute request expiry, normal/private session matching and no mutation retries",
);
