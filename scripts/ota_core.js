'use strict';

/**
 * ota_core — shared OTA validation + publishing logic.
 *
 * Used by scripts/publish_ota.js (CLI, manifest-driven) and server.js
 * (web upload/install, image-driven). One implementation of the rules:
 *   - ESP32-S3 application image: magic 0xE9, chip id 0x0009
 *   - size ≤ 0x3f0000 (OTA partition budget)
 *   - immutable release store: <ota-dir>/releases/<version>/firmware.bin
 *   - manifest.json written LAST via atomic tmp+rename, never before its binary
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OTA_SIZE_CAP = 0x3f0000;
const OTA_SEMVER = /^\d+\.\d+\.\d+$/;
const ESP32S3_CHIP_ID = 0x0009;
const APP_DESC_OFFSET = 0x20; // complete image header 0x18 + first segment header 0x08
const APP_DESC_MAGIC = 0xABCD5432;

const sha256hex = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** Basic ESP32-S3 application image checks (header level, shared with the CLI). */
function validateImageHeader(buf, sizeCap = OTA_SIZE_CAP) {
  if (!Buffer.isBuffer(buf)) return { ok: false, error: 'not a buffer' };
  if (buf.length < 0x18) return { ok: false, error: 'file too small to contain an ESP32 image header' };
  if (buf[0] !== 0xE9) return { ok: false, error: 'not an ESP-IDF application image (magic byte is not 0xE9)' };
  if (buf.readUInt16LE(12) !== ESP32S3_CHIP_ID) {
    return { ok: false, error: `chip id 0x${buf.readUInt16LE(12).toString(16).padStart(4, '0')} is not ESP32-S3 (0x0009)` };
  }
  if (buf.length > sizeCap) {
    return { ok: false, error: `size ${buf.length} exceeds the 0x${sizeCap.toString(16)} OTA cap` };
  }
  return { ok: true };
}

/**
 * Parse the ESP-IDF app descriptor (version + project name) from the image.
 * Returns null when the descriptor is absent or malformed. Do not scan for a
 * magic value elsewhere: the descriptor must be in the first segment.
 */
function parseImageMeta(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < APP_DESC_OFFSET + 256) return null;
  const firstSegmentSize = buf.readUInt32LE(28);
  if (firstSegmentSize < 256 || firstSegmentSize > buf.length - APP_DESC_OFFSET) return null;
  // readUInt32LE stays unsigned even when the magic has bit 31 set.
  if (buf.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC) return null;
  const cstr = (start, len) => {
    const bytes = buf.subarray(start, start + len);
    const nul = bytes.indexOf(0);
    return nul < 0 ? null : bytes.subarray(0, nul).toString('utf8');
  };
  const version = cstr(APP_DESC_OFFSET + 16, 32);
  const project = cstr(APP_DESC_OFFSET + 48, 32);
  return version && project ? { version, project } : null;
}

/** Walk segment headers safely and verify the ESP image's XOR checksum. */
function verifyImageChecksum(buf) {
  const header = validateImageHeader(buf);
  if (!header.ok) return header;
  if (buf[1] < 1 || buf[1] > 16) return { ok: false, error: 'invalid image segment count' };
  if (buf[23] !== 0 && buf[23] !== 1) return { ok: false, error: 'invalid hash_appended flag' };
  let offset = 24, checksum = 0xEF;
  for (let n = 0; n < buf[1]; n++) {
    if (offset + 8 > buf.length) return { ok: false, error: 'truncated segment header' };
    const end = offset + 8 + buf.readUInt32LE(offset + 4);
    offset += 8;
    if (end > buf.length) return { ok: false, error: 'truncated segment data' };
    for (; offset < end; offset++) checksum ^= buf[offset];
  }
  // Checksum is the final byte before the next 16-byte boundary; footer
  // padding is not XORed, but is included in the appended SHA-256.
  const checksumOffset = Math.ceil((offset + 1) / 16) * 16 - 1;
  const expectedSize = checksumOffset + 1 + (buf[23] ? 32 : 0);
  if (buf.length !== expectedSize) return { ok: false, error: 'truncated image footer or unexpected trailing data' };
  if (buf[checksumOffset] !== checksum) return { ok: false, error: 'image checksum does not match segment data' };
  return { ok: true };
}

/** If the image declares an appended SHA-256 (header flag 0x17), verify it. */
function verifyAppendedHash(buf) {
  if (!buf[0x17]) return { ok: true };
  if (buf.length < 32) return { ok: false, error: 'hash_appended set but image too short' };
  const payload = buf.subarray(0, buf.length - 32);
  const hash = buf.subarray(buf.length - 32);
  const expect = crypto.createHash('sha256').update(payload).digest();
  if (!crypto.timingSafeEqual(hash, expect)) {
    return { ok: false, error: 'appended SHA-256 does not match the image contents' };
  }
  return { ok: true };
}

