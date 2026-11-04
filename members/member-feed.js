"use strict";
(() => {
  const A = globalThis.NeroAppApiCore;
  const MAX_PAGES = 1000;
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

  function newestFirst(left, right) {
    return (
      (Date.parse(right.publishAt || "") || 0) -
      (Date.parse(left.publishAt || "") || 0)
    );
  }

  function randomUnit() {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] / 4294967296;
  }

  // Shuffle the complete pool after all creators finish. Neither registration
  // order nor network response order gives a creator the first positions.
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
    const mode = args.mode === "deep" ? "deep" : "watch";
    const includeLiked = args.includeLiked === true;
    const target = mode === "deep" ? 50 : 3;
    const deepCreator = creatorName(args.creator);
    if (mode === "deep" && !deepCreator) {
      return {
        ok: false,
        code: "invalid_creator",
        message: "深掘りするnoteユーザーIDを指定してください。",
      };
    }
    const rawCreators = Array.isArray(args.creators) ? args.creators : [];
    const creators =
      mode === "deep"
        ? [deepCreator]
        : [...new Set(rawCreators.map(creatorName).filter(Boolean))];
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
      let accountChanged = false;
      const groups = new Array(creators.length);
      const outcomes = new Array(creators.length);
      let cursor = 0,
        checkedCreators = 0,
        candidateCount = 0,
        checkedArticles = 0,
        likedCount = 0,
        statusFailedCount = 0;

      const stopped = () => token.cancelled || accountChanged;
      async function verifyAccount() {
        if (!(await accountMatches(expected))) accountChanged = true;
        return !accountChanged;
      }
      function report(phase, creator) {
        A.progress(port, requestId, {
          phase,
          creator,
          completed: phase === "likes" ? checkedArticles : checkedCreators,
          total: phase === "likes" ? candidateCount : creators.length,
          found: groups.reduce((sum, items) => sum + (items?.length || 0), 0),
          candidateCount,
          checkedArticles,
          liked: likedCount,
          failed: statusFailedCount,
          message: includeLiked
            ? `新しい記事を取得中 ${checkedCreators} / ${creators.length}人`
            : `未スキの記事を確認中 ${checkedArticles}記事・${checkedCreators} / ${creators.length}人`,
        });
      }
      report("creators");

      async function scanCreator(creator, position) {
        const eligible = [];
        groups[position] = eligible;
        const seen = new Set();
        let consecutiveStatusFailures = 0;
        let statusBlocked = false;
        let reason = "limit";
        for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
          if (stopped()) {
            reason = "cancelled";
            break;
          }
          let page;
          try {
            page = await A.bg().fetchCreatorContentsPage(creator, pageNumber);
            if (!Array.isArray(page))
              throw new Error("invalid_creator_response");
          } catch {
            reason = "failed";
            break;
          }
          // A page is a separate fetch phase. Never use another account's
          // status response to decide which articles belong in this result.
          if (!(await verifyAccount())) break;
          if (stopped()) {
            reason = "cancelled";
            break;
          }
          const fresh = [];
          for (const item of page) {
            const url = articleUrl(item?.url);
            if (
              !url ||
              creatorName(new URL(url).pathname.split("/")[1]) !== creator ||
              seen.has(url)
            )
              continue;
            seen.add(url);
            fresh.push({ ...item, url });
          }
          fresh.sort(newestFirst);
          if (!fresh.length) {
            reason = "exhausted";
            break;
          }

          // At most two status requests per creator and two active creators
          // keeps the whole job at four concurrent status requests.
          for (
            let index = 0;
            index < fresh.length && eligible.length < target;
          ) {
            if (stopped()) break;
            const batch = fresh.slice(
              index,
              index + Math.min(2, target - eligible.length),
            );
            index += batch.length;
            if (includeLiked) {
              candidateCount += batch.length;
              for (const item of batch) {
                // Creator listings may lack viewer-specific metadata. An
                // unknown state must stay unknown when all posts are allowed.
                if (typeof item.liked !== "boolean") delete item.liked;
                eligible.push(item);
              }
              report("creators", creator);
              continue;
            }
            report("likes", creator);
            if (stopped()) break;
            candidateCount += batch.length;
            await Promise.all(
              batch.map(async (item) => {
                try {
                  const status = await A.noteAction("status", {
                    articleUrl: item.url,
                    force: true,
                  });
                  if (!status?.ok || typeof status.liked !== "boolean")
                    throw new Error("unknown_like_status");
                  consecutiveStatusFailures = 0;
                  if (status.liked) likedCount++;
                  else eligible.push({ ...item, liked: false });
                } catch {
                  // A failed/unknown status is omitted and older posts may
                  // still fill the remaining places.
                  statusFailedCount++;
                  consecutiveStatusFailures++;
                  if (consecutiveStatusFailures >= 10) statusBlocked = true;
                }
                checkedArticles++;
                report("likes", creator);
              }),
            );
            if (statusBlocked) break;
          }
          if (eligible.length >= target) {
            reason = "complete";
            break;
          }
          if (stopped()) {
            reason = "cancelled";
            break;
          }
          if (statusBlocked) {
            reason = "status_failed";
            break;
          }
          // A short page is not a terminal marker. Continue until an empty
          // page, a repeated page (zero new URLs), or the explicit safety cap.
        }
        eligible.sort(newestFirst);
        outcomes[position] = {
          creator,
          reason,
          found: eligible.length,
          target,
        };
        checkedCreators++;
        report("creators", creator);
      }

      async function creatorWorker() {
        while (cursor < creators.length && !stopped()) {
          const position = cursor++;
          await scanCreator(creators[position], position);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(2, creators.length) }, creatorWorker),
      );
      if (!(await verifyAccount())) return accountError();
      if (accountChanged) return accountError();
      const items = groups.flat().filter(Boolean);
      const failedCreators = outcomes
        .filter((outcome) =>
          ["failed", "status_failed"].includes(outcome?.reason),
        )
        .map((outcome) => outcome.creator);
      const limitReachedCreators = outcomes
        .filter((outcome) => outcome?.reason === "limit")
        .map((outcome) => outcome.creator);
      const shortfallCreators = creators.flatMap((creator, position) => {
        const outcome = outcomes[position];
        if (outcome?.found >= target) return [];
        return [outcome || { creator, reason: "cancelled", found: 0, target }];
      });
      const emptyCreators = outcomes
        .filter((outcome) => outcome?.reason === "exhausted" && !outcome.found)
        .map((outcome) => outcome.creator);
      return {
        ok: true,
        owner: expected,
        mode,
        includeLiked,
        items: shuffle(items),
        cancelled: Boolean(token.cancelled),
        partial: Boolean(
          token.cancelled ||
          failedCreators.length ||
          limitReachedCreators.length ||
          statusFailedCount,
        ),
        totalCreators: creators.length,
        checkedCreators,
        candidateCount,
        checkedArticles,
        likedCount,
        statusFailedCount,
        failedCreators,
        emptyCreators,
        limitReachedCreators,
        shortfallCreators,
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
