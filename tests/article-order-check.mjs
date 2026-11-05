import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync("members/reader/model.js", "utf8"), context);
const M = context.NeroMemberModel;
const keys = (rows) => Array.from(rows, (row) => row.key);

const rows = Object.freeze([
  Object.freeze({ key: "missing", updatedAt: "2099-01-01T00:00:00Z" }),
  Object.freeze({ key: "new", publishAt: "2026-11-05T00:00:10Z" }),
  Object.freeze({ key: "tie_z", publishAt: "2026-11-05T00:00:09Z" }),
  Object.freeze({ key: "invalid", publishAt: "not-a-date" }),
  Object.freeze({ key: "old", publishAt: "2026-11-05T00:00:08Z" }),
  Object.freeze({ key: "tie_jp", publishAt: "2026-11-05T09:00:09+09:00" }),
  Object.freeze({ key: "fraction", publishAt: "2026-11-05T00:00:09.500Z" }),
  Object.freeze({ key: "previous_day", publishAt: "2026-11-04T23:59:59Z" }),
  Object.freeze({ key: "empty", publishAt: "  " }),
  Object.freeze({ key: "numeric", publishAt: 2026 }),
]);
const original = keys(rows);

// Comparing full instants keeps seconds and fractions, and equivalent timezone
// representations remain stable in their original relative order.
assert.deepEqual(keys(M.orderArticles(rows, "date_asc")), [
  "previous_day",
  "old",
  "tie_z",
  "tie_jp",
  "fraction",
  "new",
  "missing",
  "invalid",
  "empty",
  "numeric",
]);
assert.deepEqual(keys(M.orderArticles(rows, "date_desc")), [
  "new",
  "fraction",
  "tie_z",
  "tie_jp",
  "old",
  "previous_day",
  "missing",
  "invalid",
  "empty",
  "numeric",
]);
assert.deepEqual(keys(rows), original, "sorting must not mutate the feed pool");
for (const order of ["random", "invalid", undefined, null, true]) {
  const result = M.orderArticles(rows, order);
  assert.notEqual(result, rows);
  assert.deepEqual(
    keys(result),
    original,
    "random restores the backend pool order",
  );
  assert.equal(
    result[0],
    rows[0],
    "rows remain the same objects for current-article tracking",
  );
}
for (const order of ["date_asc", "date_desc"]) {
  const unknown = [{ key: "one" }, { key: "two", publishAt: "bad" }];
  assert.deepEqual(keys(M.orderArticles(unknown, order)), ["one", "two"]);
  assert.deepEqual(keys(M.orderArticles([], order)), []);
  assert.deepEqual(keys(M.orderArticles(undefined, order)), []);
}

for (const value of ["random", "date_asc", "date_desc"])
  assert.equal(M.articleOrder(value), value);
for (const value of [
  undefined,
  null,
  true,
  1,
  "DATE_ASC",
  " date_desc ",
  {},
  ["date_asc"],
])
  assert.equal(M.articleOrder(value), "random");
assert.equal(M.orderLabel("random"), "ランダム");
assert.equal(M.orderLabel("date_asc"), "古い順");
assert.equal(M.orderLabel("date_desc"), "新しい順");
assert.equal(M.orderLabel("bad"), "ランダム");

// A displayed timestamp includes seconds rather than only a day or minute.
// Its timezone is the browser's timezone; equivalent instants format alike.
const display = M.formatPublishAt("2026-11-05T00:00:09Z");
assert.match(display, /^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:09$/);
assert.equal(display, M.formatPublishAt("2026-11-05T09:00:09+09:00"));
assert.notEqual(display, M.formatPublishAt("2026-11-05T00:00:10Z"));
for (const value of ["", "  ", "invalid", null, undefined, 0, {}])
  assert.equal(M.formatPublishAt(value), "");

const preferences = M.normalizeData(
  {
    owner: "alice",
    feedOptions: {
      includeLiked: true,
      articleOrder: "date_asc",
      deepCreator: "writer_a",
    },
  },
  "alice",
  null,
);
assert.equal(preferences.feedOptions.articleOrder, "date_asc");
assert.equal(
  M.normalizeData(preferences, "ALICE", null).feedOptions.articleOrder,
  "date_asc",
);
assert.equal(
  M.normalizeData(preferences, "bob", null).feedOptions.articleOrder,
  "random",
  "another account does not inherit ordering preferences",
);
for (const merge of [true, false]) {
  const imported = M.importList(
    preferences,
    {
      owner: "alice",
      users: ["writer_b"],
      feedOptions: { articleOrder: "date_desc" },
    },
    { merge },
  );
  assert.equal(imported.feedOptions.articleOrder, "date_asc");
  assert.notEqual(imported.feedOptions, preferences.feedOptions);
}

for (const [input, expected] of [
  ["#企画", "企画"],
  ["＃企画", "企画"],
  ["Cafe\u0301", "Café"],
  ["https://note.com/hashtag/%E4%BC%81%E7%94%BB?f=new", "企画"],
  ["https://note.com/tag/企画", "企画"],
])
  assert.equal(M.hashtagName(input), expected);
for (const input of [
  "##企画",
  "a b",
  "a/b",
  "a\\b",
  "a#b",
  "https://@note.com/hashtag/a",
  "https://evil.test/hashtag/a",
  "a".repeat(81),
  "\ud800",
  ".",
  "..",
])
  assert.equal(M.hashtagName(input), "");
const tags = M.normalizeData(
  {
    owner: "alice",
    feedOptions: {
      hashtag: "#企画",
      hashtagIncludeLiked: true,
      hashtagLimit: 200,
      articleOrder: "date_desc",
    },
  },
  "alice",
  null,
);
assert.equal(tags.feedOptions.hashtag, "企画");
assert.equal(tags.feedOptions.hashtagLimit, 200);
assert.equal(tags.feedOptions.hashtagIncludeLiked, true);
assert.equal(M.normalizeData(tags, "bob", null).feedOptions.hashtag, "");
assert.equal(
  M.normalizeData(
    { feedOptions: { hashtagIncludeLiked: "true", hashtagLimit: "200" } },
    "alice",
    null,
  ).feedOptions.hashtagLimit,
  100,
);
console.log(
  "article-order-check-ok: seconds and fractional instants, timezone equivalence, stable ties, unknown dates last, unchanged random pool, strict saved preferences and account isolation",
);
