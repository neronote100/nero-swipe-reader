"use strict";
globalThis.NeroMemberModel = {
  watchName(value) {
    let v = String(value || "")
      .trim()
      .replace(/^@/, "");
    if (/^https?:/.test(v)) {
      try {
        const u = new URL(v);
        if (u.protocol !== "https:" || u.hostname !== "note.com") return "";
        v = u.pathname.split("/")[1];
      } catch {
        return "";
      }
    }
    return /^[a-zA-Z0-9_-]{1,80}$/.test(v) ? v.toLowerCase() : "";
  },
  articleUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === "https:" &&
        u.hostname === "note.com" &&
        /^\/[\w-]+\/n\/n[\w-]+\/?$/.test(u.pathname)
        ? u.origin + u.pathname
        : "";
    } catch {
      return "";
    }
  },
  canSwipe(start, end, scroll) {
    return (
      Math.abs(end.y - start.y) > 85 &&
      Math.abs(end.y - start.y) > Math.abs(end.x - start.x) * 1.8 &&
      (end.y < start.y
        ? scroll.top + scroll.height >= scroll.total - 4
        : scroll.top <= 4)
    );
  },
  storageKey(owner) {
    return "nero.members.v1." + owner.toLowerCase();
  },
  draftKey(c) {
    return c.inboxKey || c.key || c.articleUrl;
  },
};

