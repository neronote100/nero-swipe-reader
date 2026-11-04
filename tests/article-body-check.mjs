// Exercise the real renderer using DOM-shaped fixtures. The adapter intentionally
// does not parse HTML; browser parsing/layout remains an explicit real-device
// check. Fixtures represent note's iframe/data-src embed variants, not snapshots
// of renderer output. This test has no npm or live-note dependency.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class Element {
  constructor(tagName, attributes = {}, childNodes = []) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.attributes = attributes;
    this.childNodes = childNodes;
    this._text = "";
    this.hidden = false;
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  get textContent() {
    return (
      this._text +
      this.childNodes
        .map((node) => node.textContent ?? node.nodeValue ?? "")
        .join("")
    );
  }
  set textContent(value) {
    this._text = String(value);
    this.childNodes = [];
  }
  append(...nodes) {
    this.childNodes.push(...nodes);
  }
  scrollIntoView(options) {
    this.scrollOptions = options;
  }
}
const text = (value) => ({ nodeType: 3, nodeValue: value, textContent: value });
const el = (tag, attrs = {}, ...nodes) =>
  new Element(
    tag,
    attrs,
    nodes.flat().map((node) => (typeof node === "string" ? text(node) : node)),
  );
const descendants = (node) => [
  node,
  ...(node.childNodes || []).flatMap(descendants),
];
const byTag = (root, tag) =>
  descendants(root).filter((node) => node.tagName === tag.toUpperCase());
const byClass = (root, name) =>
  descendants(root).filter((node) => node.className === name);
const fixtures = new Map();
let displayed = null;
const document = {
  createDocumentFragment: () => ({
    nodeType: 11,
    childNodes: [],
    append(...nodes) {
      this.childNodes.push(...nodes);
    },
  }),
  createElement: (tag) => el(tag),
  createTextNode: text,
  getElementById: (id) => descendants(displayed).find((node) => node.id === id),
};
let parses = 0;
const context = vm.createContext({
  document,
  URL,
  DOMParser: class {
    parseFromString(markup, type) {
      parses++;
      assert.equal(type, "text/html");
      assert.ok(
        fixtures.has(markup),
        "an explicit source DOM fixture is required",
      );
      return { body: el("body", {}, ...fixtures.get(markup)) };
    }
  },
});
vm.runInContext(fs.readFileSync("members/reader/body.js", "utf8"), context);
const B = context.NeroArticleBody;
const baseUrl = "https://note.com/author/n/narticle?from=reader";
function render(markup, nodes, options = {}) {
  fixtures.set(markup, nodes);
  displayed = B.render(markup, { baseUrl, ...options });
  return displayed;
}
function event(extra = {}) {
  return {
    button: 0,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...extra,
  };
}

// URL classification is exact about host, protocol, credentials, path, and keys.
assert.equal(
  B.safeUrl("../n/nother", baseUrl),
  "https://note.com/author/n/nother",
);
assert.equal(B.safeUrl("http://example.com/path"), "http://example.com/path");
for (const unsafe of [
  "",
  "javascript:alert(1)",
  "data:text/html,x",
  "file:///tmp/a",
  "https://name:secret@note.com/author/n/nother",
  "https://name@example.com/",
])
  assert.equal(B.safeUrl(unsafe), "");
assert.equal(B.articleTarget("https://note.com/other/n/n123").key, "n123");
assert.equal(
  B.articleTarget("http://note.com/other/n/n123").url,
  "https://note.com/other/n/n123",
);
assert.equal(B.articleTarget("https://note.com/n/n123#part").urlname, "");
for (const href of [
  "https://note.com.evil.test/other/n/n123",
  "https://note.com:8080/other/n/n123",
  "https://note.com/other",
  "https://note.com/other/n/bad-article",
  "https://name@note.com/other/n/n123",
])
  assert.equal(B.articleTarget(href), null);
for (const href of [
  "https://note.com/embed/n123",
  "https://note.com/embed/notes/n123",
  "/embed/notes/n123",
])
  assert.equal(B.embedTarget(href, baseUrl), "https://note.com/n/n123");
