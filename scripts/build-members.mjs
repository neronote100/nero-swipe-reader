import fs from "node:fs";
import path from "node:path";
const out = "dist/firefox-members";
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const file of [
  "background.js",
  "app-api-core.js",
  "app-api-inbox.js",
  "app-api-priority.js",
  "app-api-router.js",
])
  fs.copyFileSync("extension/" + file, out + "/" + file);
fs.cpSync("members", out, { recursive: true });
let background = fs.readFileSync(out + "/background.js", "utf8");
background = background.replace(
  "'https://cosmos-invest.github.io/nero-swipe-reader/'",
  "browser.runtime.getURL('reader/index.html')",
);
// Member sessions always resolve the live account. Do not reuse the legacy
// ten-minute identity cache after a user switches note accounts.
background = background.replace(
  "if (!forceRefresh && viewerAccountCache && viewerAccountCache.expiresAt > Date.now()) return viewerAccountCache.value;",
  "/* Always resolve the current member account. */",
);
// The inbox must inspect the complete thread, including replies after item 1000.
background = background.replace(".slice(0, summaryOnly ? 1000 : 2000)", "");
const collectionStart = background.indexOf(
  "async function fetchCommentCollection(",
);
const collectionEnd = background.indexOf(
  "async function fetchNoteComments(",
  collectionStart,
);
if (collectionStart < 0 || collectionEnd < 0)
  throw new Error("Comment pagination patch no longer matches upstream");
background =
  background.slice(0, collectionStart) +
  `async function fetchCommentCollection(noteKey, parentKey) {
  const rows=[],seen=new Set();let page=1;
  for(let round=0;round<10000;round++) {
    if(seen.has(page))throw new Error('Repeated comment page');
    seen.add(page);
    const params=new URLSearchParams({page:String(page),per_page:'100',order:parentKey?'oldest':'newest'});
    if(parentKey)params.set('parent_key',parentKey);
    const payload=await fetchNoteJson('/v3/notes/'+encodeURIComponent(noteKey)+'/note_comments?'+params.toString());
    if(!Array.isArray(payload?.data))throw new Error('Unexpected comment response');
    rows.push(...payload.data);
    const next=Number(payload.next_page);
    if(!next)return rows;
    page=next;
  }
  throw new Error('Comment pagination limit reached; not a complete scan');
}

` +
  background.slice(collectionEnd);
const start = background.indexOf(
  "      const likeResult = await runDirectArticleLikeMutation(articleUrl);",
  background.indexOf("    if (action === 'comment') {"),
);
const end = background.indexOf(
  "    if (action === 'reply_with_like') {",
  start,
);
if (start < 0 || end < 0)
  throw new Error("Member comment patch no longer matches upstream");
background =
  background.slice(0, start) +
  "      return { ...commentResult, commentSent: true };\n    }\n" +
  background.slice(end);
// A feed must not reuse the two-minute cache or guess an unknown like state.
const statusCall = "if (action === 'status') return runStatusApi(articleUrl);";
const statusGuard = "if (!note) throw new Error('missing note');";
if (!background.includes(statusCall) || !background.includes(statusGuard))
  throw new Error("Member status patch no longer matches upstream");
background = background.replace(
  statusCall,
  "if (action === 'status') return runStatusApi(articleUrl, message.force === true);",
);
background = background.replace(
  statusGuard,
  "if (!note || typeof note.is_liked !== 'boolean') throw new Error('unknown like status');",
);
fs.writeFileSync(out + "/background.js", background);
const inbox = fs
  .readFileSync(out + "/app-api-inbox.js", "utf8")
  .replace(
    "if(A.safeOwner(r.viewerUrlname)&&A.safeOwner(r.viewerUrlname)!==owner)",
    "if(A.safeOwner(r.viewerUrlname)!==owner)",
  );
fs.writeFileSync(out + "/app-api-inbox.js", inbox);
const routerPath = out + "/app-api-router.js";
const router = fs.readFileSync(routerPath, "utf8");
const route = "if(action==='article')return A.fetchArticle(args);";
if (!router.includes(route))
  throw new Error("Member feed router patch no longer matches upstream");
fs.writeFileSync(
  routerPath,
  router.replace(
    route,
    "if(action==='watch_feed')return globalThis.NeroMemberFeed.fetch(port,id,args);" +
      "if(action==='hashtag_feed')return globalThis.NeroMemberHashtag.fetch(port,id,args);" +
      "if(action==='comment_like')return globalThis.NeroAppInbox.like(args);" +
      "if(action==='pending_comment_likes')return globalThis.NeroAppInbox.pendingLikes(args.owner);" +
      route,
  ),
);
console.log(path.resolve(out));
