#!/usr/bin/env node
/**
 * Minimal ZIP writer (deflate, no external dependency).
 *
 * Node ships zlib but not a zip container, and the only consumer here needs
 * "unzip produces the staged tree" — store nothing, model nothing, just the
 * local-file + central-directory records with correct CRCs.
 *
 * ponytail: no zip64, so a tree over 4 GiB or 65 535 entries fails loudly rather
 * than producing a silently truncated archive. The source pack is ~3 MB; if that
 * changes, switch to a real zip library.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

/** CRC-32 (IEEE 802.3), the checksum ZIP requires per entry. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Write every file under `sourceDir` into a zip at `dest`.
 *
 * @param {string} sourceDir
 * @param {string} dest
 * @param {string} prefix  directory name entries are nested under
 * @returns {number} archive size in bytes
 */
export function zipDirectory(sourceDir, dest, prefix = "zhishi-loom") {
  const files = collect(sourceDir).sort();
  if (files.length > MAX_ENTRIES) throw new Error("zip64_required: too many entries");

  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = `${prefix}/${relative(sourceDir, file).split(sep).join("/")}`;
    const nameBytes = Buffer.from(name, "utf8");
    const raw = readFileSync(file);
    const deflated = deflateRawSync(raw, { level: 9 });
    // `store` when deflate made it bigger (already-compressed media).
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    if (offset + body.length > MAX_BYTES) throw new Error("zip64_required: archive too large");

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBytes, body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(0, 38); // external attrs
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes);

    offset += header.length + nameBytes.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  const archive = Buffer.concat([...local, centralBuf, end]);
  writeFileSync(dest, archive);
  return archive.length;
}

/** SHA-256 of the archive, for the candidate manifest. */
export function zipDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