assert.equal(
  B.embedTarget(
    "https://note.com/embed/links?url=https%3A%2F%2Fexample.com%2Fhello%3Fx%3D1",
  ),
  "https://example.com/hello?x=1",
);
assert.equal(
  B.embedTarget(
    "https://note.com/embed/links?url=https%3A%2F%2Fnote.com%2Fother%2Fn%2Fn123",
  ),
  "https://note.com/other/n/n123",
);
assert.equal(
  B.embedTarget("https://note.com/embed/links?url=javascript%3Aalert(1)"),
  "",
);
const ordinary = "https://note.com/other/n/n123?url=https%3A%2F%2Fevil.test";
assert.equal(
  B.embedTarget(ordinary),
  ordinary,
  "normal note URLs are not redirect endpoints",
);
assert.equal(
  B.embedTarget("https://note.com/other?url=https%3A%2F%2Fevil.test"),
  "https://note.com/other?url=https%3A%2F%2Fevil.test",
);
assert.equal(B.anchorId("#chapter%20one"), "");
assert.equal(B.anchorId("#chapter%2Done"), "nero-article-chapter-one");
assert.equal(B.anchorId("#%E0%A4%A"), "");

// Plain text retains line breaks and does not depend on HTML parsing.
{
  const before = parses;
  const output = B.render("first\nsecond");
  assert.equal(parses, before);
  assert.equal(byTag(output, "br").length, 1);
  assert.equal(
    descendants(output)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.nodeValue)
      .join(""),
    "firstsecond",
  );
}

