import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function directoryFiles(directory) {
  const result = [];
  function visit(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink())
        throw new Error("ZIP refuses symlink: " + file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) {
        const relative = path
          .relative(directory, file)
          .split(path.sep)
          .join("/");
        if (
          !relative ||
          relative.startsWith("/") ||
          relative.split("/").includes("..")
        )
          throw new Error("Invalid ZIP path: " + relative);
        // Git and Windows do not preserve a machine's read/write umask.
        // Keep executable intent while normalizing portable archive modes.
        result.push({
          path: relative,
          file,
          mode: stat.mode & 0o111 ? 0o755 : 0o644,
        });
      } else throw new Error("ZIP refuses non-regular file: " + file);
    }
  }
  visit(directory);
  return result.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

// A deterministic ZIP32 archive needs no external program or npm package.
// File timestamps are fixed so rebuilding unchanged sources creates the same
// archive. UTF-8 names, normal Unix modes, CRCs, and central directory offsets
// are supported by the standard Windows/macOS extractors and browser stores.
export function writeZipFromDirectory(directory, target) {
  const files = directoryFiles(directory);
  if (files.length > 65535)
    throw new Error("ZIP64 is required for this many files");
  const local = [],
    central = [];
  let offset = 0;
  for (const entry of files) {
    const name = Buffer.from(entry.path, "utf8");
    const contents = fs.readFileSync(entry.file);
    const packed = deflateRawSync(contents, { level: 9 });
    if (
      contents.length > 0xffffffff ||
      packed.length > 0xffffffff ||
      name.length > 65535
    )
      throw new Error("File is too large for ZIP32: " + entry.path);
    const checksum = crc32(contents);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(contents.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(contents.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((0o100000 | entry.mode) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    local.push(header, name, packed);
    central.push(record, name);
    offset += header.length + name.length + packed.length;
    if (offset > 0xffffffff) throw new Error("Archive is too large for ZIP32");
  }
  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const archive = Buffer.concat([...local, directoryBytes, end]);
  fs.writeFileSync(target, archive);
  return { path: target, size: archive.length, files: files.length };
}
