import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("chrome/account.js", "utf8");

function fixture({
  payload = { data: { user: { urlname: "alice" } } },
  status = 200,
  contentType = "application/json; charset=utf-8",
  json,
  fetchImpl,
  response,
} = {}) {
  const calls = [],
    timers = new Map(),
    cleared = [],
    logs = [];
  let timerId = 0,
    nativeCalls = 0,
    jsonCalls = 0,
    legacyCalls = 0;
  const nativeFetch = () => {
    nativeCalls++;
    throw Error("The native extension-page fetch must not be used");
  };
  const nativeBrowser = { native: "browser" },
    nativeChrome = { native: "chrome" };
  const A = {
    currentAccount() {
      legacyCalls++;
      throw Error("The legacy account method must be replaced");
    },
  };
  const context = vm.createContext({
    NeroAppApiCore: A,
    AbortController,
    fetch: nativeFetch,
    browser: nativeBrowser,
    chrome: nativeChrome,
    console: {
      log: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
    },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      timers.delete(id);
    },
    async __accountFetch(url, options) {
      calls.push({ url, options });
      if (fetchImpl) return fetchImpl(url, options);
      if (response !== undefined) return response;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => contentType },
        async json() {
          jsonCalls++;
          if (json) return json();
          return structuredClone(
            typeof payload === "function" ? payload() : payload,
          );
        },
      };
    },
  });
  vm.runInContext(
    `(function(fetch) {\n${source}\n})(__accountFetch);`,
    context,
  );
  return {
    api: A.currentAccount,
    calls,
    timers,
    cleared,
    logs,
    context,
    nativeFetch,
    nativeBrowser,
    nativeChrome,
    get nativeCalls() {
      return nativeCalls;
    },
    get legacyCalls() {
      return legacyCalls;
    },
    get jsonCalls() {
      return jsonCalls;
    },
  };
}

function assertClosed(result) {
  assert.equal(result.ok, false);
  assert.equal(result.owner, "");
  assert.equal(result.raw.ok, false);
  assert.equal(typeof result.raw.code, "string");
  assert.equal(typeof result.raw.message, "string");
  assert.ok(result.raw.message.includes("再確認"));
}

