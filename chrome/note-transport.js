"use strict";
(() => {
  const ORIGIN = "https://note.com";
  const MAX_BODY = 65536;
  const MAX_RESPONSE = 8 * 1024 * 1024;
  const TIMEOUT = 12000;
  const ALLOWED_HEADERS = new Set([
    "accept",
    "content-type",
    "x-requested-with",
    "x-ls-disabled",
  ]);
  const GET_PATH =
    /^\/api\/(?:v2\/current_user|v2\/creators\/[a-zA-Z0-9_-]{1,80}(?:\/contents)?|v[23]\/notes\/n[a-zA-Z0-9_-]+(?:\/likes|\/note_comments)?|v3\/searches)$/;
  const POST_PATH =
    /^\/api\/v3\/notes\/n[a-zA-Z0-9_-]+\/(?:likes|note_comments(?:\/[a-zA-Z0-9_-]+\/likes)?)$/;

  function failure(code, message) {
    return Object.assign(new Error(message), { code });
  }
  function aborted() {
    return Object.assign(new Error("noteへの通信を中断しました。"), {
      name: "AbortError",
      code: "note_request_aborted",
    });
  }
  function validTabUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === ORIGIN && !url.username && !url.password;
    } catch {
      return false;
    }
  }
  function prepare(value, options = {}) {
    let url;
    try {
      url = new URL(String(value));
    } catch {
      /* checked below */
    }
    const method = String(options.method || "GET").toUpperCase();
    if (
      !url ||
      url.origin !== ORIGIN ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.href.length > 8192 ||
      !["GET", "POST"].includes(method) ||
      !(method === "GET" ? GET_PATH : POST_PATH).test(url.pathname)
    )
      throw failure(
        "note_request_blocked",
        "許可されていないnoteへの通信を止めました。",
      );
    const headers = {};
    let values;
    try {
      values = new Headers(options.headers || {});
    } catch {
      throw failure(
        "note_request_blocked",
        "noteへの通信ヘッダーを確認できませんでした。",
      );
    }
    for (const [name, text] of values) {
      if (!ALLOWED_HEADERS.has(name) || text.length > 1000)
        throw failure(
          "note_request_blocked",
          "許可されていない通信ヘッダーを止めました。",
        );
      headers[name] = text;
    }
    if (
      headers["content-type"] &&
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        headers["content-type"],
      )
    )
      throw failure(
        "note_request_blocked",
        "許可されていない送信形式を止めました。",
      );
    const body = options.body;
    if (
      body !== undefined &&
      (method !== "POST" ||
        typeof body !== "string" ||
        new TextEncoder().encode(body).length > MAX_BODY)
    )
      throw failure(
        "note_request_blocked",
        "noteへの送信本文を確認できませんでした。",
      );
    return {
      path: url.pathname + url.search,
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    };
  }

  // Chrome serializes this function into the note tab's ISOLATED world. Keep
  // every check and constant inside the function; never use MAIN-world code,
  // read Cookie values, or accept an arbitrary URL from a web page.
  async function pageRequest(input) {
    const resultError = (code, message) => ({ ok: false, code, message });
    const origin = "https://note.com";
    const maxResponse = 8 * 1024 * 1024;
    const maxBody = 65536;
    const getPath =
      /^\/api\/(?:v2\/current_user|v2\/creators\/[a-zA-Z0-9_-]{1,80}(?:\/contents)?|v[23]\/notes\/n[a-zA-Z0-9_-]+(?:\/likes|\/note_comments)?|v3\/searches)$/;
    const postPath =
      /^\/api\/v3\/notes\/n[a-zA-Z0-9_-]+\/(?:likes|note_comments(?:\/[a-zA-Z0-9_-]+\/likes)?)$/;
    const allowed = new Set([
      "accept",
      "content-type",
      "x-requested-with",
      "x-ls-disabled",
    ]);
    if (globalThis.location?.origin !== origin)
      return resultError(
        "note_tab_changed",
        "noteのタブが別のページに移りました。noteを開いて再確認してください。",
      );
    let url;
    try {
      url = new URL(input?.path, origin);
    } catch {
      /* checked below */
    }
    if (
      !input ||
      typeof input.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id) ||
      typeof input.path !== "string" ||
      !input.path.startsWith("/api/") ||
      input.path.length > 8192 ||
      !url ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      !["GET", "POST"].includes(input.method) ||
      !(input.method === "GET" ? getPath : postPath).test(url.pathname)
    )
      return resultError(
        "note_request_blocked",
        "許可されていないnoteへの通信を止めました。",
      );
    // The deadline is minted in the reader before tab lookup or injection.
    // A queued injection must never start a request after its caller timed out,
    // even if the cancellation injection was lost or its tombstone expired.
    if (
      !Number.isFinite(input.expiresAt) ||
      input.expiresAt > Date.now() + 15000
    )
      return resultError(
        "note_request_blocked",
        "通信の有効期限を確認できませんでした。",
      );
    if (input.expiresAt <= Date.now())
      return resultError(
        "note_request_aborted",
        "通信の開始期限を過ぎたため停止しました。",
      );
    if (
      !input.headers ||
      typeof input.headers !== "object" ||
      Array.isArray(input.headers)
    )
      return resultError(
        "note_request_blocked",
        "通信ヘッダーを確認できませんでした。",
      );
    for (const [name, value] of Object.entries(input.headers)) {
      if (
        !allowed.has(name) ||
        typeof value !== "string" ||
        value.length > 1000 ||
        /[\r\n]/.test(value)
      )
        return resultError(
          "note_request_blocked",
          "許可されていない通信ヘッダーを止めました。",
        );
    }
    if (
      input.headers["content-type"] &&
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        input.headers["content-type"],
      )
    )
      return resultError(
        "note_request_blocked",
        "許可されていない送信形式を止めました。",
      );
    if (
      input.body !== undefined &&
      (input.method !== "POST" ||
        typeof input.body !== "string" ||
        new TextEncoder().encode(input.body).length > maxBody)
    )
      return resultError(
        "note_request_blocked",
        "送信本文を確認できませんでした。",
      );
    const cancellations = (globalThis.__neroNoteCancelledV1 ||= new Map());
    for (const [key, until] of cancellations)
      if (until <= Date.now()) cancellations.delete(key);
    if (cancellations.has(input.id)) {
      cancellations.delete(input.id);
      return resultError(
        "note_request_aborted",
        "noteへの通信を中断しました。",
      );
    }
    const registry = (globalThis.__neroNoteRequestsV1 ||= new Map());
    if (registry.has(input.id))
      return resultError(
        "note_request_duplicate",
        "同じ通信を重ねて開始しませんでした。",
      );
    const controller = new AbortController();
    registry.set(input.id, controller);
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(12000, input.expiresAt - Date.now())),
    );
    try {
      if (input.expiresAt <= Date.now())
        return resultError(
          "note_request_aborted",
          "通信の開始期限を過ぎたため停止しました。",
        );
      const response = await fetch(url.href, {
        method: input.method,
        headers: input.headers,
        ...(input.body === undefined ? {} : { body: input.body }),
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (response.url && new URL(response.url).origin !== origin)
        return resultError(
          "note_response_blocked",
          "note以外への転送を止めました。",
        );
      let text = "";
      if (response.body?.getReader) {
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let length = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > maxResponse) {
            await reader.cancel();
            return resultError(
              "note_response_too_large",
              "取得した記事が大きすぎるため停止しました。",
            );
          }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } else {
        text = await response.text();
        if (new TextEncoder().encode(text).length > maxResponse)
          return resultError(
            "note_response_too_large",
            "取得した記事が大きすぎるため停止しました。",
          );
      }
      const headers = {};
      for (const name of [
        "content-type",
        "retry-after",
        "x-ratelimit-reset",
        "ratelimit-reset",
      ]) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      return { ok: true, status: response.status, headers, text };
    } catch (error) {
      return error?.name === "AbortError"
        ? resultError("note_request_aborted", "noteへの通信を中断しました。")
        : resultError(
            "note_page_fetch_failed",
            "noteのページ内で通信できませんでした。noteを表示して再確認してください。",
          );
    } finally {
      clearTimeout(timer);
      registry.delete(input.id);
    }
  }
  function pageAbort(id) {
    if (globalThis.location?.origin !== "https://note.com") return false;
    const controller = globalThis.__neroNoteRequestsV1?.get(id);
    if (controller) {
      controller.abort();
      return true;
    }
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      return false;
    const cancellations = (globalThis.__neroNoteCancelledV1 ||= new Map());
    cancellations.set(id, Date.now() + 30000);
    while (cancellations.size > 256)
      cancellations.delete(cancellations.keys().next().value);
    return true;
  }

  function create(native) {
    let tabId = null,
      sequence = 0,
      selecting,
      readerIncognito;
    let diagnostic = { code: "idle", status: null, message: "" };
    const prefix =
      globalThis.crypto?.randomUUID?.().replaceAll("-", "") ||
      Date.now().toString(36);
    async function chooseTab() {
      if (typeof native.permissions?.contains === "function") {
        let allowed;
        try {
          allowed = await native.permissions.contains({
            permissions: ["scripting"],
            origins: ["https://note.com/*"],
          });
        } catch {
          throw failure(
            "note_site_access",
            "Chrome拡張の権限を確認できません。拡張を再読み込みし、note.comのサイトアクセスを許可してください。",
          );
        }
        if (!allowed)
          throw failure(
            "note_site_access",
            "拡張機能のサイトアクセスでnote.comを許可してから再確認してください。",
          );
      }
      if (
        readerIncognito === undefined &&
        typeof native.tabs.getCurrent === "function"
      ) {
        let reader;
        try {
          reader = await native.tabs.getCurrent();
        } catch {
          /* rejected below */
        }
        if (!reader)
          throw failure(
            "note_transport_unavailable",
            "リーダーの接続元を確認できません。このタブを開き直してください。",
          );
        readerIncognito = reader.incognito === true;
      }
      if (tabId !== null) {
        const pinned = tabId;
        try {
          const tab = await native.tabs.get(pinned);
          if (
            validTabUrl(tab?.url) &&
            (readerIncognito === undefined ||
              (tab.incognito === true) === readerIncognito)
          )
            return pinned;
        } catch {
          /* turn this request into a visible reconnect requirement */
        }
        if (tabId === pinned) tabId = null;
        throw failure(
          "note_tab_changed",
          "接続先のnoteタブが閉じられたか、別のページに移りました。noteを開いて再確認してください。",
        );
      }
      if (selecting) return selecting;
      selecting = (async () => {
        let tabs;
        try {
          tabs = await native.tabs.query({ url: "https://note.com/*" });
        } catch {
          throw failure(
            "note_site_access",
            "拡張機能のサイトアクセスでnote.comを許可してから再確認してください。",
          );
        }
        const matches = tabs.filter(
          (tab) =>
            Number.isInteger(tab.id) &&
            validTabUrl(tab.url) &&
            (readerIncognito === undefined ||
              (tab.incognito === true) === readerIncognito),
        );
        matches.sort(
          (a, b) =>
            Number(b.active === true) - Number(a.active === true) ||
            Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0) ||
            a.id - b.id,
        );
        if (!matches.length)
          throw failure(
            "note_tab_required",
            "同じChromeでnote.comを開いてログインし、そのタブを開いたまま「再確認」を押してください。",
          );
        tabId = matches[0].id;
        return tabId;
      })();
      try {
        return await selecting;
      } finally {
        selecting = null;
      }
    }
    async function noteFetch(value, options = {}) {
      const request = prepare(value, options);
      const signal = options.signal;
      if (signal?.aborted) throw aborted();
      if (!native?.scripting?.executeScript || !native?.tabs?.query)
        throw failure(
          "note_transport_unavailable",
          "Chrome拡張を再読み込みしてから、リーダーを開き直してください。",
        );
      let target,
        rejectAbort,
        settled = false,
        wasCancelled = false;
      const id = prefix + "_" + ++sequence;
      const expiresAt = Date.now() + TIMEOUT;
      const cancelled = new Promise((resolve, reject) => {
        rejectAbort = reject;
      });
      const cancel = () => {
        if (settled) return;
        wasCancelled = true;
        rejectAbort(aborted());
        if (target !== undefined) {
          try {
            Promise.resolve(
              native.scripting.executeScript({
                target: { tabId: target, frameIds: [0] },
                world: "ISOLATED",
                func: pageAbort,
                args: [id],
              }),
            ).catch(() => {});
          } catch {
            /* A navigation or extension reload can invalidate a tab. */
          }
        }
      };
      signal?.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(cancel, TIMEOUT);
      try {
        const operation = (async () => {
          target = await chooseTab();
          if (wasCancelled || signal?.aborted || Date.now() >= expiresAt)
            throw aborted();
          let results;
          try {
            results = await native.scripting.executeScript({
              target: { tabId: target, frameIds: [0] },
              world: "ISOLATED",
              func: pageRequest,
              args: [{ ...request, id, expiresAt }],
            });
          } catch {
            throw failure(
              "note_page_unavailable",
              "noteのタブへ接続できません。note.comのサイトアクセスを許可し、noteを表示して再確認してください。",
            );
          }
          const result = results?.find((entry) => entry.frameId === 0)?.result;
          if (!result?.ok) {
            const error = failure(
              result?.code || "note_page_unavailable",
              result?.message || "noteとの通信結果を確認できませんでした。",
            );
            if (error.code === "note_request_aborted")
              error.name = "AbortError";
            throw error;
          }
          if (
            !Number.isInteger(result.status) ||
            result.status < 200 ||
            result.status > 599 ||
            typeof result.text !== "string" ||
            new TextEncoder().encode(result.text).length > MAX_RESPONSE
          )
            throw failure(
              "note_invalid_response",
              "noteからの応答を確認できませんでした。",
            );
          const response = new Response(
            [204, 205, 304].includes(result.status) ? null : result.text,
            { status: result.status, headers: result.headers },
          );
          diagnostic = {
            code: response.ok ? "note_connected" : "note_http_" + result.status,
            status: result.status,
            contentType: response.headers.get("content-type") || "",
            message: response.ok
              ? ""
              : "noteが通信を受け付けませんでした（HTTP " +
                result.status +
                "）。noteのタブを表示して再確認してください。",
          };
          return response;
        })();
        return await Promise.race([operation, cancelled]);
      } catch (error) {
        diagnostic = {
          code: error.code || "note_transport_failed",
          status: null,
          message: error.message || "noteと通信できませんでした。",
        };
        throw error;
      } finally {
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
      }
    }
    return Object.freeze({
      fetch: noteFetch,
      get diagnostic() {
        return { ...diagnostic };
      },
    });
  }
  globalThis.NeroChromeNoteTransport = Object.freeze({ create });
})();
