import fs from "node:fs";
import path from "node:path";
import { writeZipFromDirectory } from "./zip-utils.mjs";

await import("./build-chrome.mjs");
const version = JSON.parse(
  fs.readFileSync("dist/chrome-members/manifest.json", "utf8"),
).version;
const mainTarget = `dist/nero-swipe-reader-${version}-chrome.zip`;
const main = writeZipFromDirectory("dist/chrome-members", mainTarget);
console.log(
  `Created ${main.path} (${main.size} bytes) — Chrome用。解凍してフォルダーを読み込みます。`,
);

const source = "dist/chrome-source";
fs.rmSync(source, { recursive: true, force: true });
function copySource(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink())
    throw new Error("Source archive refuses symlink: " + file);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(file).sort()) {
      if (
        [".git", "node_modules", "dist", "downloads"].includes(name) ||
        name === ".dev.vars" ||
        /^\.env(?:\.|$)/.test(name)
      )
        continue;
      copySource(path.join(file, name));
    }
  } else if (stat.isFile()) {
    const target = path.join(source, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  } else throw new Error("Source archive refuses non-regular file: " + file);
}
for (const file of [
  ".gitignore",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package.json",
  "docs",
  "extension",
  "members",
  "chrome",
  "packed",
  "scripts",
  "tests",
  "src/worker.js",
])
  copySource(file);
fs.writeFileSync(
  source + "/CHROME_BUILD.txt",
  `Prerequisites: Node.js 22+ and npm. No npm dependencies, Git checkout, or external ZIP executable required.\nBuild extension files: node scripts/build-chrome.mjs\nBuild extension and source ZIPs: node scripts/package-chrome.mjs\nOutput: dist/chrome-members/ and dist/nero-swipe-reader-${version}-chrome.zip\nThe stable public manifest key identifies this unpacked extension across updates; it is not a secret signing key.\nChrome business logic runs in the reader tab, and the service worker only opens that tab. Keep the reader tab open during acquisition and sending.\n`,
);
const review = writeZipFromDirectory(
  source,
  `dist/nero-swipe-reader-${version}-chrome-source.zip`,
);
console.log(
  `Created ${review.path} (${review.size} bytes) — Chrome source archive`,
);
