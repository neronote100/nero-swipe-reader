"use strict";
(() => {
  const READER_URL = chrome.runtime.getURL("reader/index.html");
  const ACTIVE_READER_KEY = "nero.chrome.activeReader.v1";
  let opening;

  async function existingReader() {
    try {
      const saved = (await chrome.storage.session.get(ACTIVE_READER_KEY))[
        ACTIVE_READER_KEY
      ];
      if (Number.isInteger(saved?.tabId)) {
        const tab = await chrome.tabs.get(saved.tabId);
        if (tab.url === READER_URL) return tab;
      }
    } catch {
      /* The optional session hint may outlive a closed reader. */
    }
    const candidates = await chrome.tabs.query({ url: READER_URL });
    return candidates
      .filter((tab) => tab.url === READER_URL)
      .sort((a, b) => a.id - b.id)[0];
  }
  async function openReader() {
    if (opening) return opening;
    opening = (async () => {
      const existing = await existingReader();
      const tab = existing
        ? await chrome.tabs.update(existing.id, { active: true })
        : await chrome.tabs.create({ url: READER_URL, active: true });
      if (Number.isInteger(tab?.id))
        await chrome.tabs
          .update(tab.id, { autoDiscardable: false })
          .catch(() => {});
      if (Number.isInteger(tab?.windowId) && tab.windowId >= 0)
        await chrome.windows
          .update(tab.windowId, { focused: true })
          .catch(() => {});
      return tab;
    })();
    try {
      return await opening;
    } finally {
      opening = null;
    }
  }
  // Register synchronously on every worker wake. Long note jobs run in the
  // reader document; worker suspension cannot terminate those jobs.
  chrome.action.onClicked.addListener(() => {
    openReader().catch(() => {});
  });
})();
