"use strict";
(() => {
  const A = globalThis.NeroAppApiCore;
  const noteTabMessage =
    "同じChromeでnoteのタブを開き、ログイン後に「再確認」を押してください。";
  const accessMessage =
    "Chromeの拡張機能を再読み込みし、NERO Swipe Readerのサイトへのアクセスでnote.comを許可してから「再確認」を押してください。";
  const invalidMessage =
    "noteの応答を確認できませんでした。noteのタブでログイン状態を確認し、「再確認」を押してください。";

  const record = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value, fallback = "") =>
    typeof value === "string" ? value : fallback;

  function failure(code, message, status) {
    return {
      ok: false,
      owner: "",
      raw: {
        ok: false,
        code,
        ...(Number.isInteger(status) && status >= 100 && status <= 599
          ? { status }
          : {}),
        message,
      },
    };
  }

  function httpFailure(status) {
    const label =
      Number.isInteger(status) && status >= 100 && status <= 599
        ? `（HTTP ${status}）`
        : "";
    if (status === 401)
      return failure("login_required", noteTabMessage + label, status);
    if (status === 403)
      return failure(
        "account_forbidden",
        "noteが接続を拒否しました。noteのタブを開き、ページやアカウントへアクセスできることを確認してから「再確認」を押してください。" +
          label,
        status,
      );
    if (status === 429)
      return failure(
        "account_rate_limited",
        "noteへの確認が多すぎるため、少し待ってから「再確認」を押してください。" +
          label,
        status,
      );
    if (status >= 500)
      return failure(
        "account_server_error",
        "note側でエラーが発生しています。少し待ってから「再確認」を押してください。" +
          label,
        status,
      );
    return failure(
      "account_http_error",
      "noteのログイン状態を確認できませんでした。noteのタブを開いて接続を確認し、もう一度「再確認」を押してください。" +
        label,
      status,
    );
  }

  function transportFailure(error, signal) {
    const code = typeof error?.code === "string" ? error.code : "";
    if (
      signal.aborted ||
      error?.name === "AbortError" ||
      code === "note_request_aborted"
    )
      return failure(
        "account_timeout",
        "noteとの接続がタイムアウトしました。通信状態とnoteのタブを確認してから「再確認」を押してください。",
      );
    if (code === "note_tab_required") return failure(code, noteTabMessage);
    if (
      [
        "note_site_access",
        "note_transport_unavailable",
        "note_page_unavailable",
        "note_request_blocked",
      ].includes(code)
    )
      return failure(code, accessMessage);
    if (code === "note_tab_changed")
      return failure(
        code,
        "noteのタブが閉じられたか、別のページに切り替わりました。noteのタブを開き直して「再確認」を押してください。",
      );
    if (["note_response_too_large", "note_invalid_response"].includes(code))
      return failure(code, invalidMessage);
    return failure(
      "account_network_error",
      "noteとの通信に失敗しました。noteのタブを開いて通信状態を確認し、「再確認」を押してください。",
    );
  }

  function accountRow(payload) {
    // Never combine an outer identity with metadata from another nested user.
    // An explicitly present but invalid wrapper fails closed.
    let row = payload;
    if (!record(row)) return null;
    if (Object.hasOwn(row, "data")) row = row.data;
    if (!record(row)) return null;
    if (Object.hasOwn(row, "user")) row = row.user;
    return record(row) ? row : null;
  }

  A.currentAccount = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      // `fetch` is the lexical note-tab transport supplied to the generated
      // Chrome engine. This module never changes the page's native globals.
      const response = await fetch("https://note.com/api/v2/current_user", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== "boolean")
        return failure("account_invalid_response", invalidMessage);
      if (!response.ok) return httpFailure(response.status);
      let payload;
      try {
        const contentType = response.headers?.get?.("content-type");
        if (
          typeof contentType === "string" &&
          contentType.trim() &&
          !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|\s*$)/i.test(
            contentType.trim(),
          )
        )
          return failure(
            "account_invalid_response",
            invalidMessage,
            response.status,
          );
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError")
          throw error;
        return failure(
          "account_invalid_response",
          invalidMessage,
          response.status,
        );
      }
      const row = accountRow(payload);
      if (
        typeof row?.urlname !== "string" ||
        row.urlname !== row.urlname.trim() ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(row.urlname)
      )
        return failure(
          "account_invalid_response",
          invalidMessage,
          response.status,
        );
      const owner = row.urlname.toLowerCase();
      const followingCount = Number(
        row.followingCount ?? row.following_count ?? 0,
      );
      return {
        ok: true,
        owner,
        raw: {
          ok: true,
          action: "account",
          urlname: owner,
          nickname: text(row.nickname, text(row.name, owner)).slice(0, 200),
          key: text(row.key).slice(0, 200),
          followingCount:
            Number.isFinite(followingCount) && followingCount >= 0
              ? Math.floor(followingCount)
              : 0,
        },
      };
    } catch (error) {
      return transportFailure(error, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };
})();
