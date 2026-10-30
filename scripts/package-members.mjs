import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const target = "nero-swipe-reader-0.2.0-unsigned.zip";
fs.rmSync("dist/" + target, { force: true });
execFileSync("zip", ["-qr", "../" + target, "."], {
  cwd: "dist/firefox-members",
});
console.log(
  "Created dist/" + target + " — Mozilla署名前の開発用パッケージです。",
);
// Include readable, verified materialized sources for Mozilla's source review.
const sourceDir="dist/mozilla-source";
fs.rmSync(sourceDir,{recursive:true,force:true});
const tracked=execFileSync("git",["ls-files","-z"],{encoding:"utf8"}).split("\0").filter(Boolean);
for(const file of [...tracked,"extension/background.js","extension/note-bridge.js","extension/reader-bridge.js","src/worker.js"]){
  const dest=path.join(sourceDir,file);
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.copyFileSync(file,dest);
}
fs.writeFileSync(sourceDir+"/MOZILLA_BUILD.txt","Build prerequisites: Node.js 22+, npm, git, zip. No npm dependencies.\nRun npm run package:members from the repository root.\nInstallable package: dist/nero-swipe-reader-0.2.0-unsigned.zip\nSource tree includes packed originals and readable materialized JavaScript.\nIf using this source archive without .git, run npm run build:members, then zip the contents of dist/firefox-members.\n");
const sourceTarget="nero-swipe-reader-0.2.0-source.zip";
fs.rmSync("dist/"+sourceTarget,{force:true});
execFileSync("zip",["-qr","../"+sourceTarget,"."],{cwd:sourceDir});
console.log("Created dist/"+sourceTarget+" — Mozilla source review archive");
