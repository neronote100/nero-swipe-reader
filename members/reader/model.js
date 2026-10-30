"use strict";
globalThis.NeroMemberModel = {
  watchName(value) {
    let v = String(value || "")
      .trim()
      .replace(/^@/, "");
    if (/^https?:/.test(v)) {
      try {
        const u = new URL(v);
        if (u.protocol !== "https:" || u.hostname !== "note.com") return "";
        v = u.pathname.split("/")[1];
      } catch {
        return "";
      }
    }
    return /^[a-zA-Z0-9_-]{1,80}$/.test(v) ? v.toLowerCase() : "";
  },
  articleUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === "https:" &&
        u.hostname === "note.com" &&
        /^\/[\w-]+\/n\/n[\w-]+\/?$/.test(u.pathname)
        ? u.origin + u.pathname
        : "";
    } catch {
      return "";
    }
  },
  canSwipe(start, end, scroll) {
    return (
      Math.abs(end.y - start.y) > 85 &&
      Math.abs(end.y - start.y) > Math.abs(end.x - start.x) * 1.8 &&
      (end.y < start.y
        ? scroll.top + scroll.height >= scroll.total - 4
        : scroll.top <= 4)
    );
  },
  storageKey(owner) {
    return "nero.members.v1." + owner.toLowerCase();
  },
  draftKey(c) {
    return c.inboxKey || c.key || c.articleUrl;
  },
};