// Only the lexical transport performs the request; all native globals remain
// untouched, and only needed account fields leave the current_user response.
{
  const f = fixture({
    payload: {
      data: {
        user: {
          urlname: "Alice_123",
          nickname: "アリス",
          key: "alice-key",
          following_count: "17",
          email: "secret@example.invalid",
          cookies: "sensitive-cookie-value",
        },
      },
    },
  });
  const result = await f.api();
  assert.deepEqual(structuredClone(result), {
    ok: true,
    owner: "alice_123",
    raw: {
      ok: true,
      action: "account",
      urlname: "alice_123",
      nickname: "アリス",
      key: "alice-key",
      followingCount: 17,
    },
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://note.com/api/v2/current_user");
  assert.equal(f.calls[0].options.method, "GET");
  assert.equal(f.calls[0].options.credentials, "include");
  assert.equal(f.calls[0].options.cache, "no-store");
  assert.equal(f.calls[0].options.headers.Accept, "application/json");
  assert.equal(f.calls[0].options.signal.aborted, false);
  assert.equal(f.nativeCalls, 0);
  assert.equal(f.legacyCalls, 0);
  assert.equal(f.context.fetch, f.nativeFetch);
  assert.equal(f.context.browser, f.nativeBrowser);
  assert.equal(f.context.chrome, f.nativeChrome);
  assert.deepEqual(f.cleared, [1]);
  assert.equal(f.timers.size, 0);
  assert.equal(f.logs.length, 0);
}

// Known API wrappers work without borrowing identity or metadata across them.
for (const payload of [
  { data: { user: { urlname: "alice", nickname: "Alice" } } },
  { data: { urlname: "alice", nickname: "Alice" } },
  { user: { urlname: "alice", nickname: "Alice" } },
  { urlname: "alice", nickname: "Alice" },
]) {
  const f = fixture({ payload });
  const r = await f.api();
  assert.equal(r.ok, true);
  assert.equal(r.owner, "alice");
  assert.equal(r.raw.nickname, "Alice");
}
{
  const f = fixture({
    payload: {
      data: {
        user: { urlname: "bob" },
        urlname: "alice",
        nickname: "outer metadata",
        key: "outer-key",
      },
      user: { urlname: "carol", nickname: "another user" },
    },
  });
  const r = await f.api();
  assert.equal(r.owner, "bob");
  assert.equal(r.raw.nickname, "bob");
  assert.equal(r.raw.key, "");
}

for (const payload of [
  null,
  [],
  "alice",
  1,
  {},
  { data: null, urlname: "outer_account" },
  { data: [], user: { urlname: "outer_account" } },
  { data: { user: null, urlname: "outer_account" } },
  { data: { user: {}, urlname: "outer_account" } },
  { data: { user: [], urlname: "outer_account" } },
  { data: { user: { nickname: "Alice" } }, urlname: "outer_account" },
  { user: null, urlname: "outer_account" },
]) {
  const f = fixture({ payload });
  const r = await f.api({ owner: "manually_entered_id" });
  assertClosed(r);
  assert.equal(r.raw.code, "account_invalid_response");
  assert.equal(r.raw.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
}

for (const urlname of [
  undefined,
  null,
  {},
  [],
  123,
  true,
  "",
  " alice",
  "alice ",
  "alice\n",
  "alice\r\n",
  "alice/bob",
  "alice@example.com",
  "https://note.com/alice",
  "https://alice:secret@note.com/",
  "javascript:alice",
  "日本語",
  "a".repeat(81),
]) {
  const f = fixture({ payload: { data: { urlname } } });
  const r = await f.api();
  assertClosed(r);
  assert.equal(r.raw.code, "account_invalid_response");
}

// Each check reads the live session again; a failed third check cannot reuse
// either earlier account or an identifier passed manually by a caller.
{
  let current = "Alice";
  const f = fixture({ payload: () => ({ data: { urlname: current } }) });
  assert.equal((await f.api()).owner, "alice");
  current = "BOB";
  assert.equal((await f.api()).owner, "bob");
  current = null;
  const last = await f.api({ owner: "alice" });
  assertClosed(last);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.cleared, [1, 2, 3]);
}

for (const [status, code, message] of [
  [401, "login_required", "ログイン"],
  [403, "account_forbidden", "拒否"],
  [429, "account_rate_limited", "待って"],
  [500, "account_server_error", "note側"],
  [503, "account_server_error", "note側"],
  [404, "account_http_error", "接続"],
]) {
  const f = fixture({ status });
  const r = await f.api();
  assertClosed(r);
  assert.equal(r.raw.code, code);
  assert.equal(r.raw.status, status);
  assert.ok(r.raw.message.includes(message));
  assert.ok(r.raw.message.includes("HTTP " + status));
  if (status === 403)
    assert.ok(!r.raw.message.includes("ログインしてください"));
  assert.equal(f.jsonCalls, 0, "HTTP errors must not read response bodies");
  assert.equal(f.timers.size, 0);
}

// Non-JSON replies and malformed JSON are distinguished from logged-out state;
// their body contents never enter diagnostics or console output.
for (const options of [
  { contentType: "text/html", payload: { urlname: "spoofed" } },
  { contentType: "text/plain", payload: { urlname: "spoofed" } },
  {
    json: () => {
      throw Error("secret response body");
    },
  },
  { response: null },
  { response: { status: 200 } },
]) {
  const f = fixture(options);
  const r = await f.api();
  assertClosed(r);
  assert.equal(r.raw.code, "account_invalid_response");
  assert.ok(!JSON.stringify(r).includes("secret response body"));
  assert.equal(f.logs.length, 0);
  assert.equal(f.timers.size, 0);
}
for (const contentType of [
  "application/json",
  "APPLICATION/JSON; charset=utf-8",
  "application/problem+json",
  "application/vnd.api+json; charset=utf-8",
  null,
]) {
  const f = fixture({ contentType });
  assert.equal((await f.api()).owner, "alice");
}

for (const [code, expectedCode, message] of [
  ["note_tab_required", "note_tab_required", "同じChromeでnoteのタブ"],
  ["note_site_access", "note_site_access", "サイトへのアクセス"],
  ["note_transport_unavailable", "note_transport_unavailable", "再読み込み"],
  ["note_page_unavailable", "note_page_unavailable", "サイトへのアクセス"],
  ["note_request_blocked", "note_request_blocked", "再読み込み"],
  ["note_tab_changed", "note_tab_changed", "開き直して"],
  ["note_page_fetch_failed", "account_network_error", "通信に失敗"],
  ["note_request_aborted", "account_timeout", "タイムアウト"],
  ["note_response_too_large", "note_response_too_large", "応答"],
  ["note_invalid_response", "note_invalid_response", "応答"],
  ["unknown_transport_error", "account_network_error", "通信に失敗"],
  [undefined, "account_network_error", "通信に失敗"],
]) {
  const f = fixture({
    fetchImpl: () => {
      throw Object.assign(
        Error("secret-response cookie=email@example.invalid"),
        {
          code,
        },
      );
    },
  });
  const r = await f.api();
  assertClosed(r);
  assert.equal(r.raw.code, expectedCode);
  assert.ok(r.raw.message.includes(message));
  assert.ok(!JSON.stringify(r).includes("secret-response"));
  assert.ok(!JSON.stringify(r).includes("email@example.invalid"));
  assert.equal(f.logs.length, 0);
  assert.equal(f.timers.size, 0);
}

// The real AbortController handles a scheduled twelve-second timeout; cleanup
// also runs when the response body is the phase that becomes unavailable.
for (const inBody of [false, true]) {
  let signal;
  let entered;
  const ready = new Promise((resolve) => (entered = resolve));
  const waitForAbort = () =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
      entered();
    });
  const f = fixture({
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return inBody
        ? {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            json: waitForAbort,
          }
        : waitForAbort();
    },
  });
  const pending = f.api();
  assert.equal(f.timers.get(1).delay, 12000);
  await ready;
  f.timers.get(1).callback();
  const r = await pending;
  assertClosed(r);
  assert.equal(r.raw.code, "account_timeout");
  assert.equal(signal.aborted, true);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.cleared, [1]);
}

console.log(
  "chrome-account-check-ok: lexical fresh session, strict identities, HTTP/transport diagnostics, invalid JSON, no secret diagnostics, timeout cleanup",
);
