"use strict";
(() => {
  const ALLOWED = new Set([
    "P",
    "BR",
    "DIV",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "UL",
    "OL",
    "LI",
    "BLOCKQUOTE",
    "STRONG",
    "EM",
    "B",
    "I",
    "U",
    "S",
    "A",
    "IMG",
    "FIGURE",
    "FIGCAPTION",
    "PRE",
    "CODE",
    "HR",
    "SPAN",
    "TABLE",
    "THEAD",
    "TBODY",
    "TR",
    "TH",
    "TD",
  ]);
  const DROP = new Set([
    "SCRIPT",
    "STYLE",
    "OBJECT",
    "FORM",
    "NOSCRIPT",
    "SVG",
    "MATH",
    "TEMPLATE",
    "INPUT",
    "BUTTON",
    "SELECT",
    "TEXTAREA",
    "VIDEO",
    "AUDIO",
    "SOURCE",
    "EMBED",
    "LINK",
    "META",
    "BASE",
  ]);
  const KEY = "n[a-zA-Z0-9_-]+";
  const NOTE_ARTICLE = new RegExp("^/([a-zA-Z0-9_-]+)/n/(" + KEY + ")/?$");
  const SHORT_ARTICLE = new RegExp("^/n/(" + KEY + ")/?$");
  const NOTE_EMBED = new RegExp("^/embed/(?:notes/)?(" + KEY + ")/?$");

  function safeUrl(value, baseUrl = "https://note.com/") {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value, baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function articleTarget(value, baseUrl) {
    const href = safeUrl(value, baseUrl);
    if (!href) return null;
    const url = new URL(href);
    if (url.hostname !== "note.com" || url.port) return null;
    const full = url.pathname.match(NOTE_ARTICLE);
    const short = url.pathname.match(SHORT_ARTICLE);
    const embed = url.pathname.match(NOTE_EMBED);
    if (!full && !short && !embed) return null;
    const key = full ? full[2] : (short || embed)[1];
    const urlname = full ? full[1] : "";
    const path = urlname ? "/" + urlname + "/n/" + key : "/n/" + key;
    return {
      url: "https://note.com" + path + url.search + url.hash,
      key,
      urlname,
      hash: url.hash,
    };
  }

  // Only known note embed endpoints are unwrapped. A normal article/profile
  // URL with a `url` query parameter must not become an arbitrary redirect.
  function embedTarget(value, baseUrl, depth = 0) {
    const href = safeUrl(value, baseUrl);
    if (!href) return "";
    const url = new URL(href);
    if (url.hostname === "note.com" && !url.port) {
      const direct = articleTarget(href, baseUrl);
      if (direct) return direct.url;
      if (
        /^\/embed\/(?:links\/?)?$/.test(url.pathname) ||
        url.pathname === "/embed" ||
        url.pathname === "/api/v2/external/external_embed"
      ) {
        if (depth >= 3) return "";
        const target = url.searchParams.get("url");
        return target ? embedTarget(target, baseUrl, depth + 1) : "";
      }
    }
    return href;
  }

  const attr = (node, name) => node.getAttribute?.(name) || "";
  const children = (node) => Array.from(node.childNodes || []);
  const clipped = (value, max = 300) =>
    String(value || "")
      .trim()
      .slice(0, max);
  function find(node, test) {
    for (const child of children(node)) {
      if (child.nodeType !== 1) continue;
      if (test(child)) return child;
      const match = find(child, test);
      if (match) return match;
    }
    return null;
  }
  function fragmentId(value) {
    const id = clipped(value, 200);
    return id && !/[\u0000-\u0020\u007f]/.test(id) ? "nero-article-" + id : "";
  }
  function anchorId(value) {
    let id = String(value || "");
    if (id.startsWith("#")) {
      try {
        id = decodeURIComponent(id.slice(1));
      } catch {
        return "";
      }
    }
    return fragmentId(id);
  }
  function copyId(src, dest) {
    const id = fragmentId(attr(src, "id") || attr(src, "name"));
    if (id) dest.id = id;
  }
  function embedValue(node) {
    const tag = node.tagName;
    if (tag === "IFRAME") return attr(node, "data-src") || attr(node, "src");
    if (!["DIV", "FIGURE"].includes(tag)) return "";
    const value =
      attr(node, "data-url") ||
      attr(node, "data-href") ||
      attr(node, "data-src") ||
      attr(node, "data-embed-src");
    if (value) {
      // Image figures also use lazy data-src. Preserve those as images rather
      // than changing a picture into a link card.
      if (
        tag === "FIGURE" &&
        !attr(node, "data-url") &&
        !attr(node, "data-href") &&
        /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i.test(value) &&
        find(node, (el) => el.tagName === "IMG") &&
        !find(node, (el) => el.tagName === "IFRAME") &&
        !/embed|link.?card|fude-iframe/i.test(attr(node, "class"))
      )
        return "";
      return value;
    }
    if (/embed|link.?card|fude-iframe/i.test(attr(node, "class"))) {
      const link = find(node, (el) => el.tagName === "A" && attr(el, "href"));
      return link ? attr(link, "href") : "";
    }
    return "";
  }

  function render(value, options = {}) {
    const baseUrl =
      safeUrl(options.baseUrl || "https://note.com/") || "https://note.com/";
    const fragment = document.createDocumentFragment();
    const baseArticle = articleTarget(baseUrl);
    function wireLink(link, href) {
      const target = articleTarget(href, baseUrl);
      link.href = target?.url || href;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      if (!target && !new URL(href).hash) return;
      link.onclick = (event) => {
        if (
          event.defaultPrevented ||
          (event.button !== undefined && event.button !== 0) ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const url = new URL(link.href);
        const sameArticle =
          target && baseArticle && target.key === baseArticle.key;
        const sameDocument =
          url.origin + url.pathname + url.search ===
          new URL(baseUrl).origin +
            new URL(baseUrl).pathname +
            new URL(baseUrl).search;
        if (url.hash && (sameArticle || sameDocument)) {
          let id;
          try {
            id = fragmentId(decodeURIComponent(url.hash.slice(1)));
          } catch {
            id = "";
          }
          const destination = id && document.getElementById(id);
          if (destination?.scrollIntoView) {
            event.preventDefault();
            destination.scrollIntoView({ block: "start" });
            return;
          }
        }
        if (target && typeof options.onArticleLink === "function") {
          event.preventDefault();
          return options.onArticleLink(target, event);
        }
      };
    }
    function makeCard(src, href, scope) {
      const target = articleTarget(href, baseUrl);
      const element = document.createElement("a");
      element.className = "article-link-card";
      copyId(src, element);
      wireLink(element, href);
      const copy = document.createElement("div");
      copy.className = "article-link-card-copy";
      const sourceTitle = find(
        scope,
        (el) =>
          /^(?:H[1-6]|STRONG)$/.test(el.tagName) ||
          /(?:^|[-_ ])title(?:$|[-_ ])/i.test(attr(el, "class")),
      );
      const sourceDescription = find(scope, (el) =>
        /description|summary/i.test(attr(el, "class")),
      );
      const title = document.createElement("strong");
      title.className = "article-link-card-title";
      title.textContent =
        clipped(
          attr(src, "data-title") ||
            attr(src, "title") ||
            attr(scope, "data-title") ||
            attr(scope, "title") ||
            sourceTitle?.textContent,
        ) ||
        (target
          ? "noteの記事を読む"
          : new URL(href).hostname + "のリンクを開く");
      const description = document.createElement("span");
      description.className = "article-link-card-description";
      description.textContent = clipped(
        attr(src, "data-description") ||
          attr(scope, "data-description") ||
          sourceDescription?.textContent,
      );
      description.hidden = !description.textContent;
      const meta = document.createElement("span");
      meta.className = "article-link-card-meta";
      meta.textContent = target
        ? "note · Swipe Readerで読む"
        : new URL(href).hostname + " · 外部サイトを開く ↗";
      const image = document.createElement("img");
      image.className = "article-link-card-image";
      const sourceImage = find(scope, (el) => el.tagName === "IMG");
      const imageUrl = safeUrl(
        attr(src, "data-image") ||
          attr(src, "data-thumbnail") ||
          attr(scope, "data-image") ||
          attr(scope, "data-thumbnail") ||
          (sourceImage &&
            (attr(sourceImage, "src") || attr(sourceImage, "data-src"))),
        baseUrl,
      );
      image.hidden = !imageUrl || new URL(imageUrl).protocol !== "https:";
      if (!image.hidden) image.src = imageUrl;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      copy.append(title, description, meta);
      element.append(copy, image);
      options.onCard?.({
        element,
        link: element,
        title,
        description,
        image,
        meta,
        url: target?.url || href,
        key: target?.key || "",
        urlname: target?.urlname || "",
      });
      return element;
    }
    function append(src, parent, scope = src) {
      if (src.nodeType === 3) {
        parent.append(document.createTextNode(src.nodeValue || ""));
        return;
      }
      if (src.nodeType !== 1 || DROP.has(src.tagName)) return;
      const embed = embedValue(src);
      if (embed) {
        const href = embedTarget(embed, baseUrl);
        if (href) {
          const cardScope =
            scope.tagName === "FIGURE" ||
            /embed|link.?card|fude-iframe/i.test(attr(scope, "class"))
              ? scope
              : src;
          parent.append(makeCard(src, href, cardScope));
          if (src.tagName === "FIGURE")
            children(src)
              .filter((el) => el.tagName === "FIGCAPTION")
              .forEach((el) => append(el, parent));
          return;
        }
      }
      if (src.tagName === "IFRAME") return;
      if (!ALLOWED.has(src.tagName)) {
        children(src).forEach((el) => append(el, parent, scope));
        return;
      }
      if (src.tagName === "A") {
        const href = safeUrl(attr(src, "href"), baseUrl);
        if (!href) {
          children(src).forEach((el) => append(el, parent, scope));
          return;
        }
        const link = document.createElement("a");
        wireLink(link, href);
        copyId(src, link);
        children(src).forEach((el) => append(el, link, scope));
        if (
          !clipped(link.textContent) &&
          !find(link, (el) => el.tagName === "IMG")
        )
          link.textContent = href;
        parent.append(link);
        return;
      }
      const element = document.createElement(src.tagName.toLowerCase());
      copyId(src, element);
      if (src.tagName === "IMG") {
        const href = safeUrl(
          attr(src, "src") ||
            attr(src, "data-src") ||
            attr(src, "data-original"),
          baseUrl,
        );
        if (!href || new URL(href).protocol !== "https:") return;
        element.src = href;
        element.alt = clipped(attr(src, "alt"));
        element.loading = "lazy";
        element.referrerPolicy = "no-referrer";
      }
      children(src).forEach((el) =>
        append(el, element, src.tagName === "FIGURE" ? src : scope),
      );
      parent.append(element);
    }
    const text = String(value || "");
    if (!/[<>]/.test(text)) {
      text.split("\n").forEach((line, index) => {
        if (index) fragment.append(document.createElement("br"));
        fragment.append(document.createTextNode(line));
      });
      return fragment;
    }
    const doc = new DOMParser().parseFromString(text, "text/html");
    children(doc.body).forEach((node) => append(node, fragment));
    return fragment;
  }
  globalThis.NeroArticleBody = {
    render,
    safeUrl,
    articleTarget,
    embedTarget,
    fragmentId,
    anchorId,
  };
})();