(() => {
  const M = globalThis.NeroMemberModel;
  const MAX_LISTS = 11;
  const MAX_CREATORS = 200;
  const MAX_NAME_LENGTH = 40;
  const ids = [
    "castle",
    ...Array.from({ length: 10 }, (_, i) => `list-${i + 1}`),
  ];
  const isRecord = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const label = (value, fallback = "") =>
    typeof value === "string"
      ? value.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH) || fallback
      : fallback;

  function usersFrom(value, strict = false) {
    if (!Array.isArray(value)) {
      if (strict) throw new Error("ユーザーID一覧は配列で指定してください。");
      return [];
    }
    const users = [];
    const seen = new Set();
    for (const [index, valueEntry] of value.entries()) {
      const user =
        typeof valueEntry === "string" ? M.watchName(valueEntry) : "";
      if (!user) {
        if (strict)
          throw new Error(`${index + 1}件目のユーザーIDを確認してください。`);
        continue;
      }
      if (seen.has(user)) continue;
      if (users.length >= MAX_CREATORS) {
        if (strict)
          throw new Error(`1つのウォッチリストは${MAX_CREATORS}人までです。`);
        break;
      }
      users.push(user);
      seen.add(user);
    }
    return users;
  }

  function pendingFrom(value, strict = false) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      if (strict) throw new Error("ID未照合の一覧は配列で指定してください。");
      return [];
    }
    const pending = [];
    const seen = new Set();
    for (const entry of value) {
      const name = isRecord(entry) ? label(entry.name) : "";
      if (!name) {
        if (strict) throw new Error("ID未照合の方の表示名を確認してください。");
        continue;
      }
      const note =
        typeof entry.note === "string"
          ? entry.note.trim().slice(0, 300)
          : "ID未照合";
      const key = name + "\n" + note;
      if (seen.has(key)) continue;
      if (pending.length >= MAX_CREATORS) {
        if (strict) throw new Error("ID未照合の一覧は200件までです。");
        break;
      }
      // Unverified names remain notes. Never infer a note user ID from them.
      pending.push({ name, note });
      seen.add(key);
    }
    return pending;
  }

  function emptyList(id, index) {
    return {
      id,
      name: index === 0 ? "城下町メンバー" : `リスト${index}`,
      users: [],
      pending: [],
    };
  }

  function normalizeData(raw, owner, preset = globalThis.NeroMemberPresets) {
    const account = M.watchName(owner);
    let input = isRecord(raw) ? raw : {};
    // Storage is account-scoped in the UI. This also rejects accidentally
    // passing another account's in-memory state to a new account.
    if (input.owner && M.watchName(input.owner) !== account) input = {};
    const saved = new Map();
    if (Array.isArray(input.lists)) {
      for (const item of input.lists) {
        if (isRecord(item) && ids.includes(item.id) && !saved.has(item.id))
          saved.set(item.id, item);
      }
    }
    const lists = ids.map((id, index) => {
      const fallback = emptyList(id, index);
      const item = saved.get(id);
      return item
        ? {
            id,
            name: label(item.name, fallback.name),
            users: usersFrom(item.users),
            pending: pendingFrom(item.pending),
          }
        : fallback;
    });
    const legacy = usersFrom(input.watch);
    if (legacy.length) {
      const previous = lists[1];
      if (!saved.has(previous.id)) previous.name = "旧ウォッチリスト";
      previous.users = usersFrom([...previous.users, ...legacy]);
    }
    const data = {
      ...input,
      owner: account,
      lists,
      activeListId: ids.includes(input.activeListId)
        ? input.activeListId
        : legacy.length
          ? "list-1"
          : "castle",
      drafts: isRecord(input.drafts) ? { ...input.drafts } : {},
      uncertain: isRecord(input.uncertain) ? { ...input.uncertain } : {},
      seedVersion:
        Number.isSafeInteger(input.seedVersion) && input.seedVersion > 0
          ? input.seedVersion
          : 0,
    };
    delete data.watch;

    const version = isRecord(preset) ? preset.version : 0;
    if (
      account &&
      isRecord(preset) &&
      M.watchName(preset.owner) === account &&
      Number.isSafeInteger(version) &&
      version > data.seedVersion &&
      isRecord(preset.list)
    ) {
      const castle = lists[0];
      castle.users = usersFrom([
        ...castle.users,
        ...usersFrom(preset.list.users),
      ]);
      castle.pending = pendingFrom([
        ...castle.pending,
        ...pendingFrom(preset.list.pending),
      ]);
      if (!saved.has("castle"))
        castle.name = label(preset.list.name, castle.name);
      data.seedVersion = version;
    }
    return data;
  }

  function activeList(data) {
    return (
      data?.lists?.find((list) => list.id === data.activeListId) ||
      data?.lists?.find((list) => list.id === "castle") ||
      emptyList("castle", 0)
    );
  }

  function importList(data, input, options = {}) {
    let file = input;
    if (typeof input === "string") {
      try {
        file = JSON.parse(input);
      } catch {
        throw new Error("ウォッチリストのJSONファイルを読み込めませんでした。");
      }
    }
    if (!isRecord(file))
      throw new Error("ウォッチリストのファイル形式を確認してください。");
    if (file.owner && M.watchName(file.owner) !== M.watchName(data?.owner))
      throw new Error("このウォッチリストは別のアカウント用です。");
    const source = isRecord(file.list) ? file.list : file;
    const importedUsers = usersFrom(source.users, true);
    const importedPending = pendingFrom(source.pending, true);
    if (
      source.name !== undefined &&
      (typeof source.name !== "string" ||
        !source.name.trim() ||
        source.name.trim().replace(/\s+/g, " ").length > MAX_NAME_LENGTH)
    )
      throw new Error(
        `リスト名は1〜${MAX_NAME_LENGTH}文字で指定してください。`,
      );
    const next = normalizeData(data, data?.owner, null);
    const targetId = options.targetId || next.activeListId;
    const target = next.lists.find((list) => list.id === targetId);
    if (!target)
      throw new Error("読み込み先のウォッチリストを選んでください。");
    target.name = label(source.name, target.name);
    target.users = options.merge
      ? usersFrom([...target.users, ...importedUsers], true)
      : importedUsers;
    target.pending = options.merge
      ? pendingFrom([...target.pending, ...importedPending], true)
      : importedPending;
    next.activeListId = targetId;
    return next;
  }

  Object.assign(M, {
    MAX_LISTS,
    MAX_CREATORS,
    MAX_NAME_LENGTH,
    normalizeData,
    activeList,
    importList,
  });
})();
