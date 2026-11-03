"use strict";
(() => {
  const A = globalThis.NeroAppApiCore;
  const I = globalThis.NeroAppInbox;
  const scanInbox = I.scan;
  const QUEUE_PREFIX = "nero.members.commentLikes.v1.";
  const MAX_PENDING = 500;
  let scanRunning = false;
  let mutationRunning = false;

  I.scan = async (...args) => {
    if (scanRunning)
      return {
        ok: false,
        code: "busy",
        message: "コメントを取得中です。完了または中断を待ってください。",
      };
    scanRunning = true;
    try {
      return await scanInbox(...args);
    } finally {
      scanRunning = false;
    }
  };

  function ownerName(value) {
    const name = String(value || "").trim();
    return /^[a-zA-Z0-9_-]{1,80}$/.test(name) ? name.toLowerCase() : "";
  }
  function identifier(value) {
    return typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value)
      ? value
      : "";
  }
  function articleUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" &&
        url.hostname === "note.com" &&
        /^\/[a-zA-Z0-9_-]+\/n\/n[a-zA-Z0-9_-]+\/?$/.test(url.pathname)
        ? url.origin + url.pathname.replace(/\/$/, "")
        : "";
    } catch {
      return "";
    }
  }
  function targetFrom(value, needsCommentKey) {
    if (!value || typeof value !== "object") return null;
    const key = identifier(value.key || value.rootKey);
    const commentKey = identifier(value.commentKey);
    const authorUrlname = ownerName(value.authorUrlname);
    const body = String(value.body || "").trim();
    if (!key || !authorUrlname || !body || (needsCommentKey && !commentKey))
      return null;
    return {
      key,
      rootKey: identifier(value.rootKey) || key,
      commentKey,
      authorUrlname,
      authorName: String(value.authorName || "").slice(0, 160),
      body: body.slice(0, 1000),
      publishedAt: String(value.publishedAt || "").slice(0, 80),
      depth: value.depth ? 1 : 0,
      rootAuthorUrlname: ownerName(value.rootAuthorUrlname),
      rootBody: String(value.rootBody || "").slice(0, 1000),
      // Do not let a stale cached flag short-circuit a requested note mutation.
      liked: false,
    };
  }
  function accountError() {
    return {
      ok: false,
      code: "account_changed",
      message: "ログイン中のアカウントが変わりました。接続を確認してください。",
    };
  }
  async function accountMatches(owner) {
    try {
      const account = await A.currentAccount();
      return account?.ok === true && ownerName(account.owner) === owner;
    } catch {
      return false;
    }
  }
  function invalidTarget() {
    return {
      ok: false,
      code: "invalid_comment_target",
      message: "対象コメントを選び直してください。",
    };
  }
  function queueKey(owner) {
    return QUEUE_PREFIX + owner;
  }
  async function loadQueue(owner) {
    const stored = await browser.storage.local.get(queueKey(owner));
    const value = stored[queueKey(owner)];
    if (
      !value ||
      value.owner !== owner ||
      !value.items ||
      typeof value.items !== "object" ||
      Array.isArray(value.items)
    )
      return { version: 1, owner, items: {} };
    // The comment sender saves its durable receipt before returning success.
    // Recover a combined operation even if the tab/event page closed in the
    // tiny interval before its queue record advanced to like_pending.
    const recoverable = Object.values(value.items).filter(
      (item) =>
        item &&
        item.stage !== "like_pending" &&
        typeof item.receiptKey === "string" &&
        item.receiptKey.startsWith("nero.members.sent." + owner + ".") &&
        /^[a-f0-9]{64}$/.test(item.receiptKey.split(".").pop()),
    );
    if (recoverable.length) {
      const receipts = await browser.storage.local.get(
        recoverable.map((item) => item.receiptKey),
      );
      let changed = false;
      for (const item of recoverable) {
        if (receipts[item.receiptKey]?.sent === true) {
          item.stage = "like_pending";
          item.replySent = true;
          changed = true;
        }
      }
      if (changed) await saveQueue(owner, value);
    }
    return value;
  }
  async function saveQueue(owner, value) {
    await browser.storage.local.set({ [queueKey(owner)]: value });
  }
  function pendingId(url, target) {
    return url + "|" + target.commentKey;
  }
  async function receiptKey(owner, url, target, comment) {
    const fingerprint = JSON.stringify([owner, url, target.key, comment]);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(fingerprint),
    );
    return (
      "nero.members.sent." +
      owner +
      "." +
      Array.from(new Uint8Array(hash), (x) =>
        x.toString(16).padStart(2, "0"),
      ).join("")
    );
  }
  async function putPending(owner, url, target, args, stage, replySent) {
    const queue = await loadQueue(owner),
      id = pendingId(url, target);
    if (!queue.items[id] && Object.keys(queue.items).length >= MAX_PENDING)
      throw new Error(
        "スキ未完了の保存件数が上限です。先に未完了のスキを確認してください。",
      );
    const previous = queue.items[id];
    const item = {
      id,
      articleUrl: url,
      articleTitle: String(
        args.articleTitle || previous?.articleTitle || "",
      ).slice(0, 300),
      replyTarget: target,
      inboxKey: String(args.inboxKey || previous?.inboxKey || "").slice(
        0,
        2500,
      ),
      createdAt: Number(previous?.createdAt) || Date.now(),
      stage,
      replySent: replySent === true || previous?.replySent === true,
      reason: String(args.reason || "").slice(0, 500),
      receiptKey: String(args.receiptKey || previous?.receiptKey || ""),
    };
    queue.items[id] = item;
    await saveQueue(owner, queue);
    return item;
  }
  async function clearPending(owner, id) {
    const queue = await loadQueue(owner);
    delete queue.items[id];
    await saveQueue(owner, queue);
  }
  async function removeHandled(owner, inboxKey) {
    try {
      await I.remove(owner, inboxKey);
      return true;
    } catch {
      return false;
    }
  }
  function partialReply(result, pending, likeResult, saved = true) {
    return {
      ok: true,
      replySent: true,
      commentSent: true,
      liked: false,
      likeRequested: true,
      partial: true,
      likePending: true,
      pendingId: pending?.id || "",
      pendingSaved: saved,
      commentResult: result,
      likeResult,
      message:
        "返信は送信済みですが、コメントへのスキを完了できませんでした。返信は再送せず「スキのみ再試行」を使ってください。" +
        (saved ? "" : " 未完了情報を端末に保存できませんでした。"),
    };
  }
  async function sendLike(owner, url, target) {
    if (!(await accountMatches(owner))) return accountError();
    try {
      return await A.noteAction("comment_like", {
        articleUrl: url,
        replyTarget: target,
        expectedAccount: owner,
      });
    } catch {
      return {
        ok: false,
        code: "comment_like_result_unknown",
        message:
          "コメントへのスキの結果を確認できませんでした。スキのみ再試行できます。",
      };
    }
  }
  async function settleLike(owner, pending, result) {
    const cacheSaved = await removeHandled(owner, pending.inboxKey);
    let pendingSaved = true;
    try {
      await clearPending(owner, pending.id);
    } catch {
      pendingSaved = false;
    }
    return {
      ...result,
      ok: true,
      liked: true,
      likePending: false,
      cacheSaved,
      pendingSaved,
    };
  }

  I.pendingLikes = async (ownerValue) => {
    // Reading may promote a receipt-backed placeholder and save the queue.
    // Serialize this recovery with mutations across every reader tab.
    if (mutationRunning)
      return {
        ok: false,
        code: "busy",
        message: "コメント操作中です。完了後にスキ未完了を再確認してください。",
      };
    const owner = ownerName(ownerValue);
    if (!owner) return accountError();
    mutationRunning = true;
    try {
      if (!(await accountMatches(owner))) return accountError();
      const queue = await loadQueue(owner);
      const values = Object.values(queue.items);
      return {
        ok: true,
        owner,
        items: values
          .filter(
            (item) =>
              item?.stage === "like_pending" &&
              articleUrl(item.articleUrl) &&
              targetFrom(item.replyTarget, true),
          )
          .sort((a, b) => Number(b.createdAt) - Number(a.createdAt)),
        unknownReplyCount: values.filter(
          (item) =>
            item?.stage === "reply_pending" || item?.stage === "reply_unknown",
        ).length,
      };
    } catch {
      return {
        ok: false,
        code: "pending_likes_storage_failed",
        message: "スキ未完了の保存情報を読み込めませんでした。",
      };
    } finally {
      mutationRunning = false;
    }
  };

  I.like = async (args = {}) => {
    if (mutationRunning)
      return {
        ok: false,
        code: "busy",
        message: "前のコメント操作を処理しています。",
      };
    const owner = ownerName(args.owner);
    if (!owner) return accountError();
    mutationRunning = true;
    try {
      if (!(await accountMatches(owner))) return accountError();
      let source = args;
      if (args.pendingId) {
        const stored = (await loadQueue(owner)).items[String(args.pendingId)];
        if (!stored || stored.stage !== "like_pending") return invalidTarget();
        source = {
          ...stored,
          ...args,
          articleUrl: stored.articleUrl,
          replyTarget: stored.replyTarget,
          inboxKey: stored.inboxKey,
        };
      }
      const url = articleUrl(source.articleUrl),
        target = targetFrom(source.replyTarget, true);
      if (!url || !target) return invalidTarget();
      const pending = await putPending(
        owner,
        url,
        target,
        source,
        "like_pending",
        source.replySent,
      );
      const result = await sendLike(owner, url, target);
      if (!result?.ok) {
        try {
          await putPending(
            owner,
            url,
            target,
            { ...source, reason: result?.message || "スキ未完了" },
            "like_pending",
            pending.replySent,
          );
        } catch {}
        return {
          ...(result || { ok: false }),
          liked: false,
          likePending: true,
          pendingId: pending.id,
        };
      }
      return await settleLike(owner, pending, result);
    } catch (error) {
      return {
        ok: false,
        code: "pending_likes_storage_failed",
        message: String(
          error?.message || "スキ未完了の情報を保存できませんでした。",
        ),
      };
    } finally {
      mutationRunning = false;
    }
  };
  I.retryLike = I.like;

  I.reply = async (args = {}) => {
    if (mutationRunning)
      return {
        ok: false,
        code: "busy",
        message: "前のコメント操作を処理しています。",
      };
    const owner = ownerName(args.owner),
      url = articleUrl(args.articleUrl);
    const withLike = args.likeComment !== false;
    const target = targetFrom(args.replyTarget, withLike);
    const comment = String(args.comment || "").trim();
    if (!owner || !url || !target) return invalidTarget();
    if (!comment || comment.length > 500)
      return {
        ok: false,
        code: "invalid_comment",
        message: "返信は1〜500文字で入力してください。",
      };
    mutationRunning = true;
    let pending = null;
    let replied = null;
    let previousPending = null;
    try {
      if (!(await accountMatches(owner))) return accountError();
      // A durable placeholder is saved BEFORE posting, so a tab closure cannot
      // erase all evidence of an in-flight combined operation. Only confirmed
      // replies advance to like_pending and become eligible for like-only retry.
      if (withLike) {
        args = {
          ...args,
          receiptKey: await receiptKey(owner, url, target, comment),
        };
        previousPending =
          (await loadQueue(owner)).items[pendingId(url, target)] || null;
        pending =
          previousPending ||
          (await putPending(owner, url, target, args, "reply_pending", false));
      }
      try {
        replied = await A.noteAction("comment", {
          articleUrl: url,
          comment,
          replyTarget: target,
          expectedAccount: owner,
        });
      } catch {
        replied = {
          ok: false,
          code: "comment_result_unknown",
          message:
            "返信の送信結果を確認できませんでした。自動再送はしていません。noteで確認してください。",
        };
      }
      const sent =
        replied?.ok === true ||
        replied?.replySent === true ||
        replied?.commentSent === true;
      if (!sent) {
        if (pending && !previousPending) {
          const uncertain = [
            "comment_result_unknown",
            "comment_api_unavailable",
          ].includes(replied?.code);
          try {
            if (uncertain)
              await putPending(
                owner,
                url,
                target,
                { ...args, reason: replied.message },
                "reply_unknown",
                false,
              );
            else await clearPending(owner, pending.id);
          } catch {}
        }
        return (
          replied || {
            ok: false,
            code: "comment_result_unknown",
            message: "返信結果を確認できませんでした。",
          }
        );
      }
      const cacheSaved = await removeHandled(owner, args.inboxKey);
      if (!withLike)
        return {
          ...replied,
          ok: true,
          replySent: true,
          commentSent: true,
          liked: false,
          likeRequested: false,
          cacheSaved,
        };
      try {
        pending = await putPending(
          owner,
          url,
          target,
          args,
          "like_pending",
          true,
        );
      } catch {
        // Never misreport a successfully posted reply as unsent, even if the
        // local queue becomes unavailable between the two network operations.
        return partialReply(
          replied,
          pending,
          { ok: false, code: "pending_likes_storage_failed" },
          false,
        );
      }
      const liked = await sendLike(owner, url, target);
      if (!liked?.ok) {
        try {
          await putPending(
            owner,
            url,
            target,
            { ...args, reason: liked?.message || "スキ未完了" },
            "like_pending",
            true,
          );
        } catch {}
        return partialReply(replied, pending, liked);
      }
      const settled = await settleLike(owner, pending, liked);
      return {
        ...replied,
        ok: true,
        replySent: true,
        commentSent: true,
        liked: true,
        likeRequested: true,
        likePending: false,
        pendingSaved: settled.pendingSaved,
        cacheSaved: cacheSaved && settled.cacheSaved,
        likeResult: liked,
      };
    } catch (error) {
      if (replied?.ok || replied?.replySent || replied?.commentSent)
        return partialReply(
          replied,
          pending,
          { ok: false, code: "pending_likes_storage_failed" },
          false,
        );
      return {
        ok: false,
        code: "pending_likes_storage_failed",
        message: String(
          error?.message ||
            "送信前の保存に失敗しました。返信は送っていません。",
        ),
      };
    } finally {
      mutationRunning = false;
    }
  };
})();
