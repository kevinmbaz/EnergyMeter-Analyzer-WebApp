#!/usr/bin/env node
'use strict';

/**
 * publish_ota — publish a firmware release to the EnergyMeter OTA feed.
 *
 * Accepts the firmware.bin + manifest.json produced by scripts/package_ota.py
 * (the firmware build tooling) and installs them into the private OTA store:
 *
 *   <ota-dir>/releases/<version>/firmware.bin   immutable, retained forever
 *   <ota-dir>/manifest.json                     atomically replaced, last write
 *
 * Usage:
 *   node scripts/publish_ota.js <firmware.bin> <manifest.json> [--disable]
 *                               [--ota-dir DIR]
 *
 * The binary is validated (ESP32-S3 application image magic + chip id, SHA-256,
 * size <= 0x3f0000) and copied first; the active manifest is replaced only
 * after the copy hash-verifies on disk, so a polling device can never see a
 * manifest that points at a missing or half-written binary.
 *
 * Validation and publishing logic lives in scripts/ota_core.js, shared with
 * the server's web upload/install flow.
 */

const fs = require('node:fs');
const path = require('node:path');
const ota = require('./ota_core');

function fail(msg) {
  console.error(`publish_ota: ${msg}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage: node scripts/publish_ota.js <firmware.bin> <manifest.json> [--disable] [--ota-dir DIR]

  firmware.bin   ESP32-S3 application image from scripts/package_ota.py
  manifest.json  {version, project, chip:"esp32s3", layout, size, sha256}
  --disable      publish with enabled:false (feed stays off for devices)
  --ota-dir      firmware store (default: $OTA_DIR or <project>/firmware)`);
}

const args = { disable: false, otaDir: null, bin: null, manifest: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else if (a === '--disable') args.disable = true;
  else if (a === '--ota-dir') { args.otaDir = process.argv[++i]; if (!args.otaDir) fail('--ota-dir needs a path'); }
  else if (!args.bin) args.bin = a;
  else if (!args.manifest) args.manifest = a;
  else fail(`unexpected argument: ${a}`);
}
if (!args.bin || !args.manifest) { usage(); fail('missing firmware.bin or manifest.json'); }

// ---------------------------------------------------------------- validate

const bin = fs.readFileSync(args.bin);

let meta;
try {
  meta = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
} catch (err) {
  fail(`cannot read manifest ${args.manifest}: ${err.message}`);
}
if (!meta || typeof meta !== 'object') fail('manifest must be a JSON object');

const { version, project, chip, layout, size, sha256 } = meta;
if (typeof version !== 'string' || !ota.OTA_SEMVER.test(version)) {
  fail(`version must be strict semver x.y.z (got ${JSON.stringify(version)})`);
}
if (typeof project !== 'string' || !project.trim()) fail('project must be a non-empty string');
if (chip !== 'esp32s3') fail(`chip must be "esp32s3" (got ${JSON.stringify(chip)})`);
if (typeof layout !== 'string' || !layout.trim()) fail('layout must be a non-empty string');
if (!Number.isInteger(size) || size <= 0) fail(`size must be a positive integer (got ${JSON.stringify(size)})`);
if (size > ota.OTA_SIZE_CAP) fail(`size ${size} exceeds the 0x${ota.OTA_SIZE_CAP.toString(16)} OTA cap`);
if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) fail('sha256 must be 64 hex chars');

if (bin.length !== size) fail(`size mismatch: manifest says ${size}, firmware.bin is ${bin.length} bytes`);

const header = ota.validateImageHeader(bin);
if (!header.ok) fail(header.error);

const actualSha = ota.sha256hex(bin);
if (actualSha !== sha256.toLowerCase()) {
  fail(`sha256 mismatch: firmware.bin is ${actualSha}, manifest says ${sha256.toLowerCase()}`);
}

// ---------------------------------------------------------------- publish

const otaDir = args.otaDir || process.env.OTA_DIR || path.join(__dirname, '..', 'firmware');

const staged = ota.stageRelease(otaDir, version, bin);
if (!staged.ok) fail(staged.error);

const activated = ota.activateRelease(otaDir, {
  enabled: !args.disable, version, project: project.trim(), chip,
  layout: layout.trim(), size, sha256: actualSha,
});
if (!activated.ok) fail(activated.error);

console.log(`published ${project} ${version} (${size} bytes, sha256 ${actualSha.slice(0, 16)}…)`);
console.log(`  binary: ${staged.path}`);
console.log(`  active manifest: ${path.join(otaDir, 'manifest.json')} — enabled: ${activated.manifest.enabled}`);