// Ordinary note links stay readable and route internally; modified clicks keep
// browser behavior. External links (including HTTP) only use the browser.
{
  const navigations = [];
  const output = render(
    '<p>read <a href="../n/nother">another</a> <a href="http://example.com">outside</a></p>',
    [
      el(
        "p",
        { id: "intro", onclick: "danger()", style: "display:none" },
        "read ",
        el("a", { href: "../n/nother", onclick: "danger()" }, "another"),
        el(
          "a",
          { href: "http://example.com/path", target: "_self" },
          "outside",
        ),
        el(
          "a",
          { href: "javascript:danger()" },
          el("strong", {}, "visible unsafe label"),
        ),
        el("img", {
          src: "https://images.example/picture.jpg",
          onerror: "danger()",
          alt: "a picture",
        }),
        el("script", {}, "script payload"),
        el("style", {}, "style payload"),
        el("svg", {}, el("a", { href: "https://example.com" }, "hidden svg")),
        el("form", {}, "hidden form"),
        el("iframe", { srcdoc: "danger()", src: "javascript:danger()" }),
      ),
    ],
    { onArticleLink: (target) => navigations.push(target) },
  );
  const links = byTag(output, "a");
  assert.equal(links.length, 2);
  assert.equal(links[0].href, "https://note.com/author/n/nother");
  assert.equal(links[0].rel, "noreferrer noopener");
  const click = event();
  links[0].onclick(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(navigations[0].key, "nother");
  for (const extra of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    const click = event(extra);
    links[0].onclick(click);
    assert.equal(click.defaultPrevented, false);
  }
  assert.equal(navigations.length, 1);
  assert.equal(links[1].href, "http://example.com/path");
  assert.equal(links[1].target, "_blank");
  assert.equal(links[1].onclick, undefined);
  const p = byTag(output, "p")[0];
  assert.equal(p.id, "nero-article-intro");
  assert.equal(p.onclick, undefined);
  assert.equal(p.style, undefined);
  assert.match(p.textContent, /visible unsafe label/);
  assert.doesNotMatch(
    p.textContent,
    /script payload|style payload|hidden svg|hidden form/,
  );
  assert.equal(byTag(output, "iframe").length, 0);
  const image = byTag(output, "img")[0];
  assert.equal(image.src, "https://images.example/picture.jpg");
  assert.equal(image.onerror, undefined);
  assert.equal(image.referrerPolicy, "no-referrer");
}

// Note's current data-src wrapper, plural /embed/notes path, iframe variant,
// key-only URL, metadata callback, and figure captions all survive rendering.
{
  const cards = [],
    navigations = [];
  const output = render(
    '<figure><div class="fude-iframe" data-src="https://note.com/embed/notes/ncard"></div></figure>',
    [
      el(
        "figure",
        {
          "data-title": "Related title",
          "data-description": "A useful summary",
          "data-image": "https://images.example/cover.jpg",
        },
        el("div", {
          class: "fude-iframe",
          "data-src": "https://note.com/embed/notes/ncard",
        }),
        el("figcaption", {}, "A caption"),
      ),
      el(
        "figure",
        {},
        el("iframe", { src: "/embed/nsecond", title: "Second article" }),
      ),
      el("figure", {
        "data-src": "/embed/notes/nthird",
        "data-title": "Third article",
      }),
    ],
    {
      onCard: (card) => cards.push(card),
      onArticleLink: (target) => navigations.push(target),
    },
  );
  assert.equal(cards.length, 3);
  assert.equal(cards[0].title.textContent, "Related title");
  assert.equal(cards[0].description.textContent, "A useful summary");
  assert.equal(cards[0].image.src, "https://images.example/cover.jpg");
  assert.equal(cards[0].image.hidden, false);
  assert.equal(cards[0].urlname, "");
  assert.equal(cards[0].key, "ncard");
  assert.equal(cards[0].url, "https://note.com/n/ncard");
  assert.equal(cards[0].link, cards[0].element);
  assert.equal(cards[1].title.textContent, "Second article");
  assert.equal(cards[2].key, "nthird");
  assert.equal(byClass(output, "article-link-card").length, 3);
  assert.equal(byTag(output, "iframe").length, 0);
  assert.equal(byTag(output, "figcaption")[0].textContent, "A caption");
  const click = event();
  cards[0].link.onclick(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(navigations[0].key, "ncard");
  // The parent hydrates the same nodes rather than receiving unsafe HTML.
  cards[0].title.textContent = "<img onerror=danger()>";
  assert.equal(byTag(cards[0].title, "img").length, 0);
}

// External embed wrappers unwrap to the actual site; scripts/iframe players
// never execute. Already-expanded cards preserve text and thumbnail metadata.
{
  const cards = [];
  const output = render(
    '<iframe src="https://note.com/embed/links?url=https%3A%2F%2Fexample.com%2Fstory"></iframe>',
    [
      el("iframe", {
        src: "https://note.com/embed/links?url=https%3A%2F%2Fexample.com%2Fstory",
        title: "Outside story",
      }),
      el(
        "figure",
        {
          class: "embed-link-card",
          "data-url": "https://outside.example/post",
        },
        el(
          "a",
          { href: "https://outside.example/post" },
          el("strong", {}, "Existing title"),
          el("span", { class: "description" }, "Existing summary"),
          el("img", { src: "https://images.example/existing.jpg" }),
        ),
      ),
      el("iframe", { src: "https://video.example/embed/a" }),
      el("iframe", {
        src: "https://note.com/embed/links?url=data%3Atext%2Fhtml%2Cbad",
      }),
    ],
    { onCard: (card) => cards.push(card) },
  );
  assert.equal(cards.length, 3);
  assert.equal(cards[0].url, "https://example.com/story");
  assert.equal(cards[0].title.textContent, "Outside story");
  assert.equal(cards[0].key, "");
  assert.equal(cards[0].link.target, "_blank");
  assert.equal(cards[0].link.onclick, undefined);
  assert.equal(cards[1].title.textContent, "Existing title");
  assert.equal(cards[1].description.textContent, "Existing summary");
  assert.equal(cards[1].image.src, "https://images.example/existing.jpg");
  assert.equal(cards[2].url, "https://video.example/embed/a");
  assert.equal(byTag(output, "iframe").length, 0);
}

// Image figures remain images; empty visible links receive a usable label.
{
  const cards = [];
  const output = render(
    '<figure data-src="https://images.example/photo.jpg"><img data-src="https://images.example/photo.jpg"></figure>',
    [
      el(
        "figure",
        { "data-src": "https://images.example/photo.jpg" },
        el("img", {
          "data-src": "https://images.example/photo.jpg",
          alt: "photo",
        }),
      ),
      el("a", { href: "https://example.com/empty" }),
      el("img", { src: "http://images.example/insecure.jpg" }),
    ],
    { onCard: (card) => cards.push(card) },
  );
  assert.equal(cards.length, 0);
  assert.equal(byTag(output, "img").length, 1);
  assert.equal(byTag(output, "a")[0].textContent, "https://example.com/empty");
}

// In-document links use prefixed IDs without clobbering the extension's own
// controls; a same-article anchor scrolls instead of opening/fetching a page.
{
  let navigations = 0;
  const output = render(
    '<h2 id="part">Part</h2><a href="#part">jump</a>',
    [el("h2", { id: "part" }, "Part"), el("a", { href: "#part" }, "jump")],
    { onArticleLink: () => navigations++ },
  );
  const heading = byTag(output, "h2")[0];
  const click = event();
  byTag(output, "a")[0].onclick(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(heading.scrollOptions.block, "start");
  assert.equal(navigations, 0);
}
console.log(
  "article-body-check-ok: note/external cards, internal routing, safe URLs, modifiers, sanitization, captions, images, anchors",
);
