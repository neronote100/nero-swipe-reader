"use strict";
(() => {
  const A = globalThis.NeroAppApiCore;
  A.C.VERSION = "0.6.0";
  A.C.EXCLUDE_LIKED_COMMENTS = true;
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
        "comment_like",
      ].includes(action)
    )
      return { ok: false, message: "対応していない操作です。" };
    if (["like", "comment", "comment_like"].includes(action)) {
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
    if (action === "comment_like") {
      // Ignore cached flags: a like must target the specific original comment.
      const result = await original(action, {
        ...args,
        replyTarget: { ...args.replyTarget, liked: false },
      });
      if (result?.ok) return result;
      if (
        result?.status === 409 ||
        [
          "comment_like_result_unknown",
          "comment_like_api_unavailable",
        ].includes(result?.code)
      ) {
        // A lost response or duplicate rejection is not proof of success.
        // Confirm the current viewer's flag with a fresh read, never repost.
        const comments = await original("comments", {
          articleUrl: args.articleUrl,
          summaryOnly: false,
        });
        const account = await original("account");
        const expected = String(args.expectedAccount || "").toLowerCase();
        if (
          account?.ok &&
          account.urlname?.toLowerCase() === expected &&
          comments?.ok &&
          String(comments.viewerUrlname || "").toLowerCase() === expected &&
          comments.comments?.some(
            (c) =>
              String(c.key) === String(args.replyTarget?.commentKey) &&
              c.viewerLiked === true,
          )
        )
          return {
            ok: true,
            action: "comment_like",
            liked: true,
            already: true,
            verified: true,
            source: "note_comments_verified",
          };
      }
      return result;
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
      if (result?.ok) {
        try {
          await browser.storage.local.set({
            [id]: { at: Date.now(), sent: true },
          });
        } catch {
          // The server confirmed the comment. A local receipt failure must
          // never turn that success into an invitation to post it again.
          return { ...result, commentSent: true, receiptSaved: false };
        }
      } else if (
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
