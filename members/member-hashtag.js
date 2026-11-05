"use strict";
(() => {
  const A = globalThis.NeroAppApiCore;
  const MAX_PAGES = 100;
  let running = false;
  function normalizeTag(value) {
    let tag = typeof value === "string" ? value.trim() : "";
    if (/^https?:/i.test(tag)) {
      try {
        const url = new URL(tag);
        if (
          !/^https:\/\/note\.com\//i.test(tag) ||
          url.hostname !== "note.com" ||
          url.username ||
          url.password ||
          url.port
        )
          return "";
        const match = url.pathname.match(/^\/(?:hashtag|tag)\/([^/]+)\/?$/);
        if (!match) return "";
        tag = decodeURIComponent(match[1]);
      } catch {
        return "";
      }
    } else tag = tag.replace(/^[#＃]/, "");
    tag = tag.normalize("NFC");
    const points = Array.from(tag);
    return !points.length ||
      points.length > 80 ||
      /[\\/#＃\p{White_Space}\p{Cc}\p{Cf}]/u.test(tag) ||
      tag === "." ||
      tag === ".." ||
      points.some(
        (c) =>
          c.length === 1 &&
          c.charCodeAt(0) >= 0xd800 &&
          c.charCodeAt(0) <= 0xdfff,
      )
      ? ""
      : tag;
  }
  const ownerName = (value) =>
    typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
      ? value.toLowerCase()
      : "";
  function normalizeArticle(row) {
    if (!row || typeof row !== "object") return null;
    const key = typeof row.key === "string" ? row.key : "";
    const creator = ownerName(row.user?.urlname || row.urlname);
    if (!/^n[a-zA-Z0-9_-]+$/.test(key) || !creator) return null;
    const url = `https://note.com/${creator}/n/${key}`;
    if (row.note_url || row.noteUrl || row.url) {
      try {
        const parsed = new URL(row.note_url || row.noteUrl || row.url);
        if (
          parsed.username ||
          parsed.password ||
          parsed.origin !== "https://note.com" ||
          parsed.origin + parsed.pathname.replace(/\/$/, "") !== url
        )
          return null;
      } catch {
        return null;
      }
    }
    return {
      key,
      url,
      urlname: creator,
      name: String(row.name || row.title || "無題の記事"),
      nickname: String(row.user?.nickname || row.user?.name || creator),
      description: String(row.description || "").slice(0, 3000),
      eyecatch: String(row.eyecatch_url || row.eyecatch || ""),
      publishAt: String(
        row.publish_at || row.publishAt || row.published_at || "",
      ),
      ...(typeof row.is_liked === "boolean" ? { liked: row.is_liked } : {}),
    };
  }
  async function accountMatches(expected) {
    try {
      const r = await A.currentAccount();
      return r?.ok === true && ownerName(r.owner) === expected;
    } catch {
      return false;
    }
  }
  const accountError = () => ({
    ok: false,
    code: "account_changed",
    message:
      "ログイン中のアカウントを確認できませんでした。接続を再確認してください。",
  });
  async function page(tag, number) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(
        `https://note.com/api/v3/hashtags/${encodeURIComponent(tag)}/notes?order=new&page=${number}`,
        {
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        },
      );
      if (response.status === 404 && number === 1)
        return {
          notes: [],
          next_page: null,
          is_last_page: true,
          notFound: true,
        };
      if (!response.ok)
        throw Object.assign(
          new Error(
            `タグの記事を取得できませんでした（HTTP ${response.status}）。noteの表示と接続を確認し、時間をおいて再取得してください。`,
          ),
          { code: "hashtag_http_error" },
        );
      const payload = await response.json(),
        data = payload?.data;
      if (
        !data ||
        !Array.isArray(data.notes) ||
        typeof data.is_last_page !== "boolean"
      )
        throw new Error("タグ検索の応答形式を確認できませんでした。");
      if (
        !data.is_last_page &&
        (!Number.isSafeInteger(Number(data.next_page)) ||
          Number(data.next_page) < 1)
      )
        throw new Error("タグ検索の次のページを確認できませんでした。");
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  async function fetchHashtag(port, requestId, args = {}) {
    const hashtag = normalizeTag(args.hashtag),
      expected = ownerName(args.expectedAccount);
    const includeLiked = args.includeLiked === true;
    const limit = [50, 100, 200].includes(args.limit) ? args.limit : 100;
    if (!hashtag)
      return {
        ok: false,
        code: "invalid_hashtag",
        message: "ハッシュタグを1つ入力してください。例：#王子の城下町",
      };
    if (!expected) return accountError();
    if (running)
      return {
        ok: false,
        code: "busy",
        message: "タグの記事を取得中です。完了か中断を待ってください。",
      };
    running = true;
    const token = A.jobToken("watch_feed"),
      items = [],
      seen = new Set(),
      pages = new Set();
    let pageNumber = 1,
      candidateCount = 0,
      checkedArticles = 0,
      likedCount = 0,
      statusFailedCount = 0,
      failures = 0;
    let reason = "page_limit",
      hasMore = true,
      notFound = false,
      message = "",
      accountChanged = false;
    function progress() {
      A.progress(port, requestId, {
        phase: "hashtag",
        completed: items.length,
        total: limit,
        found: items.length,
        candidateCount,
        checkedArticles,
        liked: likedCount,
        message: `#${hashtag}：${items.length} / ${limit}本を取得・${candidateCount}記事を確認`,
      });
    }
    try {
      if (!(await accountMatches(expected))) return accountError();
      progress();
      for (let round = 0; round < MAX_PAGES; round++) {
        if (token.cancelled) {
          reason = "cancelled";
          break;
        }
        if (pages.has(pageNumber)) {
          reason = "pagination_stopped";
          break;
        }
        pages.add(pageNumber);
        let result;
        try {
          result = await page(hashtag, pageNumber);
        } catch (error) {
          reason = "request_failed";
          message =
            error?.name === "AbortError"
              ? "タグの記事取得がタイムアウトしました。"
              : error.message || "タグの記事を取得できませんでした。";
          break;
        }
        if (!(await accountMatches(expected))) {
          accountChanged = true;
          break;
        }
        if (token.cancelled) {
          reason = "cancelled";
          break;
        }
        notFound ||= result.notFound === true;
        const fresh = [];
        for (const row of result.notes) {
          const item = normalizeArticle(row);
          if (!item || seen.has(item.url)) continue;
          seen.add(item.url);
          fresh.push(item);
        }
        // This is the dedicated hashtag API, not related-topic or keyword search.
        // Membership in the response identifies the exact requested hashtag.
        let index = 0;
        while (
          index < fresh.length &&
          items.length < limit &&
          !token.cancelled
        ) {
          const batch = fresh.slice(
            index,
            index + Math.min(2, limit - items.length),
          );
          index += batch.length;
          candidateCount += batch.length;
          if (includeLiked) items.push(...batch);
          else {
            const results = await Promise.all(
              batch.map(async (item) => {
                try {
                  const status = await A.noteAction("status", {
                    articleUrl: item.url,
                    force: true,
                  });
                  return status?.ok === true &&
                    typeof status.liked === "boolean"
                    ? { item, liked: status.liked }
                    : { item, failed: true };
                } catch {
                  return { item, failed: true };
                }
              }),
            );
            for (const r of results) {
              checkedArticles++;
              if (r.failed) {
                statusFailedCount++;
                failures++;
              } else {
                failures = 0;
                if (r.liked) likedCount++;
                else items.push({ ...r.item, liked: false });
              }
            }
            if (!(await accountMatches(expected))) {
              accountChanged = true;
              break;
            }
          }
          progress();
          if (failures >= 5) {
            reason = "status_failed";
            break;
          }
        }
        if (accountChanged) break;
        if (token.cancelled) {
          reason = "cancelled";
          break;
        }
        if (failures >= 5) break;
        if (items.length >= limit) {
          reason = "limit";
          hasMore = index < fresh.length || !result.is_last_page;
          break;
        }
        if (result.is_last_page) {
          reason = notFound ? "not_found" : "exhausted";
          hasMore = false;
          break;
        }
        if (!fresh.length) {
          reason = "pagination_stopped";
          break;
        }
        pageNumber = Number(result.next_page);
      }
      if (accountChanged || !(await accountMatches(expected)))
        return accountError();
      if (reason === "request_failed" && !items.length)
        return { ok: false, code: "hashtag_fetch_failed", message };
      return {
        ok: true,
        owner: expected,
        mode: "hashtag",
        hashtag,
        includeLiked,
        limit,
        items: globalThis.NeroMemberFeed.shuffle(items),
        candidateCount,
        checkedArticles,
        likedCount,
        statusFailedCount,
        partial:
          [
            "request_failed",
            "status_failed",
            "pagination_stopped",
            "page_limit",
            "cancelled",
          ].includes(reason) || statusFailedCount > 0,
        cancelled: reason === "cancelled",
        hasMore,
        reason,
        notFound,
        message,
        limitReached: reason === "limit" && hasMore,
      };
    } finally {
      A.finishJob("watch_feed", token);
      running = false;
    }
  }
  globalThis.NeroMemberHashtag = {
    fetch: fetchHashtag,
    normalizeTag,
    normalizeArticle,
  };
})();
