"use strict";
(() => {
  const native = globalThis.chrome;
  const READER_PATH = "reader/index.html";
  const ACTIVE_READER_KEY = "nero.chrome.activeReader.v1";
  const LOCK_NAME = "nero-reader-runtime";
  const ports = new Set();
  let started,
    settleStarted,
    releaseReader,
    currentTab,
    activeToken,
    cancelEngine;
  let stopped = false;

  // This bus stays inside the packaged reader document. It never registers an
  // externally reachable Chrome message listener and never changes Chrome's
  // native `chrome` or `browser` globals.
  function event() {
    const listeners = new Set();
    return {
      api: Object.freeze({
        addListener(fn) {
          if (typeof fn === "function") listeners.add(fn);
        },
        removeListener(fn) {
          listeners.delete(fn);
        },
        hasListener(fn) {
          return listeners.has(fn);
        },
        hasListeners() {
          return listeners.size > 0;
        },
      }),
      listeners,
      emit(...args) {
        for (const fn of [...listeners]) {
          try {
            fn(...args);
          } catch (error) {
            console.error("Reader event failed", error);
          }
        }
      },
    };
  }
  const onConnect = event(),
    onMessage = event();
  const inactiveClickEvent = Object.freeze({
    addListener() {},
    removeListener() {},
    hasListener() {
      return false;
    },
    hasListeners() {
      return false;
    },
  });
  const readerUrl = () => native.runtime.getURL(READER_PATH);
  const sender = () =>
    Object.freeze({ id: native.runtime.id, url: readerUrl() });

  function connect(options = {}) {
    if (stopped) throw new Error("Reader connection is closed");
    if (!options || typeof options !== "object" || Array.isArray(options))
      throw new TypeError(
        "A local reader connection requires an options object",
      );
    let closed = false;
    const firstMessages = event(),
      secondMessages = event();
    const firstDisconnect = event(),
      secondDisconnect = event();
    const disconnect = () => {
      if (closed) return;
      closed = true;
      ports.delete(disconnect);
      queueMicrotask(() => {
        firstDisconnect.emit(first);
        secondDisconnect.emit(second);
      });
    };
    function endpoint(messages, otherMessages, disconnections, incoming) {
      return Object.freeze({
        name: typeof options.name === "string" ? options.name : "",
        ...(incoming ? { sender: sender() } : {}),
        onMessage: messages.api,
        onDisconnect: disconnections.api,
        postMessage(message) {
          if (closed || stopped) throw new Error("Reader connection is closed");
          const copy = structuredClone(message);
          queueMicrotask(() => {
            if (!closed && !stopped)
              otherMessages.emit(copy, incoming ? first : second);
          });
        },
        disconnect,
      });
    }
    const first = endpoint(
      firstMessages,
      secondMessages,
      firstDisconnect,
      false,
    );
    const second = endpoint(
      secondMessages,
      firstMessages,
      secondDisconnect,
      true,
    );
    ports.add(disconnect);
    // A deferred connection matches native Port ordering: callers can attach
    // their response listener before any backend hello or progress is emitted.
    queueMicrotask(() => {
      if (!closed && !stopped) onConnect.emit(second);
    });
    return first;
  }

  async function sendMessage(message) {
    if (stopped) throw new Error("Reader connection is closed");
    const copy = structuredClone(message);
    for (const listener of [...onMessage.listeners]) {
      let respond,
        responded = false;
      const pendingResponse = new Promise((resolve) => {
        respond = (value) => {
          responded = true;
          resolve(value);
        };
      });
      let result;
      try {
        result = listener(copy, sender(), respond);
      } catch (error) {
        console.error("Reader message failed", error);
        continue;
      }
      if (result === true) return structuredClone(await pendingResponse);
      if (result !== undefined) return structuredClone(await result);
      if (responded) return structuredClone(await pendingResponse);
    }
    throw new Error("No local reader message handler");
  }

  const browser = native?.runtime
    ? Object.freeze({
        storage: native.storage,
        tabs: native.tabs,
        windows: native.windows,
        runtime: Object.freeze({
          id: native.runtime.id,
          getURL: (path) => native.runtime.getURL(path),
          getManifest: () => native.runtime.getManifest(),
          connect,
          sendMessage,
          onConnect: onConnect.api,
          onMessage: onMessage.api,
        }),
        // The real toolbar listener belongs to service-worker.js. The shared
        // Firefox backend registers one too, which is intentionally inert here.
        browserAction: Object.freeze({ onClicked: inactiveClickEvent }),
        action: Object.freeze({ onClicked: inactiveClickEvent }),
      })
    : null;

  // The Chrome build supplies note requests from an existing note tab. Never
  // fall back to the extension page's native fetch when that adapter is absent.
  let noteTransport = null;
  if (
    native?.runtime &&
    typeof globalThis.NeroChromeNoteTransport?.create === "function"
  ) {
    try {
      noteTransport = globalThis.NeroChromeNoteTransport.create(native);
    } catch {
      /* Startup reports an unavailable transport before loading the engine. */
    }
  }
  const noteFetch =
    typeof noteTransport?.fetch === "function"
      ? (input, options) => noteTransport.fetch(input, options)
      : null;

  async function savedReader() {
    try {
      return (await native.storage.session.get(ACTIVE_READER_KEY))[
        ACTIVE_READER_KEY
      ];
    } catch {
      return null;
    }
  }
  async function clearSavedReader() {
    if (!activeToken) return;
    try {
      if ((await savedReader())?.token === activeToken)
        await native.storage.session.remove(ACTIVE_READER_KEY);
    } catch {
      /* The Web Lock, rather than this optional hint, owns exclusivity. */
    }
  }
  async function focusExistingReader() {
    if (!native?.tabs) return false;
    currentTab ||= await native.tabs.getCurrent().catch(() => null);
    const saved = await savedReader();
    let candidate;
    if (Number.isInteger(saved?.tabId) && saved.tabId !== currentTab?.id) {
      try {
        const found = await native.tabs.get(saved.tabId);
        if (found.url === readerUrl()) candidate = found;
      } catch {
        /* A closed or crashed tab can leave a stale session hint. */
      }
    }
    if (!candidate) {
      const all = await native.tabs.query({ url: readerUrl() });
      candidate = all.find(
        (tab) => tab.id !== currentTab?.id && tab.url === readerUrl(),
      );
    }
    if (!candidate || !Number.isInteger(candidate.id)) return false;
    await native.tabs.update(candidate.id, { active: true });
    if (Number.isInteger(candidate.windowId) && candidate.windowId >= 0)
      await native.windows
        ?.update(candidate.windowId, { focused: true })
        .catch(() => {});
    return true;
  }
  function showMessage(title, text, duplicate = false) {
    const panel = document.createElement("div"),
      heading = document.createElement("h1"),
      detail = document.createElement("p");
    panel.className = "chrome-startup";
    heading.textContent = title;
    detail.textContent = text;
    panel.append(heading, detail);
    if (duplicate) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "開いているリーダーへ";
      button.onclick = async () => {
        button.disabled = true;
        try {
          if (!(await focusExistingReader()))
            detail.textContent =
              "開いているリーダーが見つかりません。このタブを再読み込みしてください。";
        } catch {
          detail.textContent =
            "このタブを再読み込みして、もう一度お試しください。";
        } finally {
          button.disabled = false;
        }
      };
      panel.append(button);
    }
    document.body.replaceChildren(panel);
  }
  function loadEngine() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = native.runtime.getURL("reader/engine.js");
      function cleanup() {
        cancelEngine = null;
        globalThis.removeEventListener?.("error", executionError);
      }
      function executionError(error) {
        if (error.filename !== script.src) return;
        cleanup();
        reject(new Error("reader_engine_execution_failed"));
      }
      globalThis.addEventListener("error", executionError);
      cancelEngine = () => {
        cleanup();
        reject(new Error("reader_closed"));
      };
      script.addEventListener(
        "load",
        () => {
          cleanup();
          resolve();
        },
        { once: true },
      );
      script.addEventListener(
        "error",
        () => {
          cleanup();
          reject(new Error("reader_engine_load_failed"));
        },
        { once: true },
      );
      document.head.append(script);
    });
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const disconnect of [...ports]) disconnect();
    cancelEngine?.();
    settleStarted?.({ ok: false, code: "reader_closed" });
    clearSavedReader();
    releaseReader?.();
  }
  function start() {
    if (started) return started;
    started = new Promise((resolve) => {
      settleStarted = resolve;
    });
    if (stopped) {
      settleStarted({ ok: false, code: "reader_closed" });
      return started;
    }
    if (!browser || !globalThis.navigator?.locks?.request) {
      showMessage(
        "リーダーを起動できませんでした",
        "Chromeを最新版に更新し、このタブを再読み込みしてください。",
      );
      stopped = true;
      settleStarted({ ok: false, code: "unsupported_browser" });
      return started;
    }
    if (!noteFetch) {
      showMessage(
        "リーダーを起動できませんでした",
        "拡張機能を読み込み直してから、このタブを再読み込みしてください。",
      );
      stopped = true;
      settleStarted({ ok: false, code: "transport_unavailable" });
      return started;
    }
    Promise.resolve()
      .then(() =>
        navigator.locks.request(
          LOCK_NAME,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              stopped = true;
              showMessage(
                "リーダーは別のタブで開いています",
                "開いているリーダーへ戻ってご利用ください。",
                true,
              );
              settleStarted({ ok: false, code: "reader_already_open" });
              return;
            }
            const lifetime = new Promise((resolve) => {
              releaseReader = resolve;
            });
            try {
              currentTab = await native.tabs.getCurrent().catch(() => null);
              if (stopped) return;
              if (Number.isInteger(currentTab?.id)) {
                activeToken =
                  globalThis.crypto?.randomUUID?.() ||
                  Date.now() + "-" + Math.random();
                await native.storage.session
                  ?.set({
                    [ACTIVE_READER_KEY]: {
                      tabId: currentTab.id,
                      url: readerUrl(),
                      token: activeToken,
                    },
                  })
                  .catch(() => {});
                await native.tabs
                  .update(currentTab.id, { autoDiscardable: false })
                  .catch(() => {});
              }
              if (stopped) return;
              await loadEngine();
              if (stopped) return;
              settleStarted({ ok: true });
              await lifetime;
            } catch {
              const wasStopped = stopped;
              settleStarted({ ok: false, code: "reader_start_failed" });
              stop();
              if (!wasStopped)
                showMessage(
                  "リーダーを起動できませんでした",
                  "拡張機能を読み込み直してから、このタブを再読み込みしてください。",
                );
            } finally {
              await clearSavedReader();
            }
          },
        ),
      )
      .catch(() => {
        settleStarted({ ok: false, code: "reader_start_failed" });
        stop();
        showMessage(
          "リーダーを起動できませんでした",
          "このタブを再読み込みして、もう一度お試しください。",
        );
      });
    return started;
  }
  globalThis.addEventListener("pagehide", stop, { once: true });
  globalThis.addEventListener("pageshow", (event) => {
    if (event.persisted) globalThis.location.reload();
  });
  const platform = {
    browser,
    fetch: noteFetch,
    start,
    focusExistingReader,
    ACTIVE_READER_KEY,
    LOCK_NAME,
  };
  globalThis.NeroChromePlatform = platform;
  platform.ready =
    document.readyState === "loading"
      ? new Promise((resolve) =>
          document.addEventListener(
            "DOMContentLoaded",
            () => start().then(resolve),
            { once: true },
          ),
        )
      : start();
})();
