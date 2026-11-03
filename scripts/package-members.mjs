import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const version = JSON.parse(
  fs.readFileSync("members/manifest.json", "utf8"),
).version;
const target = `nero-swipe-reader-${version}-unsigned.zip`;
fs.rmSync("dist/" + target, { force: true });
execFileSync("zip", ["-qr", "../" + target, "."], {
  cwd: "dist/firefox-members",
});
console.log(
  "Created dist/" + target + " — Mozilla署名前の開発用パッケージです。",
);
// Include readable, verified materialized sources for Mozilla's source review.
const sourceDir = "dist/mozilla-source";
fs.rmSync(sourceDir, { recursive: true, force: true });
// Explicit source roots also work from Mozilla's extracted source archive,
// which has no .git directory. Never sweep downloads or private roster files.
function copySource(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink())
    throw new Error("Source archive refuses symlink: " + file);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(file).sort()) {
      if (
        ["node_modules", ".git", "dist", "downloads"].includes(name) ||
        name === ".dev.vars" ||
        /^\.env(?:\.|$)/.test(name)
      )
        continue;
      copySource(path.join(file, name));
    }
    return;
  }
  const dest = path.join(sourceDir, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
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
  "packed",
  "scripts",
  "tests",
  "src/worker.js",
])
  copySource(file);
fs.writeFileSync(
  sourceDir + "/MOZILLA_BUILD.txt",
  `Build prerequisites: Node.js 22+, npm, zip. No npm dependencies.\nRun npm run package:members from the source root (a Git checkout is not required).\nInstallable package: dist/nero-swipe-reader-${version}-unsigned.zip\nSource tree includes packed originals and readable materialized JavaScript.\nTo build just the extension files, run npm run build:members.\n`,
);
const sourceTarget = `nero-swipe-reader-${version}-source.zip`;
fs.rmSync("dist/" + sourceTarget, { force: true });
execFileSync("zip", ["-qr", "../" + sourceTarget, "."], { cwd: sourceDir });
console.log(
  "Created dist/" + sourceTarget + " — Mozilla source review archive",
);
