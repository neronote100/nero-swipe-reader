import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash, createPublicKey } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  crc32,
  directoryFiles,
  writeZipFromDirectory,
} from "../scripts/zip-utils.mjs";

const root = "dist/chrome-members";
const manifest = JSON.parse(fs.readFileSync(root + "/manifest.json", "utf8"));
const member = JSON.parse(fs.readFileSync("members/manifest.json", "utf8"));
const template = JSON.parse(fs.readFileSync("chrome/manifest.json", "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, member.version);
assert.deepEqual(manifest.permissions, ["storage"]);
assert.deepEqual(manifest.host_permissions, ["https://note.com/*"]);
assert.equal(manifest.browser_specific_settings, undefined);
assert.equal(manifest.browser_action, undefined);
assert.equal(manifest.background.scripts, undefined);
assert.equal(manifest.background.persistent, undefined);
assert.equal(manifest.content_scripts, undefined);
assert.equal(manifest.minimum_chrome_version, "120");
assert.equal(manifest.background.service_worker, "service-worker.js");
assert.equal(manifest.key, template.key);
const publicBytes = Buffer.from(manifest.key, "base64");
assert.ok(
  publicBytes.length > 200,
  "stable unpacked identity requires a complete public key",
);
const publicKey = createPublicKey({
  key: publicBytes,
  format: "der",
  type: "spki",
});
assert.equal(publicKey.asymmetricKeyType, "rsa");
assert.ok(publicKey.asymmetricKeyDetails.modulusLength >= 2048);
const extensionId = createHash("sha256")
  .update(publicBytes)
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (value) =>
    String.fromCharCode(97 + parseInt(value, 16)),
  );
assert.match(extensionId, /^[a-p]{32}$/);
assert.match(
  manifest.content_security_policy.extension_pages,
  /connect-src https:\/\/note\.com(?:;|$)/,
);
assert.match(
  manifest.content_security_policy.extension_pages,
  /frame-src 'none'/,
);
assert.match(
  manifest.content_security_policy.extension_pages,
  /img-src 'self'/,
  "the packaged brand icon must be allowed by image CSP",
);
assert.doesNotMatch(
  manifest.content_security_policy.extension_pages,
  /unsafe-eval|unsafe-inline|script-src[^;]*https:/,
);

for (const [size, file] of Object.entries(manifest.icons)) {
  assert.match(file, /\.png$/);
  const png = fs.readFileSync(root + "/" + file);
  assert.deepEqual(
    png.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  assert.equal(png.readUInt32BE(16), Number(size));
  assert.equal(png.readUInt32BE(20), Number(size));
}
const index = fs.readFileSync(root + "/reader/index.html", "utf8");
assert.match(index, /<script src="\.\.\/platform\.js"><\/script>/);
assert.doesNotMatch(index, /<script src="app\.js">/);
for (const match of index.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
  assert.doesNotMatch(match[1], /^(?:https?:)?\/\//);
  assert.ok(fs.existsSync(path.resolve(root, "reader", match[1])));
}
if (fs.existsSync("docs/CHROME_INSTALL.md"))
  assert.equal(
    fs.readFileSync(root + "/INSTALL.md", "utf8"),
    fs.readFileSync("docs/CHROME_INSTALL.md", "utf8"),
  );
for (const file of ["service-worker.js", "platform.js", "reader/engine.js"]) {
  const source = fs.readFileSync(root + "/" + file, "utf8");
  new vm.Script(source, { filename: file });
  assert.doesNotMatch(source, /\beval\s*\(|new Function\s*\(/);
}
const worker = fs.readFileSync(root + "/service-worker.js", "utf8");
assert.doesNotMatch(
  worker,
  /NeroMemberFeed|NeroAppInbox|fetchNoteJson|\/api\/v3\//,
  "long note jobs must not depend on service worker lifetime",
);
assert.ok(
  fs
    .readFileSync(root + "/reader/engine.js", "utf8")
    .includes("globalThis.NeroMemberFeed"),
);
assert.ok(
  fs
    .readFileSync(root + "/reader/engine.js", "utf8")
    .includes("globalThis.NeroChromePlatform.browser"),
);
for (const file of directoryFiles(root))
  assert.doesNotMatch(
    file.path,
    /(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|downloads(?:\/|$)|node_modules(?:\/|$))|\.(?:pem|key)$/,
  );

// Read the central directory independently of the writer and validate every
// compressed payload, local-header reference, UTF-8 path, size, and CRC.
function readZip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), count);
  const centralOffset = bytes.readUInt32LE(end + 16);
  assert.equal(centralOffset + bytes.readUInt32LE(end + 12), end);
  let cursor = centralOffset;
  const files = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    assert.equal(bytes.readUInt16LE(cursor + 8), 0x800);
    assert.equal(bytes.readUInt16LE(cursor + 10), 8);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const expectedSize = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const extraSize = bytes.readUInt16LE(cursor + 30);
    const commentSize = bytes.readUInt16LE(cursor + 32);
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameSize)
      .toString("utf8");
    assert.ok(!files.has(name));
    assert.ok(!name.startsWith("/") && !name.split("/").includes(".."));
    const localOffset = bytes.readUInt32LE(cursor + 42);
    assert.ok(localOffset < centralOffset);
    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(bytes.readUInt32LE(localOffset + 14), expectedCrc);
    assert.equal(bytes.readUInt32LE(localOffset + 18), compressedSize);
    assert.equal(bytes.readUInt32LE(localOffset + 22), expectedSize);
    const localNameSize = bytes.readUInt16LE(localOffset + 26);
    const localExtraSize = bytes.readUInt16LE(localOffset + 28);
    assert.equal(
      bytes
        .subarray(localOffset + 30, localOffset + 30 + localNameSize)
        .toString("utf8"),
      name,
    );
    const start = localOffset + 30 + localNameSize + localExtraSize;
    const contents = inflateRawSync(
      bytes.subarray(start, start + compressedSize),
    );
    assert.equal(contents.length, expectedSize);
    assert.equal(crc32(contents), expectedCrc);
    files.set(name, contents);
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  assert.equal(cursor, end);
  return files;
}

assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nero-chrome-package-"));
try {
  const first = path.join(scratch, "one.zip"),
    second = path.join(scratch, "two.zip");
  writeZipFromDirectory(root, first);
  writeZipFromDirectory(root, second);
  const bytes = fs.readFileSync(first);
  assert.deepEqual(
    bytes,
    fs.readFileSync(second),
    "identical sources must produce identical ZIP bytes",
  );
  const archived = readZip(bytes);
  assert.ok(
    archived.has("manifest.json"),
    "install package needs a root manifest, without a containing folder",
  );
  assert.ok(archived.has("reader/engine.js"));
  for (const file of directoryFiles(root))
    assert.deepEqual(archived.get(file.path), fs.readFileSync(file.file));
  assert.equal(archived.size, directoryFiles(root).length);

  const fixture = path.join(scratch, "fixture");
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, "導入.txt"), "Chromeへの導入\n");
  fs.writeFileSync(path.join(fixture, "empty"), "");
  writeZipFromDirectory(fixture, first);
  const unicodeZip = readZip(fs.readFileSync(first));
  assert.equal(unicodeZip.get("導入.txt").toString(), "Chromeへの導入\n");
  assert.equal(unicodeZip.get("empty").length, 0);
  fs.chmodSync(path.join(fixture, "導入.txt"), 0o600);
  writeZipFromDirectory(fixture, first);
  fs.chmodSync(path.join(fixture, "導入.txt"), 0o644);
  writeZipFromDirectory(fixture, second);
  assert.deepEqual(
    fs.readFileSync(first),
    fs.readFileSync(second),
    "local umask changes must not change a release archive",
  );
  fs.symlinkSync(path.join(fixture, "empty"), path.join(fixture, "link"));
  assert.throws(() => writeZipFromDirectory(fixture, first), /symlink/);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(
  "chrome-package-check-ok: MV3 manifest, stable ID " +
    extensionId +
    ", minimal permissions, local tab engine, PNG assets, valid deterministic ZIPs",
);