/** Common upload/CLI policy: structure, integrity and embedded identity. */
function validateApplicationImage(buf) {
  const checksum = verifyImageChecksum(buf);
  if (!checksum.ok) return checksum;
  const hash = verifyAppendedHash(buf);
  if (!hash.ok) return hash;
  const meta = parseImageMeta(buf);
  if (!meta) return { ok: false, error: 'image has no readable app descriptor (version/project) — is it an EnergyAnalyzer build?' };
  if (meta.project !== 'EnergyAnalyzer') {
    return { ok: false, error: `project is "${meta.project}", expected "EnergyAnalyzer"` };
  }
  const match = /^[0-9]{1,5}(?:\.[0-9]{1,5}){2}$/.exec(meta.version);
  if (!match || match[0] !== meta.version || meta.version.split('.').some(n => Number(n) > 65535)) {
    return { ok: false, error: `version "${meta.version}" must have three numeric components in 0..65535` };
  }
  return { ok: true, meta };
}

/** Compare two strict-semver versions; 1 = a newer, 0 = equal, -1 = a older. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/**
 * Stage a firmware.bin immutably into <ota-dir>/releases/<version>/firmware.bin
 * WITHOUT touching the manifest. Idempotent for identical bytes; refuses to
 * overwrite an existing release with different bytes.
 */
function stageRelease(otaDir, version, binBuf) {
  if (!OTA_SEMVER.test(version)) return { ok: false, error: `version must be strict semver x.y.z (got ${JSON.stringify(version)})` };
  const releaseDir = path.join(otaDir, 'releases', version);
  const dest = path.join(releaseDir, 'firmware.bin');
  const actualSha = sha256hex(binBuf);
  try {
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(dest, binBuf, { flag: 'wx' }); // exclusive create: immutable releases
  } catch (err) {
    if (err.code !== 'EEXIST') return { ok: false, error: `write failed: ${err.message}` };
    const existing = fs.readFileSync(dest);
    if (sha256hex(existing) !== actualSha) {
      return { ok: false, error: `release ${version} already exists with different bytes — releases are immutable` };
    }
    // Identical bytes: idempotent re-stage, fall through to the disk check.
  }
  // Hash-verify the copy on disk (never trust the upload source).
  if (sha256hex(fs.readFileSync(dest)) !== actualSha) {
    return { ok: false, error: 'on-disk copy failed hash verification — not publishing' };
  }
  return { ok: true, path: dest, sha256: actualSha, size: binBuf.length };
}

/**
 * Atomically write the active manifest (tmp file + rename in the same dir).
 * The staged binary must already exist on disk; its hash is re-verified here
 * so a manifest can never point at a missing or half-written binary.
 */
function activateRelease(otaDir, meta) {
  const { version, project, chip, layout, size, sha256, enabled } = meta;
  if (!OTA_SEMVER.test(version)) return { ok: false, error: `version must be strict semver x.y.z (got ${JSON.stringify(version)})` };
  if (typeof project !== 'string' || !project.trim()) return { ok: false, error: 'project must be a non-empty string' };
  if (chip !== 'esp32s3') return { ok: false, error: `chip must be "esp32s3" (got ${JSON.stringify(chip)})` };
  if (typeof layout !== 'string' || !layout.trim()) return { ok: false, error: 'layout must be a non-empty string' };
  if (!Number.isInteger(size) || size <= 0) return { ok: false, error: `size must be a positive integer (got ${JSON.stringify(size)})` };
  if (size > OTA_SIZE_CAP) return { ok: false, error: `size ${size} exceeds the 0x${OTA_SIZE_CAP.toString(16)} OTA cap` };
  if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) return { ok: false, error: 'sha256 must be 64 hex chars' };

  const binPath = path.join(otaDir, 'releases', version, 'firmware.bin');
  let onDisk;
  try { onDisk = fs.readFileSync(binPath); }
  catch { return { ok: false, error: `release ${version} is not staged (missing firmware.bin)` }; }
  if (sha256hex(onDisk) !== sha256.toLowerCase()) {
    return { ok: false, error: 'staged binary failed on-disk hash verification — not activating' };
  }

  fs.mkdirSync(otaDir, { recursive: true });
  const active = {
    enabled: enabled === true,
    version,
    project: project.trim(),
    chip,
    layout: layout.trim(),
    size,
    sha256: sha256.toLowerCase(),
    path: `/firmware/${version}/firmware.bin`,
    published_at: new Date().toISOString(),
  };
  const tmpFile = path.join(otaDir, 'manifest.json.tmp');
  fs.writeFileSync(tmpFile, JSON.stringify(active, null, 2) + '\n');
  fs.renameSync(tmpFile, path.join(otaDir, 'manifest.json'));
  return { ok: true, manifest: active, binPath };
}

module.exports = {
  OTA_SIZE_CAP, OTA_SEMVER, ESP32S3_CHIP_ID,
  sha256hex, validateImageHeader, parseImageMeta, verifyImageChecksum, verifyAppendedHash,
  validateApplicationImage,
  compareVersions, stageRelease, activateRelease,
};
