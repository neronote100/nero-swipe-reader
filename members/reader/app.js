"use strict";
(() => {
  const $ = (id) => document.getElementById(id),
    M = globalThis.NeroMemberModel;
  let port,
    seq = 0,
    owner = "",
    data = { watch: [], drafts: {}, uncertain: {} },
    rows = [],
    index = 0,
    articleSeq = 0,
    inbox = [],
    visible = 30,
    composer = null,
    sending = false,
    scanning = false;
  const pending = new Map();
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
      const next = h.noteOk ? h.owner : "";
      if (next !== owner) {
        owner = next;
        data = { watch: [], drafts: {}, uncertain: {} };
        rows = [];
        inbox = [];
        composer = null;
        $("composer").hidden = true;
        renderArticle();
        if (owner) {
          const stored = (await browser.storage.local.get(M.storageKey(owner)))[
            M.storageKey(owner)
          ];
          if (stored) data = { ...data, ...stored };
        }
        renderWatch();
        renderInbox();
      }
      $("account").textContent = owner
        ? "接続中 @" + owner
        : "noteにログインしてください";
      if (owner) {
        const r = await rpc("inbox_status", { owner });
        inbox = r.items || [];
        renderInbox();
        notice("");
      } else
        notice(
          "同じFirefoxでnoteにログインしてから「再確認」を押してください。",
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
  function renderWatch() {
    $("watchCount").textContent = String(data.watch.length);
    $("watchList").replaceChildren();
    data.watch.forEach((name) => {
      const li = document.createElement("li"),
        label = document.createElement("span");
      label.textContent = "@" + name;
      const remove = button("×", async () => {
        data.watch = data.watch.filter((x) => x !== name);
        await save();
        renderWatch();
      });
      remove.setAttribute("aria-label", name + "を削除");
      li.append(label, remove);
      $("watchList").append(li);
    });
  }
  $("watchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireOwner()) return;
    const name = M.watchName($("watchInput").value);
    if (!name) {
      notice(
        "noteのユーザー名か、https://note.com/ から始まるURLを入力してください。",
      );
      return;
    }
    if (data.watch.length >= 200) {
      notice("ウォッチリストは200人まで登録できます。");
      return;
    }
    if (!data.watch.includes(name)) data.watch.push(name);
    await save();
    $("watchInput").value = "";
    renderWatch();
  });
  $("refreshFeed").onclick = async () => {
    if (!requireOwner()) return;
    const account = owner;
    $("refreshFeed").disabled = true;
    $("feedStatus").textContent = "新着記事を取得しています…";
    try {
      const r = await rpc(
        "note_action",
        { noteAction: "creator_latest_batch", creators: data.watch },
        null,
        120000,
      );
      if (owner !== account) return;
      rows = (r.items || [])
        .filter((r) => M.articleUrl(r.url))
        .sort(
          (a, b) =>
            (Date.parse(b.publishAt) || 0) - (Date.parse(a.publishAt) || 0),
        );
      index = 0;
      renderArticle();
      $("feedStatus").textContent =
        `${rows.length}件取得` +
        (r.failed?.length
          ? ` / ${r.failed.length}人は記事なし・取得失敗。再取得できます。`
          : "");
    } catch (e) {
      $("feedStatus").textContent = e.message;
    } finally {
      $("refreshFeed").disabled = false;
    }
  };
  function safeLink(value) {
    try {
      const u = new URL(value, "https://note.com/");
      return u.protocol === "https:" ? u.href : "";
    } catch {
      return "";
    }
  }
  function richBody(value) {
    const fragment = document.createDocumentFragment(),
      doc = new DOMParser().parseFromString(String(value || ""), "text/html");
    const allowed = new Set([
      "P",
      "BR",
      "DIV",
      "H1",
      "H2",
      "H3",
      "H4",
      "UL",
      "OL",
      "LI",
      "BLOCKQUOTE",
      "STRONG",
      "EM",
      "B",
      "I",
      "A",
      "IMG",
      "FIGURE",
      "FIGCAPTION",
      "PRE",
      "CODE",
      "HR",
      "SPAN",
    ]);
    function append(src, parent) {
      if (src.nodeType === 3) {
        parent.append(document.createTextNode(src.nodeValue));
        return;
      }
      if (
        src.nodeType !== 1 ||
        [
          "SCRIPT",
          "STYLE",
          "IFRAME",
          "OBJECT",
          "FORM",
          "NOSCRIPT",
          "SVG",
          "MATH",
        ].includes(src.tagName)
      )
        return;
      if (!allowed.has(src.tagName)) {
        src.childNodes.forEach((n) => append(n, parent));
        return;
      }
      const el = document.createElement(src.tagName);
      if (src.tagName === "A") {
        const url = safeLink(src.getAttribute("href"));
        if (url) {
          el.href = url;
          el.target = "_blank";
          el.rel = "noreferrer noopener";
        }
      }
      if (src.tagName === "IMG") {
        const url = safeLink(
          src.getAttribute("src") || src.getAttribute("data-src"),
        );
        if (!url) return;
        el.src = url;
        el.alt = src.getAttribute("alt") || "";
        el.loading = "lazy";
        el.referrerPolicy = "no-referrer";
      }
      src.childNodes.forEach((n) => append(n, el));
      parent.append(el);
    }
    doc.body.childNodes.forEach((n) => append(n, fragment));
    return fragment;
  }
  async function renderArticle() {
    const row = rows[index],
      token = ++articleSeq;
    $("empty").hidden = !!row;
    $("article").hidden = !row;
    $("position").textContent = rows.length
      ? `${index + 1} / ${rows.length}`
      : "0 / 0";
    $("like").disabled = true;
    $("articleComment").disabled = !row || !owner;
    $("prev").disabled = !rows.length || index === 0;
    $("next").disabled = !rows.length || index === rows.length - 1;
    if (!row) return;
    $("author").textContent =
      (row.nickname || row.urlname || "") +
      " · " +
      (row.publishAt
        ? new Date(row.publishAt).toLocaleDateString("ja-JP")
        : "");
    $("title").textContent = row.name || "無題の記事";
    $("original").href = row.url;
    $("body").textContent = "本文を読み込んでいます…";
    $("cover").hidden = true;
    $("articleScroll").scrollTop = 0;
    $("like").textContent = "♡ スキ";
    rpc("note_action", { noteAction: "status", articleUrl: row.url })
      .then((r) => {
        if (token !== articleSeq) return;
        row.liked = !!r.liked;
        $("like").textContent = row.liked ? "♥ スキ済み" : "♡ スキ";
        $("like").disabled = row.liked;
      })
      .catch(() => {
        if (token === articleSeq) $("like").disabled = false;
      });
    try {
      const r = await rpc("article", {
        key: row.key || row.url.split("/n/")[1],
      });
      if (token !== articleSeq) return;
      $("body").replaceChildren(
        richBody(
          r.body ||
            r.description ||
            row.description ||
            "本文はnoteで確認してください。",
        ),
      );
      const cover = safeLink(r.imageUrl || row.eyecatch);
      if (cover) {
        $("cover").src = cover;
        $("cover").referrerPolicy = "no-referrer";
        $("cover").hidden = false;
      }
    } catch (e) {
      if (token === articleSeq)
        $("body").textContent = e.message + " noteで記事を開けます。";
    }
  }
  function move(d) {
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
    const row = rows[index],
      token = articleSeq;
    if (!row) return;
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
        button("記事を読む", () => {
          const url = M.articleUrl(item.articleUrl);
          if (!url) return;
          rows = [{ url, key: url.split("/n/")[1], name: item.articleTitle }];
          index = 0;
          renderArticle();
        }),
      );
      $("inboxList").append(card);
    });
    $("moreInbox").hidden = inbox.length <= visible;
  }
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
    const r = rows[index];
    if (r)
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
    const c = { ...composer },
      key = M.draftKey(c),
      text = $("draft").value.trim();
    if (!text || text.length > 500) return;
    if (c.owner !== owner || data.uncertain[key]) return;
    sending = true;
    $("send").disabled = true;
    $("draft").disabled = true;
    $("sendStatus").textContent = "送信しています…";
    // Persist BEFORE posting. A closed tab or lost Port must never invite an
    // automatic retry of a comment whose server result is unknown.
    data.uncertain[key] = true;
    try {
      await save();
      const r = await rpc(
        c.kind === "reply" ? "reply_comment" : "note_action",
        c.kind === "reply"
          ? {
              owner,
              articleUrl: c.articleUrl,
              comment: text,
              replyTarget: c.replyTarget,
              inboxKey: c.inboxKey || c.key,
            }
          : {
              noteAction: "comment",
              expectedAccount: owner,
              articleUrl: c.articleUrl,
              comment: text,
            },
        null,
        45000,
      );
      if (!r.ok) throw new Error("送信結果を確認できませんでした。");
      delete data.uncertain[key];
      delete data.drafts[key];
      await save();
      if (c.kind === "reply") {
        inbox = inbox.filter((x) => x.key !== c.key);
        renderInbox();
      }
      $("draft").value = "";
      $("draftCount").textContent = "0";
      $("sendStatus").textContent = "送信しました。";
      notice("送信しました。");
    } catch (e) {
      const definitive =
        e.result &&
        [
          "account_changed",
          "login_required",
          "invalid_comment",
          "invalid_reply",
          "busy",
          "throttled",
          "comment_api_rejected",
          "comment_acknowledgement",
        ].includes(e.result.code);
      if (definitive) {
        delete data.uncertain[key];
        await save();
      }
      $("sendStatus").textContent = e.message;
      $("resolveUnknown").hidden = !data.uncertain[key];
    } finally {
      sending = false;
      $("draft").disabled = false;
      $("send").disabled = !!data.uncertain[key];
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
    if (!requireOwner() || sending || scanning) return;
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
    ]);
    data = { watch: [], drafts: {}, uncertain: {} };
    inbox = [];
    rows = [];
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
