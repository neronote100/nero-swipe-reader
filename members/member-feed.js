"use strict";
(() => {
  const A = globalThis.NeroAppApiCore;
  let running = false;

  function creatorName(value) {
    const name = String(value || "").trim();
    return /^[a-zA-Z0-9_-]{1,80}$/.test(name) ? name.toLowerCase() : "";
  }

  function articleUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (
        url.protocol !== "https:" ||
        url.hostname !== "note.com" ||
        !/^\/[a-zA-Z0-9_-]+\/n\/n[a-zA-Z0-9_-]+\/?$/.test(url.pathname)
      )
        return "";
      return url.origin + url.pathname.replace(/\/$/, "");
    } catch {
      return "";
    }
  }

  function randomUnit() {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] / 4294967296;
  }

  // Shuffle the complete eligible pool only after every creator/status task.
  // Network response order and watchlist registration order cannot pick winners.
  function shuffle(items, random = randomUnit) {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  async function accountMatches(expected) {
    try {
      const result = await A.currentAccount();
      return result?.ok === true && creatorName(result.owner) === expected;
    } catch {
      return false;
    }
  }

  function accountError() {
    return {
      ok: false,
      code: "account_changed",
      message:
        "ログイン中のアカウントを確認できませんでした。接続を再確認してから記事を取得してください。",
    };
  }

  async function fetchFeed(port, requestId, args = {}) {
    const expected = creatorName(args.expectedAccount);
    if (!expected) return accountError();
    const rawCreators = Array.isArray(args.creators) ? args.creators : [];
    const creators = [...new Set(rawCreators.map(creatorName).filter(Boolean))];
    if (creators.length > 200) {
      return {
        ok: false,
        code: "watchlist_limit",
        message: "1つのウォッチリストには200人まで登録できます。",
      };
    }
    if (running) {
      return {
        ok: false,
        code: "busy",
        message: "記事を取得中です。完了または中断を待ってください。",
      };
    }
    running = true;
    const token = A.jobToken("watch_feed");
    try {
      if (!(await accountMatches(expected))) return accountError();
      const candidateGroups = new Array(creators.length);
      const failedCreators = [];
      const emptyCreators = [];
      let cursor = 0,
        checkedCreators = 0;
      A.progress(port, requestId, {
        phase: "creators",
        completed: 0,
        total: creators.length,
        found: 0,
        message: `${creators.length}人の直近3記事を確認しています…`,
      });

      async function creatorWorker() {
        while (cursor < creators.length && !token.cancelled) {
          const position = cursor++;
          const creator = creators[position];
          try {
            const page = await A.bg().fetchCreatorContentsPage(creator, 1);
            if (!Array.isArray(page))
              throw new Error("invalid_creator_response");
            const seen = new Set();
            const valid = page.filter((item) => {
              const url = articleUrl(item?.url);
              if (
                !url ||
                creatorName(new URL(url).pathname.split("/")[1]) !== creator ||
                seen.has(url)
              )
                return false;
              seen.add(url);
              return true;
            });
            const latest = valid
              .slice()
              .sort(
                (left, right) =>
                  (Date.parse(right.publishAt || "") || 0) -
                  (Date.parse(left.publishAt || "") || 0),
              )
              .slice(0, 3)
              .map((item) => ({ ...item, url: articleUrl(item.url) }));
            candidateGroups[position] = latest;
            if (!latest.length) emptyCreators.push(creator);
          } catch {
            failedCreators.push(creator);
          }
          checkedCreators++;
          A.progress(port, requestId, {
            phase: "creators",
            completed: checkedCreators,
            total: creators.length,
            failed: failedCreators.length,
            message: `直近記事を確認中 ${checkedCreators} / ${creators.length}人`,
          });
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(3, creators.length) }, creatorWorker),
      );
      if (!(await accountMatches(expected))) return accountError();
      const seen = new Set();
      const candidates = candidateGroups.flat().filter((item) => {
        if (!item || seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });
      const eligible = [];
      let checkedArticles = 0,
        likedCount = 0,
        statusFailedCount = 0;
      cursor = 0;
      A.progress(port, requestId, {
        phase: "likes",
        completed: 0,
        total: candidates.length,
        found: 0,
        message: `${candidates.length}記事のスキ状態を確認しています…`,
      });
      async function statusWorker() {
        while (cursor < candidates.length && !token.cancelled) {
          const item = candidates[cursor++];
          try {
            // Force bypasses the legacy two-minute status cache. The member
            // build forwards this flag to runStatusApi(articleUrl, true).
            const status = await A.noteAction("status", {
              articleUrl: item.url,
              force: true,
            });
            if (!status?.ok || typeof status.liked !== "boolean")
              throw new Error("unknown_like_status");
            if (status.liked) likedCount++;
            else eligible.push({ ...item, liked: false });
          } catch {
            // An unknown status is never presented as "not liked".
            statusFailedCount++;
          }
          checkedArticles++;
          A.progress(port, requestId, {
            phase: "likes",
            completed: checkedArticles,
            total: candidates.length,
            found: eligible.length,
            liked: likedCount,
            failed: statusFailedCount,
            message: `スキ状態を確認中 ${checkedArticles} / ${candidates.length}記事`,
          });
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(4, candidates.length) }, statusWorker),
      );
      if (!(await accountMatches(expected))) return accountError();
      return {
        ok: true,
        owner: expected,
        items: shuffle(eligible),
        cancelled: Boolean(token.cancelled),
        partial: Boolean(
          token.cancelled || failedCreators.length || statusFailedCount,
        ),
        totalCreators: creators.length,
        checkedCreators,
        candidateCount: candidates.length,
        checkedArticles,
        likedCount,
        statusFailedCount,
        failedCreators,
        emptyCreators,
        failed: failedCreators,
      };
    } finally {
      A.finishJob("watch_feed", token);
      running = false;
    }
  }

  globalThis.NeroMemberFeed = {
    fetch: fetchFeed,
    shuffle,
    creatorName,
    articleUrl,
  };
})();
