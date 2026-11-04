import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({ URL });
vm.runInContext(fs.readFileSync("members/reader/model.js", "utf8"), ctx);
const M = ctx.NeroMemberModel;
const plain = (value) => JSON.parse(JSON.stringify(value));
const preset = {
  owner: "reader_owner",
  version: 1,
  list: {
    id: "castle",
    name: "城下町メンバー",
    users: ["member_a", "MEMBER_B", "member_a"],
    pending: [{ name: "未照合の方", note: "ID未照合" }],
  },
};

const old = {
  watch: ["legacy_a", "https://note.com/legacy_b", "LEGACY_A"],
  drafts: { comment: "下書き" },
  uncertain: { comment: true },
};
const migrated = M.normalizeData(old, "reader_owner", preset);
assert.equal(migrated.lists.length, 11);
assert.equal(migrated.lists[0].id, "castle");
assert.equal(migrated.lists[10].id, "list-10");
assert.equal(migrated.lists[1].name, "旧ウォッチリスト");
assert.equal(migrated.activeListId, "list-1");
assert.deepEqual(plain(migrated.lists[1].users), ["legacy_a", "legacy_b"]);
assert.deepEqual(plain(migrated.lists[0].users), ["member_a", "member_b"]);
assert.deepEqual(plain(migrated.lists[0].pending), preset.list.pending);
assert.equal(migrated.lists[0].users.includes("未照合の方"), false);
assert.equal(migrated.watch, undefined);
assert.deepEqual(old.watch, [
  "legacy_a",
  "https://note.com/legacy_b",
  "LEGACY_A",
]);
assert.equal(migrated.drafts.comment, "下書き");
assert.equal(migrated.uncertain.comment, true);
assert.deepEqual(
  plain(migrated.feedOptions),
  {
    includeLiked: false,
    deepIncludeLiked: false,
    deepCreator: "",
  },
  "legacy data defaults to unliked feeds and no deep creator",
);

// Feed preferences accept actual booleans and normalize the deep creator.
const rawPreferences = {
  owner: "reader_owner",
  feedOptions: {
    includeLiked: true,
    deepIncludeLiked: false,
    deepCreator: "https://note.com/PREF_WRITER?from=profile",
    unexpected: "discard",
  },
};
const preferences = M.normalizeData(rawPreferences, "reader_owner", null);
assert.deepEqual(plain(preferences.feedOptions), {
  includeLiked: true,
  deepIncludeLiked: false,
  deepCreator: "pref_writer",
});
assert.equal(
  rawPreferences.feedOptions.deepCreator,
  "https://note.com/PREF_WRITER?from=profile",
  "normalization does not mutate saved preferences",
);
assert.notEqual(preferences.feedOptions, rawPreferences.feedOptions);
assert.deepEqual(
  plain(
    M.normalizeData(
      {
        feedOptions: {
          includeLiked: "true",
          deepIncludeLiked: 1,
          deepCreator: "https://example.com/writer",
        },
      },
      "reader_owner",
      null,
    ).feedOptions,
  ),
  {
    includeLiked: false,
    deepIncludeLiked: false,
    deepCreator: "",
  },
  "truthy non-booleans and a foreign creator URL are not valid preferences",
);
assert.deepEqual(
  plain(
    M.normalizeData(
      {
        feedOptions: {
          includeLiked: false,
          deepIncludeLiked: true,
          deepCreator: "@DEEP_WRITER",
        },
      },
      "reader_owner",
      null,
    ).feedOptions,
  ),
  {
    includeLiked: false,
    deepIncludeLiked: true,
    deepCreator: "deep_writer",
  },
);
assert.deepEqual(
  plain(M.normalizeData(preferences, "another_owner", null).feedOptions),
  {
    includeLiked: false,
    deepIncludeLiked: false,
    deepCreator: "",
  },
  "another account must not inherit a reader's feed preferences",
);
assert.deepEqual(
  plain(M.normalizeData(preferences, "READER_OWNER", null).feedOptions),
  plain(preferences.feedOptions),
  "the same normalized account keeps preferences on reload",
);

// Presets are account-bound, including accidentally reused in-memory state.
const other = M.normalizeData({}, "another_owner", preset);
assert.equal(other.lists[0].users.length, 0);
assert.equal(other.seedVersion, 0);
const switched = M.normalizeData(migrated, "another_owner", preset);
assert.equal(
  switched.lists.every((list) => !list.users.length),
  true,
);
assert.deepEqual(plain(switched.drafts), {});

