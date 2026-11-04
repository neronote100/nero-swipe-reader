import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("members/member-article.js", "utf8");
function fixture({ payload = {}, status = 200, fetchImpl, jsonImpl } = {}) {
  const calls = [],
    timers = new Map(),
    cleared = [];
  let timerId = 0;
  const A = {
    fetchArticle: () => {
      throw Error("legacy fetch used");
    },
  };
  const context = vm.createContext({
    NeroAppApiCore: A,
    AbortController,
    URL,
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      timers.delete(id);
    },
    async fetch(url, options) {
      calls.push({ url, options });
      if (fetchImpl) return fetchImpl(url, options);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: jsonImpl || (async () => payload),
      };
    },
  });
  vm.runInContext(source, context);
  return { api: A.fetchArticle, calls, timers, cleared };
}

// A canonical link and complete card metadata are obtained from the same
// credentialed note article request used to read the body.
{
  const f = fixture({
    payload: {
      data: {
        note: {
          key: "nArticle",
          name: "記事タイトル",
          body: "<p>本文</p>",
          description: "カードの概要",
          noteUrl: "https://note.com/Alice/n/nArticle?from=embed#section",
          user: {
            urlname: "alice",
            nickname: "アリス",
            userProfileImagePath: "https://assets.st-note.com/author.png",
          },
          publishAt: "2026-11-04T09:00:00+09:00",
          eyecatch: "https://assets.st-note.com/cover.jpg",
          likeCount: 25,
        },
      },
    },
  });
  const result = await f.api({ key: " nArticle " });
  assert.deepEqual(structuredClone(result), {
    ok: true,
    key: "nArticle",
    title: "記事タイトル",
    body: "<p>本文</p>",
    description: "カードの概要",
    imageUrl: "https://assets.st-note.com/cover.jpg",
    likeCount: 25,
    url: "https://note.com/alice/n/nArticle",
    urlname: "alice",
    nickname: "アリス",
    publishAt: "2026-11-04T09:00:00+09:00",
    userIcon: "https://assets.st-note.com/author.png",
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://note.com/api/v3/notes/nArticle");
  assert.equal(f.calls[0].options.credentials, "include");
  assert.equal(f.calls[0].options.cache, "no-store");
  assert.equal(f.calls[0].options.headers.Accept, "application/json");
  assert.equal(f.calls[0].options.signal.aborted, false);
  assert.deepEqual(f.cleared, [1]);
  assert.equal(f.timers.size, 0);
}

// Invalid keys cannot select a host/path, start a timeout, or make a request.
for (const key of [
  undefined,
  null,
  12,
  {},
  "",
  "article",
  "n",
  "nvalid/../../secret",
  "https://evil.example/nvalid",
  "nvalid?url=evil",
]) {
  const f = fixture();
  assert.equal((await f.api({ key })).code, "invalid_article_key");
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 0);
}
for (const args of [null, undefined, 7, "nExample"]) {
  const f = fixture();
  assert.equal((await f.api(args)).code, "invalid_article_key");
  assert.equal(f.calls.length, 0);
}

// A key-only embed gains a safe article URL when the API identifies its author.
{
  const f = fixture({
    payload: {
      key: "nExample",
      title: "タイトル別名",
      body_text: "本文別名",
      user: { urlname: " CREATOR_name " },
      published_at: "2026-11-04",
      like_count: "8",
    },
  });
  const r = await f.api({ key: "nExample" });
  assert.equal(r.url, "https://note.com/creator_name/n/nExample");
  assert.equal(r.urlname, "creator_name");
  assert.equal(r.nickname, "creator_name");
  assert.equal(r.publishAt, "2026-11-04");
  assert.equal(r.title, "タイトル別名");
  assert.equal(r.body, "本文別名");
  assert.equal(r.likeCount, 8);
}

// A valid canonical URL can identify the author even without a user object.
{
  const f = fixture({
    payload: {
      note: {
        key: "nExample",
        note_url: "https://note.com/Bob/n/nExample/",
        body: "本文",
      },
    },
  });
  const r = await f.api({ key: "nExample" });
  assert.equal(r.url, "https://note.com/bob/n/nExample");
  assert.equal(r.urlname, "bob");
}

for (const url of [
  "javascript:alert(1)",
  "https://note.com.evil.example/alice/n/nExample",
  "https://evil.example/alice/n/nExample",
  "http://note.com/alice/n/nExample",
  "https://user:pass@note.com/alice/n/nExample",
  "https://note.com:444/alice/n/nExample",
  "https://note.com/alice/n/nWrong",
  "https://note.com/alice/n/nExample/extra",
  "https://note.com/%61lice/n/nExample",
  "/alice/n/nExample",
]) {
  const f = fixture({ payload: { key: "nExample", url, body: "本文" } });
  const r = await f.api({ key: "nExample" });
  assert.equal(r.ok, true);
  assert.equal(r.url, "", `reject canonical: ${url}`);
  assert.equal(r.urlname, "");
}

// Hostile/contradictory URL metadata is discarded, while a validated author
// can still establish the URL without following any redirect or external URL.
{
  const f = fixture({
    payload: {
      key: "nExample",
      user: { urlname: "alice" },
      url: "https://note.com/bob/n/nExample",
      noteUrl: "https://evil.example/alice/n/nExample",
      body: "本文",
    },
  });
  const r = await f.api({ key: "nExample" });
  assert.equal(r.url, "https://note.com/alice/n/nExample");
  assert.equal(f.calls.length, 1);
}

// Missing metadata does not invent a canonical target or paid article body.
{
  const f = fixture({
    payload: {
      data: {
        title: "購入が必要な記事",
        body: "",
        description: "公開範囲の説明",
        user: { urlname: "invalid/user", nickname: { html: "bad" } },
        eyecatch: "javascript:alert(1)",
        likeCount: "not-a-number",
      },
    },
  });
  const r = await f.api({ key: "nExample" });
  assert.equal(r.ok, true);
  assert.equal(r.body, "");
  assert.equal(r.description, "公開範囲の説明");
  assert.equal(r.url, "");
  assert.equal(r.nickname, "");
  assert.equal(r.imageUrl, "");
  assert.equal(r.likeCount, 0);
}

// Image URLs never retain executable/data/insecure/credential-bearing schemes.
for (const image of [
  "javascript:alert(1)",
  "data:image/svg+xml,<svg/>",
  "http://assets.st-note.com/cover.jpg",
  "https://user:pass@assets.st-note.com/cover.jpg",
  "/relative.jpg",
]) {
  const f = fixture({
    payload: {
      key: "nExample",
      eyecatch: image,
      user: { profileImageUrl: image },
    },
  });
  const r = await f.api({ key: "nExample" });
  assert.equal(r.imageUrl, "");
  assert.equal(r.userIcon, "");
}

// Error envelopes and mismatched note identities cannot be presented as a
// successfully fetched article merely because their HTTP status was 200.
for (const [payload, code] of [
  [null, "article_invalid_response"],
  [[], "article_invalid_response"],
  [{ data: null }, "article_invalid_response"],
  [{ data: { note: [] } }, "article_invalid_response"],
  [{ data: { message: "not accessible" } }, "article_invalid_response"],
  [{ data: { key: "nWrong", body: "wrong article" } }, "article_key_mismatch"],
]) {
  const f = fixture({ payload });
  assert.equal((await f.api({ key: "nExample" })).code, code);
  assert.equal(f.timers.size, 0);
  assert.equal(f.cleared.length, 1);
}

for (const status of [401, 403, 404, 429, 500]) {
  let jsonCalls = 0;
  const f = fixture({ status, jsonImpl: async () => jsonCalls++ });
  const r = await f.api({ key: "nExample" });
  assert.equal(r.code, "article_fetch_" + status);
  assert.equal(r.ok, false);
  assert.equal(jsonCalls, 0);
  assert.equal(f.timers.size, 0);
}

for (const options of [
  {
    fetchImpl: async () => {
      throw Error("network lost");
    },
  },
  {
    jsonImpl: async () => {
      throw Error("invalid JSON");
    },
  },
]) {
  const f = fixture(options);
  const r = await f.api({ key: "nExample" });
  assert.equal(r.code, "article_failed");
  assert.equal(f.timers.size, 0);
}

// Trigger the actual scheduled abort, without waiting twelve seconds or
// relying on real network timing. Cleanup runs on the timeout path too.
{
  const f = fixture({
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  const pending = f.api({ key: "nExample" });
  assert.equal(f.timers.get(1).delay, 12000);
  f.timers.get(1).callback();
  assert.equal((await pending).code, "article_timeout");
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.cleared, [1]);
}

console.log(
  "member-article-check-ok: canonical identities, metadata, hostile URLs, missing/paid bodies, HTTP/network/JSON failures, abort cleanup",
);
