"use strict";
(() => {
  const A = globalThis.NeroAppApiCore;
  const record = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const firstString = (value, names) =>
    names
      .map((name) => value?.[name])
      .find((item) => typeof item === "string" && item.trim()) || "";
  const creatorName = (value) =>
    typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value.trim())
      ? value.trim().toLowerCase()
      : "";

  function imageUrl(value) {
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password
        ? url.href
        : "";
    } catch {
      return "";
    }
  }

  function articleIdentity(value, key) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      const match = url.pathname.match(
        /^\/([a-zA-Z0-9_-]{1,80})\/n\/(n[a-zA-Z0-9_-]+)\/?$/,
      );
      if (
        url.protocol !== "https:" ||
        url.hostname !== "note.com" ||
        url.port ||
        url.username ||
        url.password ||
        !match ||
        match[2] !== key
      )
        return null;
      const urlname = match[1].toLowerCase();
      return { urlname, url: `https://note.com/${urlname}/n/${key}` };
    } catch {
      return null;
    }
  }

  function failure(code) {
    return {
      ok: false,
      code,
      message: "記事本文を取得できませんでした。",
    };
  }

  A.fetchArticle = async (args = {}) => {
    const key = typeof args?.key === "string" ? args.key.trim() : "";
    if (!/^n[a-zA-Z0-9_-]+$/.test(key))
      return {
        ok: false,
        code: "invalid_article_key",
        message: "記事IDを確認できませんでした。",
      };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(
        "https://note.com/api/v3/notes/" + encodeURIComponent(key),
        {
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        },
      );
      if (!response.ok) return failure("article_fetch_" + response.status);
      let row = await response.json();
      if (record(row) && Object.hasOwn(row, "data")) row = row.data;
      if (record(row) && Object.hasOwn(row, "note")) row = row.note;
      if (!record(row)) return failure("article_invalid_response");
      if (typeof row.key === "string" && row.key && row.key !== key)
        return failure("article_key_mismatch");
      // A successful HTTP response can still be an error envelope. Keep an
      // empty paid/restricted body empty, but do not call an error object an
      // article merely because the request itself returned 200.
      if (
        ![
          "key",
          "name",
          "title",
          "body",
          "bodyText",
          "body_text",
          "contentText",
          "description",
        ].some((name) => typeof row[name] === "string")
      )
        return failure("article_invalid_response");

      const user = record(row.user)
        ? row.user
        : record(row.author)
          ? row.author
          : {};
      const creator = creatorName(user.urlname) || creatorName(row.urlname);
      let identity = null;
      for (const name of ["noteUrl", "note_url", "url"]) {
        const candidate = articleIdentity(row[name], key);
        if (candidate && (!creator || candidate.urlname === creator)) {
          identity = candidate;
          break;
        }
      }
      if (!identity && creator)
        identity = {
          urlname: creator,
          url: `https://note.com/${creator}/n/${key}`,
        };
      const count = Number(row.like_count ?? row.likeCount ?? 0);
      return {
        ok: true,
        key,
        title: firstString(row, ["name", "title"]),
        body: firstString(row, [
          "body",
          "bodyText",
          "body_text",
          "contentText",
        ]),
        description: firstString(row, ["description"]),
        imageUrl: imageUrl(
          firstString(row, [
            "eyecatch",
            "eyecatchUrl",
            "eyecatch_url",
            "thumbnail_url",
            "image_url",
          ]),
        ),
        likeCount: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
        url: identity?.url || "",
        urlname: identity?.urlname || "",
        nickname:
          firstString(user, ["nickname", "name"]) ||
          firstString(row, ["nickname"]) ||
          identity?.urlname ||
          "",
        publishAt: firstString(row, [
          "publishAt",
          "publish_at",
          "publishedAt",
          "published_at",
          "createdAt",
          "created_at",
        ]),
        userIcon: imageUrl(
          firstString(user, [
            "userProfileImagePath",
            "profileImageUrl",
            "user_profile_image_url",
            "profile_image_url",
          ]),
        ),
      };
    } catch (error) {
      return failure(
        error?.name === "AbortError" ? "article_timeout" : "article_failed",
      );
    } finally {
      clearTimeout(timer);
    }
  };
})();
