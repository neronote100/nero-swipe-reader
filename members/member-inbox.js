"use strict";
const scanInbox = globalThis.NeroAppInbox.scan;
let memberScanRunning = false;
globalThis.NeroAppInbox.scan = async (...args) => {
  if (memberScanRunning)
    return {
      ok: false,
      code: "busy",
      message: "コメントを取得中です。完了または中断を待ってください。",
    };
  memberScanRunning = true;
  try {
    return await scanInbox(...args);
  } finally {
    memberScanRunning = false;
  }
};
globalThis.NeroAppInbox.reply = async (args) => {
  const A = globalThis.NeroAppApiCore;
  if (!args.replyTarget?.key || !args.owner)
    return { ok: false, message: "返信先を選び直してください。" };
  const result = await A.noteAction("comment", {
    articleUrl: args.articleUrl,
    comment: args.comment,
    replyTarget: args.replyTarget,
    expectedAccount: args.owner,
  });
  if (result?.ok)
    await globalThis.NeroAppInbox.remove(args.owner, args.inboxKey);
  return result;
};
