"use strict";
(() => {
  const $ = (id) => document.getElementById(id),
    M = globalThis.NeroMemberModel,
    B = globalThis.NeroArticleBody;
  let port,
    seq = 0,
    owner = "",
    data = M.normalizeData(null, ""),
    rows = [],
    baseRows = [],
    feedSource = "",
    feedResult = null,
    index = 0,
    articleSeq = 0,
    linkedArticle = null,
    articleHistory = [],
    cardObserver = null,
    inbox = [],
    pendingCommentLikes = [],
    pendingLikeVisible = 30,
    unknownReplyCount = 0,
    visible = 30,
    composer = null,
    sending = false,
    scanning = false,
    feeding = false,
    feedSeq = 0,
    feedRequestPosted = false,
    feedCancelled = false;
  const pending = new Map(),
    cardMetadataCache = new Map();
  function notice(text) {
    $("notice").textContent = text;
    $("notice").hidden = !text;
  }
  function connectPort() {
    port = browser.runtime.connect({ name: "NERO_APP_V2" });
    port.onMessage.addListener((m) => {
      const p = pending.get(m.requestId);
      if (!p) return;
      if (m.type === "progress") {
        p.progress?.(m.progress);
        return;
      }
      if (m.type !== "response") return;
      clearTimeout(p.timer);
      pending.delete(m.requestId);
      m.result?.ok
        ? p.resolve(m.result)
        : p.reject(
            Object.assign(
              new Error(m.result?.message || "処理に失敗しました。"),
              { result: m.result },
            ),
          );
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          new Error(
            "拡張との接続が切れました。送信中だった場合はnoteで結果を確認してください。",
          ),
        );
      }
      pending.clear();
      notice("接続が切れました。「再確認」で接続できます。");
    });
  }
  function rpc(action, args = {}, progress, timeout = 30000) {
    if (!port) connectPort();
    return new Promise((resolve, reject) => {
      const id = String(++seq),
        timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              "通信がタイムアウトしました。送信は再試行せずnoteで結果を確認してください。",
            ),
          );
        }, timeout);
      pending.set(id, { resolve, reject, timer, progress });
      try {
        port.postMessage({ type: "request", requestId: id, action, args });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  }
  async function save() {
    if (owner) await browser.storage.local.set({ [M.storageKey(owner)]: data });
  }
  async function health() {
    if (sending || scanning) return;
    $("connect").disabled = true;
    try {
      const h = await rpc("health");
      const noteError = globalThis.NeroChromePlatform ? h.noteError : "";
      // A diagnosis started earlier must not replace the account mid-send.
      if (sending || scanning) return;
      const next = h.noteOk ? h.owner : "";
      if (next !== owner) {
        owner = next;
        data = M.normalizeData(null, owner, null);
        restoreFeedOptions();
        resetFeed();
        inbox = [];
        pendingCommentLikes = [];
        unknownReplyCount = 0;
        renderPendingLikes();
        composer = null;
        $("composer").hidden = true;
        renderArticle();
        if (owner) {
          const stored = (await browser.storage.local.get(M.storageKey(owner)))[
            M.storageKey(owner)
          ];
          data = M.normalizeData(stored, owner);
          restoreFeedOptions();
          await save();
        }
        renderWatch();
        renderInbox();
      }
      $("account").textContent = owner
        ? "接続中 @" + owner
        : noteError
          ? "noteとの接続を確認できません"
          : "noteにログインしてください";
      if (owner) {
        const r = await rpc("inbox_status", { owner });
        inbox = r.items || [];
        renderInbox();
        await refreshPendingLikes();
        notice("");
      } else
        notice(
          noteError ||
            "このブラウザーでnoteにログインしてから「再確認」を押してください。",
        );
    } catch (e) {
      notice(e.message);
    } finally {
      $("connect").disabled = false;
    }
  }
  function requireOwner() {
    if (owner) return true;
    notice("先にnoteにログインして接続を確認してください。");
    return false;
  }
  function button(text, fn) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  }
  function resetFeed() {
    feedSeq++;
    if (feeding) {
      feedCancelled = true;
      if (feedRequestPosted)
        rpc("cancel_job", { kind: "watch_feed" }).catch(() => {});
    }
    rows = [];
    baseRows = [];
    feedSource = "";
    feedResult = null;
    index = 0;
    resetArticleNavigation();
    renderArticle();
    $("feedStatus").textContent =
      "スキ済みを飛ばして1人最大3本を集め、ランダムに表示します。";
  }
  function renderWatch() {
    const list = M.activeList(data);
    $("watchSelect").replaceChildren();
    for (const item of data.lists) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name + "（" + item.users.length + "人）";
      option.selected = item.id === list.id;
      $("watchSelect").append(option);
    }
    $("watchCount").textContent = String(list.users.length);
    renderFeedLabel();
    $("listStatus").textContent =
      `登録 ${list.users.length}人` +
      (list.pending.length ? `・ID未照合 ${list.pending.length}人` : "") +
      " / 全11リスト";
    $("watchList").replaceChildren();
    list.users.forEach((name) => {
      const li = document.createElement("li"),
        label = document.createElement("span");
      label.textContent = "@" + name;
      const remove = button("×", async () => {
        list.users = list.users.filter((x) => x !== name);
        resetFeed();
        await save();
        renderWatch();
      });
      remove.setAttribute("aria-label", name + "を削除");
      li.append(label, remove);
      $("watchList").append(li);
    });
    $("pendingMembers").replaceChildren();
    list.pending.forEach((member, at) => {
      const li = document.createElement("li"),
        label = document.createElement("span");
      label.textContent = member.name + "（ID未照合） ";
      li.append(
        label,
        button("IDを登録", async () => {
          if (!requireOwner()) return;
          const input = prompt(member.name + "さんのnoteユーザーIDまたはURL");
          if (input === null) return;
          const name = M.watchName(input);
          if (!name) {
            notice("noteのユーザーIDまたはURLを確認してください。");
            return;
          }
          if (
            !list.users.includes(name) &&
            list.users.length >= M.MAX_CREATORS
          ) {
            notice("1リストは200人までです。");
            return;
          }
          if (!list.users.includes(name)) list.users.push(name);
          list.pending.splice(at, 1);
          resetFeed();
          await save();
          renderWatch();
        }),
      );
      $("pendingMembers").append(li);
    });
  }
  $("watchSelect").onchange = async () => {
    if (!requireOwner()) return;
    data.activeListId = $("watchSelect").value;
    resetFeed();
    await save();
    renderWatch();
  };
  $("renameList").onclick = async () => {
    if (!requireOwner()) return;
    const list = M.activeList(data),
      name = prompt("リスト名（40文字以内）", list.name);
    if (name === null) return;
    if (!name.trim() || name.trim().length > M.MAX_NAME_LENGTH) {
      notice("リスト名は1〜40文字で入力してください。");
      return;
    }
    list.name = name.trim();
    await save();
    renderWatch();
  };
  $("importList").onclick = () => {
    if (requireOwner()) $("watchFile").click();
  };
  $("watchFile").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const account = owner;
    try {
      if (!requireOwner()) return;
      if (file.size > 128 * 1024)
        throw new Error("リストファイルは128KB以下にしてください。");
      const input = JSON.parse(await file.text());
      if (owner !== account) return;
      const requested = input?.list?.id;
      const targetId = data.lists.some((l) => l.id === requested)
        ? requested
        : data.activeListId;
      data = M.importList(data, input, { targetId, merge: true });
      resetFeed();
      await save();
      renderWatch();
      notice(M.activeList(data).name + "を読み込みました。");
    } catch (e) {
      notice(e.message || "ファイルを読み込めませんでした。");
    } finally {
      e.target.value = "";
    }
  };
  $("exportList").onclick = () => {
    if (!requireOwner()) return;
    const list = M.activeList(data),
      blob = new Blob(
        [
          JSON.stringify(
            { format: "nero-watchlist", version: 1, owner, list },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "nero-watchlist-" + list.id + ".json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $("watchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireOwner()) return;
    const list = M.activeList(data),
      name = M.watchName($("watchInput").value);
    if (!name) {
      notice(
        "noteのユーザー名か、https://note.com/ から始まるURLを入力してください。",
      );
      return;
    }
    if (!list.users.includes(name) && list.users.length >= M.MAX_CREATORS) {
      notice("ウォッチリストは200人まで登録できます。");
      return;
    }
    if (!list.users.includes(name)) list.users.push(name);
    resetFeed();
    await save();
    $("watchInput").value = "";
    renderWatch();
  });
  function restoreFeedOptions() {
    $("feedIncludeLiked").checked = data.feedOptions.includeLiked;
    $("deepIncludeLiked").checked = data.feedOptions.deepIncludeLiked;
    $("deepCreator").value = data.feedOptions.deepCreator;
    $("articleOrder").value = data.feedOptions.articleOrder;
    $("hashtagInput").value = data.feedOptions.hashtag;
    $("hashtagIncludeLiked").checked = data.feedOptions.hashtagIncludeLiked;
    $("hashtagLimit").value = String(data.feedOptions.hashtagLimit);
  }
  $("feedIncludeLiked").onchange = async () => {
    if (!requireOwner()) return;
    data.feedOptions.includeLiked = $("feedIncludeLiked").checked;
    resetFeed();
    await save();
  };
  $("deepIncludeLiked").onchange = async () => {
    if (!requireOwner()) return;
    data.feedOptions.deepIncludeLiked = $("deepIncludeLiked").checked;
    resetFeed();
    await save();
  };
  $("deepCreator").oninput = () => {
    resetFeed();
  };
  $("deepCreator").onchange = async () => {
    resetFeed();
    if (!owner) return;
    data.feedOptions.deepCreator = M.watchName($("deepCreator").value);
    await save();
  };
  function renderFeedLabel() {
    $("readerListName").textContent =
      (feedSource || M.activeList(data).name) +
      " / " +
      M.orderLabel(data.feedOptions.articleOrder);
  }
  function renderFeedStatus() {
    if (!feedResult) return;
    const r = feedResult;
    $("feedStatus").textContent =
      `${r.cancelled ? "中断：" : ""}${rows.length}件を${M.orderLabel(data.feedOptions.articleOrder)}で表示 / ${r.includeLiked ? "スキ済みを含む" : "未スキのみ"}` +
      (!r.includeLiked ? ` / スキ済み ${r.likedCount || 0}件をスキップ` : "") +
      (r.statusFailedCount
        ? ` / スキ状態不明 ${r.statusFailedCount}件を除外`
        : "") +
      (r.failedCreators?.length
        ? ` / 取得失敗 ${r.failedCreators.length}人`
        : "") +
      (r.emptyCreators?.length
        ? ` / 記事なし ${r.emptyCreators.length}人`
        : "") +
      (r.shortfallCreators?.length
        ? ` / 目標本数に満たない人 ${r.shortfallCreators.length}人`
        : "") +
      (r.limitReachedCreators?.length
        ? ` / 探索上限 ${r.limitReachedCreators.length}人（途中結果）`
        : "") +
      (r.mode === "hashtag" ? ` / #${r.hashtag}・上限${r.limit}本` : "") +
      (r.mode === "hashtag" && r.hasMore
        ? " / 未取得の記事が残る可能性があります"
        : "") +
      (r.mode === "hashtag" && r.partial ? " / 途中結果" : "") +
      (r.notFound ? " / タグが見つからないか、公開記事がありません" : "") +
      (r.message ? " / " + r.message : "");
  }
  $("articleOrder").onchange = async () => {
    if (!requireOwner()) return;
    const current = rows[index];
    data.feedOptions.articleOrder = M.articleOrder($("articleOrder").value);
    rows = M.orderArticles(baseRows, data.feedOptions.articleOrder);
    index = Math.max(0, rows.indexOf(current));
    renderFeedLabel();
    renderReaderControls();
    if (!feeding) renderFeedStatus();
    await save();
  };
  $("hashtagInput").oninput = () => resetFeed();
  $("hashtagInput").onchange = async () => {
    resetFeed();
    if (!owner) return;
    data.feedOptions.hashtag = M.hashtagName($("hashtagInput").value);
    await save();
  };
  $("hashtagIncludeLiked").onchange = async () => {
    if (!requireOwner()) return;
    data.feedOptions.hashtagIncludeLiked = $("hashtagIncludeLiked").checked;
    resetFeed();
    await save();
  };
  $("hashtagLimit").onchange = async () => {
    if (!requireOwner()) return;
    const value = Number($("hashtagLimit").value);
    data.feedOptions.hashtagLimit = [50, 100, 200].includes(value)
      ? value
      : 100;
    resetFeed();
    await save();
  };
  async function fetchArticles(mode) {
    if (!requireOwner() || feeding) return;
    const list = M.activeList(data),
      creator = mode === "deep" ? M.watchName($("deepCreator").value) : "",
      hashtag =
        mode === "hashtag" ? M.hashtagName($("hashtagInput").value) : "";
    if (mode === "deep" && !creator) {
      notice(
        "深掘りする人のnoteユーザー名かプロフィールURLを入力してください。",
      );
      return;
    }
    if (mode === "hashtag" && !hashtag) {
      notice("ハッシュタグを1つ入力してください。例：#王子の城下町");
      return;
    }
    if (mode === "watch" && !list.users.length) {
      notice("ユーザーを追加するか、リストファイルを読み込んでください。");
      return;
    }
    const account = owner,
      listId = list.id,
      token = ++feedSeq;
    const includeLiked =
      mode === "deep"
        ? $("deepIncludeLiked").checked
        : mode === "hashtag"
          ? $("hashtagIncludeLiked").checked
          : $("feedIncludeLiked").checked;
    const limitValue = Number($("hashtagLimit").value),
      limit = [50, 100, 200].includes(limitValue) ? limitValue : 100;
    Object.assign(data.feedOptions, {
      includeLiked: $("feedIncludeLiked").checked,
      deepIncludeLiked: $("deepIncludeLiked").checked,
      hashtagIncludeLiked: $("hashtagIncludeLiked").checked,
      hashtagLimit: limit,
    });
    if (mode === "deep") data.feedOptions.deepCreator = creator;
    if (mode === "hashtag") data.feedOptions.hashtag = hashtag;
    const args =
      mode === "deep"
        ? { mode: "deep", creator, expectedAccount: account, includeLiked }
        : mode === "hashtag"
          ? { hashtag, limit, expectedAccount: account, includeLiked }
          : {
              mode: "watch",
              creators: [...list.users],
              expectedAccount: account,
              includeLiked,
            };
    feeding = true;
    feedRequestPosted = false;
    feedCancelled = false;
    for (const id of ["refreshFeed", "deepFetch", "hashtagFetch"])
      $(id).disabled = true;
    $("cancelFeed").hidden = false;
    $("feedProgress").hidden = false;
    rows = [];
    baseRows = [];
    feedResult = null;
    index = 0;
    resetArticleNavigation();
    renderArticle();
    feedSource =
      mode === "deep"
        ? "深掘り：@" + creator
        : mode === "hashtag"
          ? "#" + hashtag
          : list.name;
    renderFeedLabel();
    $("feedStatus").textContent =
      mode === "deep"
        ? "最大50本を探しています…"
        : mode === "hashtag"
          ? `#${hashtag} の記事を最大${limit}本探しています…`
          : "1人最大3本を探しています…";
    try {
      await save();
      if (owner !== account || token !== feedSeq || feedCancelled) return;
      feedRequestPosted = true;
      const r = await rpc(
        mode === "hashtag" ? "hashtag_feed" : "watch_feed",
        args,
        (p) => {
          if (token !== feedSeq) return;
          $("feedStatus").textContent = p.message;
          $("feedProgress").max = Math.max(1, p.total || 1);
          $("feedProgress").value = p.completed || 0;
        },
        3600000,
      );
      if (
        owner !== account ||
        data.activeListId !== listId ||
        token !== feedSeq
      )
        return;
      baseRows = (r.items || []).filter(
        (row) =>
          row && M.articleUrl(row.url) && (includeLiked || row.liked === false),
      );
      rows = M.orderArticles(baseRows, data.feedOptions.articleOrder);
      feedResult = { ...r, includeLiked };
      index = 0;
      renderArticle();
      renderFeedLabel();
      renderFeedStatus();
    } catch (e) {
      if (token === feedSeq) $("feedStatus").textContent = e.message;
    } finally {
      feeding = false;
      feedRequestPosted = false;
      for (const id of ["refreshFeed", "deepFetch", "hashtagFetch"])
        $(id).disabled = false;
      $("cancelFeed").hidden = true;
      $("feedProgress").hidden = true;
    }
  }
  $("refreshFeed").onclick = () => fetchArticles("watch");
  $("deepFetch").onclick = () => fetchArticles("deep");
  $("hashtagFetch").onclick = () => fetchArticles("hashtag");
  $("cancelFeed").onclick = () => {
    if (!feeding) return;
    feedCancelled = true;
    if (!feedRequestPosted) {
      $("feedStatus").textContent = "記事の取得を中断しました。";
      return;
    }
    return rpc("cancel_job", { kind: "watch_feed" }).catch((e) =>
      notice(e.message),
    );
  };
  function safeLink(value) {
    return B.safeUrl(value, "https://note.com/");
  }
  function canonicalArticleUrl(value, key) {
    try {
      const u = new URL(value);
      if (
        u.username ||
        u.password ||
        u.port ||
        u.protocol !== "https:" ||
        u.hostname !== "note.com"
      )
        return "";
      const match = u.pathname.match(
        /^\/([a-zA-Z0-9_-]+)\/n\/(n[a-zA-Z0-9_-]+)\/?$/,
      );
      return match && (!key || match[2] === key)
        ? u.origin + u.pathname.replace(/\/$/, "")
        : "";
    } catch {
      return "";
    }
  }
  function currentArticle() {
    return linkedArticle || rows[index];
  }
  function resetArticleNavigation() {
    linkedArticle = null;
    articleHistory = [];
  }
  function openLinkedArticle(target) {
    const previous = currentArticle();
    const key = String(target?.key || "");
    if (!previous || !requireOwner() || !/^n[a-zA-Z0-9_-]+$/.test(key)) return;
    if (previous.key === key) {
      if (target.hash) scrollToArticleAnchor(target.hash);
      return;
    }
    articleHistory.push({
      linked: linkedArticle,
      scrollTop: $("articleScroll").scrollTop,
    });
    linkedArticle = {
      key,
      url: canonicalArticleUrl(target.url, key),
      urlname: M.watchName(target.urlname),
      name: "リンク先の記事",
    };
    renderArticle({ anchor: target.hash || "" });
  }
  $("articleBack").onclick = () => {
    const previous = articleHistory.pop();
    if (!previous) return;
    linkedArticle = previous.linked;
    renderArticle({ scrollTop: previous.scrollTop });
  };
  function scrollToArticleAnchor(hash) {
    if (!hash) return false;
    const el = document.getElementById(B.anchorId(hash));
    if (!el) return false;
    el.scrollIntoView({ block: "start" });
    return true;
  }
  function applyArticleMetadata(row, result) {
    const canonical = canonicalArticleUrl(result.url, row.key);
    if (canonical) row.url = canonical;
    if (result.title) row.name = result.title;
    if (result.urlname) row.urlname = M.watchName(result.urlname);
    if (result.nickname) row.nickname = result.nickname;
    if (result.publishAt) row.publishAt = result.publishAt;
  }
  function updateArticleHeader(row) {
    $("title").textContent = row.name || "無題の記事";
    $("author").textContent =
      (row.nickname || row.urlname || "") +
      (M.formatPublishAt(row.publishAt)
        ? " · " + M.formatPublishAt(row.publishAt)
        : "");
    const url = canonicalArticleUrl(row.url, row.key);
    $("original").hidden = !url;
    if (url) $("original").href = url;
    else $("original").removeAttribute("href");
    $("articleComment").disabled = !url || !owner;
  }
  function updateArticleStatus(row, token) {
    if (!canonicalArticleUrl(row.url, row.key)) return;
    rpc("note_action", {
      noteAction: "status",
      articleUrl: row.url,
      force: true,
    })
      .then((r) => {
        if (token !== articleSeq) return;
        row.liked = r.liked === true;
        $("like").textContent = row.liked ? "♥ スキ済み" : "♡ スキ";
        $("like").disabled = row.liked;
      })
      .catch(() => {
        if (token === articleSeq) $("like").disabled = false;
      });
  }
  function cardMetadata(key, account) {
    const cacheKey = account + ":" + key;
    const cached = cardMetadataCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60000) return cached.promise;
    const promise = rpc("article", { key })
      .then((r) => ({
        title: r.title,
        description: r.description,
        imageUrl: r.imageUrl,
        url: canonicalArticleUrl(r.url, key),
        nickname: r.nickname,
        urlname: r.urlname,
      }))
      .catch((error) => {
        cardMetadataCache.delete(cacheKey);
        throw error;
      });
    cardMetadataCache.set(cacheKey, { at: Date.now(), promise });
    while (cardMetadataCache.size > 80)
      cardMetadataCache.delete(cardMetadataCache.keys().next().value);
    return promise;
  }
  function hydrateArticleCards(cards, token) {
    const account = owner,
      queued = [];
    let active = 0;
    async function drain() {
      while (active < 2 && queued.length && token === articleSeq) {
        const card = queued.shift();
        active++;
        (async () => {
          try {
            const r = await cardMetadata(card.key, account);
            if (token !== articleSeq || owner !== account) return;
            if (r.title) card.title.textContent = r.title;
            if (r.description) {
              card.description.textContent = r.description;
              card.description.hidden = false;
            }
            card.meta.textContent =
              (r.nickname || r.urlname || "note") + " · リーダーで読む →";
            if (r.url) card.link.href = r.url;
            const image = safeLink(r.imageUrl);
            if (image.startsWith("https://")) {
              card.image.src = image;
              card.image.hidden = false;
              card.image.addEventListener(
                "error",
                () => {
                  card.image.hidden = true;
                },
                { once: true },
              );
            }
          } catch {
            /* The visible URL remains usable if metadata fails. */
          } finally {
            active--;
            drain();
          }
        })();
      }
    }
    if (typeof IntersectionObserver === "function") {
      const byElement = new Map(cards.map((card) => [card.element, card]));
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting || token !== articleSeq) continue;
            observer.unobserve(entry.target);
            queued.push(byElement.get(entry.target));
          }
          drain();
        },
        { root: $("articleScroll"), rootMargin: "240px" },
      );
      cardObserver = observer;
      cards.forEach((card) => observer.observe(card.element));
    } else {
      queued.push(...cards);
      drain();
    }
  }
  function renderReaderControls() {
    const row = currentArticle();
    $("empty").hidden = !!row;
    $("article").hidden = !row;
    $("articleBack").hidden = !articleHistory.length;
    $("position").textContent = rows.length
      ? `${linkedArticle ? "リンク先 · " : ""}${index + 1} / ${rows.length}`
      : "0 / 0";
    $("prev").disabled = !!linkedArticle || !rows.length || index === 0;
    $("next").disabled =
      !!linkedArticle || !rows.length || index === rows.length - 1;
    $("articleHint").textContent = linkedArticle
      ? "リンク先の記事を表示中 / 「リンク元へ戻る」で読んでいた場所へ"
      : "上・下にスワイプ / ↑ ↓ キーで切り替え";
  }
  async function renderArticle({ scrollTop = 0, anchor = "" } = {}) {
    const row = currentArticle(),
      token = ++articleSeq;
    cardObserver?.disconnect();
    cardObserver = null;
    renderReaderControls();
    $("like").disabled = true;
    $("articleComment").disabled = true;
    if (!row) return;
    if (!row.key) row.key = canonicalArticleUrl(row.url).split("/n/")[1] || "";
    updateArticleHeader(row);
    $("body").textContent = "本文を読み込んでいます…";
    $("cover").hidden = true;
    $("articleScroll").scrollTop = 0;
    $("like").textContent = "♡ スキ";
    const initialUrl = canonicalArticleUrl(row.url, row.key);
    if (initialUrl) updateArticleStatus(row, token);
    try {
      const r = await rpc("article", {
        key: row.key || row.url.split("/n/")[1],
      });
      if (token !== articleSeq) return;
      applyArticleMetadata(row, r);
      updateArticleHeader(row);
      if (!initialUrl || initialUrl !== row.url)
        updateArticleStatus(row, token);
      const cards = [];
      $("body").replaceChildren(
        B.render(
          r.body ||
            r.description ||
            row.description ||
            "本文はnoteで確認してください。",
          {
            baseUrl: row.url || "https://note.com/n/" + row.key,
            onArticleLink: (target) => {
              if (token === articleSeq) openLinkedArticle(target);
            },
            onCard: (card) => {
              if (card.key) cards.push(card);
            },
          },
        ),
      );
      const cover = safeLink(r.imageUrl || row.eyecatch);
      if (cover.startsWith("https://")) {
        $("cover").src = cover;
        $("cover").referrerPolicy = "no-referrer";
        $("cover").hidden = false;
      }
      $("articleScroll").scrollTop = scrollTop;
      if (anchor) scrollToArticleAnchor(anchor);
      if (cards.length) hydrateArticleCards(cards, token);
    } catch (e) {
      if (token === articleSeq) {
        $("body").textContent = e.message + " noteで記事を確認してください。";
        $("articleScroll").scrollTop = scrollTop;
      }
    }
  }
  function move(d) {
    if (linkedArticle) return;
    const next = Math.max(0, Math.min(rows.length - 1, index + d));
    if (next === index) return;
    index = next;
    renderArticle();
  }
  $("prev").onclick = () => move(-1);
  $("next").onclick = () => move(1);
  document.addEventListener("keydown", (e) => {
    if (
      /INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName) ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey
    )
      return;
    const el = $("articleScroll");
    if (
      e.key === "ArrowDown" &&
      el.scrollTop + el.clientHeight >= el.scrollHeight - 4
    ) {
      e.preventDefault();
      move(1);
    }
    if (e.key === "ArrowUp" && el.scrollTop <= 4) {
      e.preventDefault();
      move(-1);
    }
  });
  let touch = null;
  $("articleScroll").addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      touch = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        top: e.currentTarget.scrollTop,
      };
    },
    { passive: true },
  );
  $("articleScroll").addEventListener(
    "touchend",
    (e) => {
      if (!touch || !e.changedTouches.length) return;
      const t = e.changedTouches[0],
        el = e.currentTarget;
      if (
        M.canSwipe(
          touch,
          { x: t.clientX, y: t.clientY },
          { top: touch.top, height: el.clientHeight, total: el.scrollHeight },
        )
      )
        move(t.clientY < touch.y ? 1 : -1);
      touch = null;
    },
    { passive: true },
  );
  $("like").onclick = async () => {
    if (!requireOwner()) return;
    const row = currentArticle(),
      token = articleSeq;
    if (!row || !canonicalArticleUrl(row.url, row.key)) return;
    $("like").disabled = true;
    try {
      await rpc(
        "note_action",
        { noteAction: "like", articleUrl: row.url, expectedAccount: owner },
        null,
        45000,
      );
      row.liked = true;
      if (token === articleSeq) $("like").textContent = "♥ スキ済み";
    } catch (e) {
      notice(e.message);
      if (token === articleSeq) $("like").disabled = false;
    }
  };
  function renderInbox() {
    $("inboxCount").textContent = String(inbox.length);
    $("inboxList").replaceChildren();
    inbox.slice(0, visible).forEach((item) => {
      const c = item.comment,
        card = document.createElement("div");
      card.className = "comment-card";
      const title = document.createElement("h3"),
        text = document.createElement("p"),
        meta = document.createElement("p");
      title.textContent = item.articleTitle;
      text.textContent = c.body;
      meta.className = "muted";
      meta.textContent =
        (c.authorName || c.authorUrlname) +
        " · " +
        (c.publishedAt ? new Date(c.publishedAt).toLocaleString("ja-JP") : "");
      card.append(
        title,
        meta,
        text,
        button("返信を書く", () =>
          openComposer({ ...item, replyTarget: c.replyTarget, kind: "reply" }),
        ),
        button("♡ コメントにスキ", (e) =>
          sendCommentLike(item, e.currentTarget),
        ),
        button("記事を読む", () => {
          const url = M.articleUrl(item.articleUrl);
          if (!url) return;
          resetFeed();
          baseRows = [
            { url, key: url.split("/n/")[1], name: item.articleTitle },
          ];
          rows = baseRows.slice();
          feedSource = "返信待ちの記事";
          feedResult = { includeLiked: true };
          index = 0;
          renderArticle();
          renderFeedLabel();
          renderFeedStatus();
        }),
      );
      $("inboxList").append(card);
    });
    $("moreInbox").hidden = inbox.length <= visible;
  }
  function renderPendingLikes(message = "") {
    $("pendingLikesCount").textContent = String(pendingCommentLikes.length);
    $("pendingLikesPanel").hidden =
      !pendingCommentLikes.length && !unknownReplyCount && !message;
    $("pendingLikeStatus").textContent =
      message ||
      (unknownReplyCount
        ? `送信結果が未確認の返信が${unknownReplyCount}件あります。noteで確認してください。`
        : "ここではスキだけを送信します。返信本文は再送しません。");
    $("pendingLikesList").replaceChildren();
    pendingCommentLikes.slice(0, pendingLikeVisible).forEach((item) => {
      const card = document.createElement("div");
      card.className = "comment-card";
      const title = document.createElement("h3"),
        body = document.createElement("p");
      title.textContent =
        (item.replySent ? "返信済み：" : "") +
        (item.articleTitle || "コメントへのスキ");
      body.textContent = item.replyTarget?.body || "";
      const open = document.createElement("a");
      open.href = M.articleUrl(item.articleUrl);
      open.target = "_blank";
      open.rel = "noreferrer noopener";
      open.textContent = "noteで確認 ↗";
      card.append(
        title,
        body,
        button("スキのみ再試行", (e) => sendCommentLike(item, e.currentTarget)),
        open,
      );
      $("pendingLikesList").append(card);
    });
    $("morePendingLikes").hidden =
      pendingCommentLikes.length <= pendingLikeVisible;
  }
  async function refreshPendingLikes() {
    if (!owner) {
      pendingCommentLikes = [];
      unknownReplyCount = 0;
      renderPendingLikes();
      return;
    }
    const account = owner;
    try {
      const result = await rpc("pending_comment_likes", { owner: account });
      if (owner !== account) return;
      pendingCommentLikes = result.items || [];
      unknownReplyCount = result.unknownReplyCount || 0;
      renderPendingLikes();
    } catch (e) {
      if (owner === account) renderPendingLikes(e.message);
    }
  }
  async function sendCommentLike(item, control) {
    if (!requireOwner() || sending) return;
    const account = owner,
      inboxKey = item.inboxKey || item.key;
    sending = true;
    if (control) control.disabled = true;
    try {
      await rpc(
        "comment_like",
        item.id
          ? { owner: account, pendingId: item.id }
          : {
              owner: account,
              articleUrl: item.articleUrl,
              articleTitle: item.articleTitle,
              inboxKey,
              replyTarget: item.replyTarget || item.comment?.replyTarget,
            },
        null,
        45000,
      );
      if (owner !== account) return;
      inbox = inbox.filter((row) => row.key !== inboxKey);
      if (item.replySent && data.uncertain[inboxKey]) {
        delete data.uncertain[inboxKey];
        await save().catch(() => {});
      }
      if (
        composer?.articleUrl === item.articleUrl &&
        composer.replyTarget?.commentKey ===
          (item.replyTarget || item.comment?.replyTarget)?.commentKey
      ) {
        $("composerLikeOnly").hidden = true;
        $("sendStatus").textContent = composer.replySent
          ? "返信とスキを送信しました。"
          : "コメントにスキしました。";
      }
      notice("コメントにスキしました。");
    } catch (e) {
      notice(e.message);
    } finally {
      sending = false;
      if (control) control.disabled = false;
      renderInbox();
      await refreshPendingLikes();
    }
  }
  $("morePendingLikes").onclick = () => {
    pendingLikeVisible += 30;
    renderPendingLikes();
  };
  $("composerLikeOnly").onclick = (e) => {
    if (composer)
      sendCommentLike(
        { ...composer, inboxKey: composer.inboxKey || composer.key },
        e.currentTarget,
      );
  };
  function updateSendLabel() {
    $("send").textContent =
      composer?.kind === "reply"
        ? $("replyLike").checked
          ? "返信＋スキを送信"
          : "返信する"
        : "コメントを送信";
  }
  $("replyLike").onchange = updateSendLabel;
  $("moreInbox").onclick = () => {
    visible += 30;
    renderInbox();
  };
  $("scan").onclick = async () => {
    if (!requireOwner() || scanning) return;
    scanning = true;
    $("scan").disabled = true;
    $("cancelScan").hidden = false;
    $("progress").hidden = false;
    const account = owner;
    try {
      const r = await rpc(
        "inbox_scan",
        { force: $("fullScan").checked },
        (p) => {
          $("scanStatus").textContent =
            p.message + ` / 返信待ち ${p.found || 0}件`;
          $("progress").max = Math.max(1, p.total || 1);
          $("progress").value = p.completed || 0;
        },
        3600000,
      );
      if (owner !== account) return;
      inbox = r.items || [];
      visible = 30;
      renderInbox();
      $("scanStatus").textContent =
        `${r.cancelled ? "中断・途中保存" : "確認完了"}：${r.checkedArticles}記事 / 取得失敗 ${r.failed}件 / 返信待ち ${inbox.length}件`;
    } catch (e) {
      $("scanStatus").textContent = e.message;
    } finally {
      scanning = false;
      $("scan").disabled = false;
      $("cancelScan").hidden = true;
      $("progress").hidden = true;
    }
  };
  $("cancelScan").onclick = () =>
    rpc("cancel_job", { kind: "inbox" }).catch((e) => notice(e.message));
  function openComposer(c) {
    if (sending) {
      notice("送信結果を確認しています。");
      return;
    }
    if (!requireOwner()) return;
    composer = { ...c, owner };
    $("composer").hidden = false;
    $("composerKind").textContent = c.kind === "reply" ? "REPLY" : "COMMENT";
    $("replyLikeOption").hidden = c.kind !== "reply";
    $("replyLike").checked = true;
    $("composerLikeOnly").hidden = true;
    updateSendLabel();
    $("composerTitle").textContent = c.articleTitle || "";
    $("context").textContent = c.comment?.body || "この記事にコメントします。";
    $("draft").value = data.drafts[M.draftKey(c)] || "";
    $("draftCount").textContent = String($("draft").value.length);
    const unknown = !!data.uncertain[M.draftKey(c)];
    $("send").disabled = unknown;
    $("resolveUnknown").hidden = !unknown;
    $("sendStatus").textContent = unknown
      ? "前回の送信結果が未確認です。noteで確認してから操作してください。"
      : "";
    $("draft").focus();
  }
  $("articleComment").onclick = () => {
    const r = currentArticle();
    if (r && canonicalArticleUrl(r.url, r.key))
      openComposer({
        kind: "comment",
        articleUrl: r.url,
        articleTitle: r.name,
      });
  };
  $("draft").oninput = () => {
    if (!composer) return;
    data.drafts[M.draftKey(composer)] = $("draft").value;
    $("draftCount").textContent = String($("draft").value.length);
    save().catch((e) => notice("下書きを保存できませんでした：" + e.message));
  };
  $("closeComposer").onclick = () => {
    if (sending) return;
    $("composer").hidden = true;
    composer = null;
  };
  $("send").onclick = async () => {
    if (!composer || sending || !requireOwner()) return;
    const composerRef = composer,
      sendData = data;
    const c = { ...composer },
      account = c.owner,
      key = M.draftKey(c),
      text = $("draft").value.trim();
    if (!text || text.length > 500) return;
    if (c.owner !== owner || data.uncertain[key]) return;
    sending = true;
    $("send").disabled = true;
    $("draft").disabled = true;
    $("replyLike").disabled = true;
    $("sendStatus").textContent = "送信しています…";
    // Persist BEFORE posting. A closed tab or lost Port must never invite an
    // automatic retry of a comment whose server result is unknown.
    sendData.uncertain[key] = true;
    const saveSendData = () =>
      browser.storage.local.set({ [M.storageKey(account)]: sendData });
    try {
      await saveSendData();
      if (owner !== account || composer !== composerRef)
        throw Object.assign(
          new Error("アカウントが変わったため送信を中断しました。"),
          { result: { code: "account_changed" } },
        );
      const r = await rpc(
        c.kind === "reply" ? "reply_comment" : "note_action",
        c.kind === "reply"
          ? {
              owner: account,
              articleUrl: c.articleUrl,
              articleTitle: c.articleTitle,
              likeComment: $("replyLike").checked,
              comment: text,
              replyTarget: c.replyTarget,
              inboxKey: c.inboxKey || c.key,
            }
          : {
              noteAction: "comment",
              expectedAccount: account,
              articleUrl: c.articleUrl,
              comment: text,
            },
        null,
        45000,
      );
      if (!r.ok) throw new Error("送信結果を確認できませんでした。");
      // A successful reply remains successful when the separate like fails.
      // Clear the text before saving locally so a storage error cannot invite a repost.
      delete sendData.uncertain[key];
      delete sendData.drafts[key];
      if (owner !== account || composer !== composerRef) {
        await saveSendData().catch(() => {});
        return;
      }
      $("draft").value = "";
      $("draftCount").textContent = "0";
      $("resolveUnknown").hidden = true;
      if (c.kind === "reply") {
        composer.replySent = true;
        inbox = inbox.filter((x) => x.key !== c.key);
        renderInbox();
        $("composerLikeOnly").hidden = !r.likePending;
      }
      const message =
        (r.likePending
          ? r.message
          : c.kind === "reply"
            ? r.liked
              ? "返信とスキを送信しました。"
              : "返信しました。"
            : "コメントを送信しました。") +
        (r.receiptSaved === false
          ? " 送信済み情報を端末に保存できませんでした。返信は再送しないでください。"
          : "");
      $("sendStatus").textContent = message;
      notice(message);
      try {
        await saveSendData();
      } catch {
        $("sendStatus").textContent =
          message +
          " 端末の保存情報を更新できませんでした。返信は再送しないでください。";
      }
    } catch (e) {
      const definitive =
        e.result &&
        [
          "account_changed",
          "login_required",
          "invalid_comment",
          "invalid_reply",
          "invalid_comment_target",
          "pending_likes_storage_failed",
          "busy",
          "throttled",
          "comment_api_rejected",
          "comment_acknowledgement",
        ].includes(e.result.code);
      if (definitive) {
        delete sendData.uncertain[key];
        await saveSendData().catch(() => {});
      }
      if (owner === account && composer === composerRef) {
        $("sendStatus").textContent = e.message;
        $("resolveUnknown").hidden = !sendData.uncertain[key];
      }
    } finally {
      sending = false;
      $("draft").disabled = false;
      $("replyLike").disabled = false;
      $("send").disabled = composer
        ? !!data.uncertain[M.draftKey(composer)]
        : false;
      await refreshPendingLikes();
    }
  };
  $("resolveUnknown").onclick = async () => {
    if (!composer) return;
    const link = M.articleUrl(composer.articleUrl);
    if (
      !confirm(
        "noteでコメントの送信結果を確認しましたか？ 送信済みの場合は下書きを消してください。",
      )
    ) {
      if (link) browser.tabs.create({ url: link });
      return;
    }
    delete data.uncertain[M.draftKey(composer)];
    await save();
    $("send").disabled = false;
    $("resolveUnknown").hidden = true;
    $("sendStatus").textContent =
      "確認済み。送信済みの場合は再送しないでください。";
  };
  $("clearData").onclick = async () => {
    if (!requireOwner() || sending || scanning || feeding) return;
    if (
      !confirm(
        "@" +
          owner +
          " のウォッチリスト・下書き・コメントキャッシュを削除しますか？",
      )
    )
      return;
    const all = await browser.storage.local.get(null);
    const markers = Object.keys(all).filter((k) =>
      k.startsWith("nero.members.sent." + owner + "."),
    );
    await browser.storage.local.remove([
      ...markers,
      M.storageKey(owner),
      "nero.app.inbox.v4." + owner,
      "nero.app.priority.v2." + owner,
      "nero.members.commentLikes.v1." + owner,
    ]);
    data = M.normalizeData(null, owner, null);
    restoreFeedOptions();
    inbox = [];
    pendingCommentLikes = [];
    unknownReplyCount = 0;
    renderPendingLikes();
    rows = [];
    baseRows = [];
    feedSource = "";
    feedResult = null;
    resetArticleNavigation();
    composer = null;
    $("composer").hidden = true;
    renderWatch();
    renderInbox();
    renderArticle();
    notice("保存データを削除しました。");
  };
  $("connect").onclick = health;
  connectPort();
  health();
})();
