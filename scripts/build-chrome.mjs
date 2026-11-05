import fs from "node:fs";
import path from "node:path";

// Both distributions use the same verified member sources and patches.
await import("./materialize-sources.mjs");
await import("./build-members.mjs");

const firefox = "dist/firefox-members";
const output = "dist/chrome-members";
const memberManifest = JSON.parse(
  fs.readFileSync(firefox + "/manifest.json", "utf8"),
);
const manifest = JSON.parse(fs.readFileSync("chrome/manifest.json", "utf8"));
manifest.version = memberManifest.version;
manifest.name = memberManifest.name;
manifest.description = memberManifest.description;
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output + "/reader", { recursive: true });
for (const file of fs.readdirSync(firefox + "/reader")) {
  if (file === "app.js") continue;
  fs.copyFileSync(firefox + "/reader/" + file, output + "/reader/" + file);
}
for (const file of ["icon.svg", "PRIVACY.md"])
  fs.copyFileSync(firefox + "/" + file, output + "/" + file);
for (const file of [
  "platform.js",
  "note-transport.js",
  "service-worker.js",
  "icon16.png",
  "icon32.png",
  "icon48.png",
  "icon128.png",
]) {
  if (!fs.existsSync("chrome/" + file))
    throw new Error("Chrome runtime file is missing: chrome/" + file);
  fs.copyFileSync("chrome/" + file, output + "/" + file);
}

const engineFiles = memberManifest.background.scripts.flatMap((file) => [
  { label: file, path: firefox + "/" + file },
  ...(file === "member-api.js"
    ? [{ label: "chrome/account.js", path: "chrome/account.js" }]
    : []),
]);
engineFiles.push({ label: "reader/app.js", path: firefox + "/reader/app.js" });
const modules = engineFiles.map(({ label, path: sourcePath }) => {
  let source = fs.readFileSync(sourcePath, "utf8");
  if (label === "background.js") {
    const accountCall = "fetchNoteJson('/v2/current_user', 4000)";
    if (!source.includes(accountCall))
      throw new Error(
        "Chrome account timeout patch no longer matches upstream",
      );
    source = source.replace(
      accountCall,
      "fetchNoteJson('/v2/current_user', 12000)",
    );
  }
  return "\n// Source: " + label + "\n" + source + "\n;\n";
});
// The Chrome platform passes a lexical API facade. Do not overwrite the
// native chrome/browser globals; the same source works before and after
// Chrome introduced its browser namespace.
const engine =
  '(function(browser, fetch) {\n"use strict";\n' +
  modules.join("") +
  "\n})(globalThis.NeroChromePlatform.browser, globalThis.NeroChromePlatform.fetch);\n";
fs.writeFileSync(output + "/reader/engine.js", engine);
const indexPath = output + "/reader/index.html";
const index = fs.readFileSync(indexPath, "utf8");
const appScript = '<script src="app.js"></script>';
if (!index.includes(appScript))
  throw new Error(
    "Reader entry script no longer matches Chrome bootstrap patch",
  );
fs.writeFileSync(
  indexPath,
  index.replace(
    appScript,
    '<script src="../note-transport.js"></script>\n    <script src="../platform.js"></script>',
  ),
);
if (fs.existsSync("docs/CHROME_INSTALL.md"))
  fs.copyFileSync("docs/CHROME_INSTALL.md", output + "/INSTALL.md");
fs.writeFileSync(
  output + "/manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(path.resolve(output));
