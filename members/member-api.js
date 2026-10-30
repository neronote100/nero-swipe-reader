"use strict";
(() => {
  const A = globalThis.NeroAppApiCore;
  A.C.VERSION = "0.2.0";
  A.isReaderPort = (port) =>
    port?.sender?.id === browser.runtime.id &&
    port.sender.url === browser.runtime.getURL("reader/index.html");
  const original = A.noteAction;
  let commentBusy = false;
  A.noteAction = async (action, args = {}) => {
    if (
      ![
        "account",
        "search",
        "status",
        "comments",
        "creator_articles",
        "creator_latest_batch",
        "like",
        "comment",
      ].includes(action)
    )
      return { ok: false, message: "対応していない操作です。" };
    if (["like", "comment"].includes(action)) {
      const acc = await original("account");
      if (
        !acc?.ok ||
        !args.expectedAccount ||
        acc.urlname.toLowerCase() !== String(args.expectedAccount).toLowerCase()
      )
        return {
          ok: false,
          code: "account_changed",
          message:
            "ログイン中のアカウントが変わりました。接続を確認してください。",
        };
    }
    if (action !== "comment") return original(action, args);
    if (commentBusy)
      return {
        ok: false,
        code: "busy",
        message: "前のコメントを送信しています。",
      };
    const text = String(args.comment || "").trim();
    if (!text || text.length > 500 || !A.safeArticleUrl(args.articleUrl))
      return {
        ok: false,
        code: "invalid_comment",
        message: "記事と1〜500文字の本文を確認してください。",
      };
    commentBusy = true;
    try {
      const fingerprint = JSON.stringify([
        String(args.expectedAccount).toLowerCase(),
        args.articleUrl,
        args.replyTarget?.key || "",
        text,
      ]);
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(fingerprint),
      );
      const id =
        "nero.members.sent." +
        A.safeOwner(args.expectedAccount) +
        "." +
        Array.from(new Uint8Array(hash), (x) =>
          x.toString(16).padStart(2, "0"),
        ).join("");
      const markers = await browser.storage.local.get(null);
      const expired = Object.keys(markers).filter(
        (k) =>
          k.startsWith("nero.members.sent.") &&
          Date.now() - Number(markers[k]?.at || 0) >= 86400000,
      );
      if (expired.length) await browser.storage.local.remove(expired);
      const previous = (await browser.storage.local.get(id))[id];
      if (previous && Date.now() - previous.at < 86400000)
        return previous.sent
          ? { ok: true, commentSent: true, already: true }
          : {
              ok: false,
              code: "comment_result_unknown",
              message:
                "同じコメントの送信結果が未確認です。noteで確認してください。24時間は重複送信を防止します。",
            };
      await browser.storage.local.set({
        [id]: { at: Date.now(), sent: false },
      });
      // The server result may be unknown after a network failure. Keep the
      // durable marker across tabs and background restarts in that case.
      const result = await original(action, args);
      if (result?.ok)
        await browser.storage.local.set({
          [id]: { at: Date.now(), sent: true },
        });
      else if (
        [
          "login_required",
          "invalid_comment",
          "busy",
          "throttled",
          "comment_api_rejected",
          "comment_acknowledgement",
        ].includes(result?.code)
      )
        await browser.storage.local.remove(id);
      return result;
    } finally {
      commentBusy = false;
    }
  };
  browser.browserAction.onClicked.addListener(() =>
    browser.tabs.create({ url: browser.runtime.getURL("reader/index.html") }),
  );
})();