// A later reload must retain deliberate edits and removals in the seeded list.
migrated.lists[0].users = ["new_member"];
migrated.lists[0].pending = [];
migrated.lists[2].name = "創作仲間";
migrated.lists[2].users = ["friend"];
const reloaded = M.normalizeData(migrated, "reader_owner", preset);
assert.deepEqual(plain(reloaded.lists[0].users), ["new_member"]);
assert.deepEqual(plain(reloaded.lists[0].pending), []);
assert.equal(reloaded.lists[2].name, "創作仲間");
assert.deepEqual(plain(reloaded.lists[2].users), ["friend"]);
assert.equal(reloaded.seedVersion, 1);

// Existing castle users are merged once instead of overwritten by the seed.
const beforeSeed = M.normalizeData({}, "reader_owner", null);
beforeSeed.lists[0].users.push("already_added");
const seededExisting = M.normalizeData(beforeSeed, "reader_owner", preset);
assert.deepEqual(plain(seededExisting.lists[0].users), [
  "already_added",
  "member_a",
  "member_b",
]);

const imported = M.importList(
  reloaded,
  JSON.stringify({
    name: "読書仲間",
    users: ["@reader_a", "https://note.com/reader_b/n/n123", "READER_A"],
    pending: [{ name: "名前だけの方", id: "untrusted_guess" }],
  }),
  { targetId: "list-3" },
);
assert.equal(imported.lists.length, 11);
assert.equal(imported.activeListId, "list-3");
assert.equal(M.activeList(imported).name, "読書仲間");
assert.deepEqual(plain(M.activeList(imported).users), ["reader_a", "reader_b"]);
assert.deepEqual(plain(M.activeList(imported).pending), [
  { name: "名前だけの方", note: "ID未照合" },
]);
assert.equal(M.activeList(imported).users.includes("untrusted_guess"), false);
assert.deepEqual(plain(imported.lists[0]), plain(reloaded.lists[0]));
assert.equal(imported.drafts.comment, "下書き");
assert.equal(imported.uncertain.comment, true);
assert.equal(reloaded.lists[3].name, "リスト3", "imports do not mutate input");

const merged = M.importList(
  imported,
  { users: ["reader_b", "reader_c"] },
  { merge: true },
);
assert.deepEqual(plain(M.activeList(merged).users), [
  "reader_a",
  "reader_b",
  "reader_c",
]);
assert.equal(M.activeList(merged).name, "読書仲間");
assert.equal(M.activeList(merged).pending.length, 1);

for (const merge of [false, true]) {
  const preferencesImported = M.importList(
    preferences,
    {
      owner: "reader_owner",
      list: { name: "Imported readers", users: ["imported_reader"] },
      feedOptions: {
        includeLiked: false,
        deepIncludeLiked: true,
        deepCreator: "external_writer",
      },
    },
    { targetId: "list-2", merge },
  );
  assert.deepEqual(
    plain(preferencesImported.feedOptions),
    plain(preferences.feedOptions),
    "watchlist imports preserve local feed preferences instead of importing external preferences",
  );
  assert.notEqual(preferencesImported.feedOptions, preferences.feedOptions);
  preferencesImported.feedOptions.includeLiked = false;
  assert.equal(
    preferences.feedOptions.includeLiked,
    true,
    "imported data must not share its preference object with the source data",
  );
}

assert.throws(() => M.importList(reloaded, "{invalid"), /JSON/);
assert.throws(
  () => M.importList(reloaded, { users: ["valid", "ID未照合"] }),
  /2件目/,
);
assert.throws(
  () => M.importList(reloaded, { users: ["https://example.com/reader"] }),
  /ユーザーID/,
);
assert.throws(
  () =>
    M.importList(reloaded, {
      users: Array.from({ length: 201 }, (_, i) => `u${i}`),
    }),
  /200人/,
);
assert.throws(
  () => M.importList(reloaded, { users: [], name: "a".repeat(41) }),
  /40文字/,
);
assert.throws(
  () => M.importList(reloaded, { users: [] }, { targetId: "list-11" }),
  /読み込み先/,
);
assert.throws(
  () => M.importList(reloaded, { owner: "another_owner", users: [] }),
  /別のアカウント/,
);
assert.equal(
  M.normalizeData(
    { lists: [{ id: "evil", users: ["unwanted"] }] },
    "owner",
    null,
  ).lists.some((list) => list.users.includes("unwanted")),
  false,
);
assert.equal(
  M.activeList({ lists: reloaded.lists, activeListId: "bad" }).id,
  "castle",
);
assert.equal(M.MAX_LISTS, 11);
assert.equal(M.MAX_CREATORS, 200);

console.log(
  "watchlists-check-ok: migration, 11 lists, account isolation, one-time presets, import validation, feed preference normalization and retention",
);
