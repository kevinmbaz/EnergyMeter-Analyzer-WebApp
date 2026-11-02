'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ota = require('../scripts/ota_core');
const { makeImage } = require('./helpers/esp-image');

test('ESP-IDF descriptor at byte 32 uses unsigned little-endian magic and byte 48/80 strings', () => {
  const bin = makeImage(1307664, { version: '1.3.3' });
  assert.equal(bin.length, 1307664);
  assert.equal(bin.readUInt16LE(12), 9);
  assert.equal(bin.readUInt32LE(32), 0xABCD5432);
  assert.ok(bin.readInt32LE(32) < 0, 'magic has its high bit set; do not compare a signed read');
  assert.equal(bin.subarray(48, 80).toString().split('\0')[0], '1.3.3');
  assert.equal(bin.subarray(80, 112).toString().split('\0')[0], 'EnergyAnalyzer');
  assert.deepEqual(ota.parseImageMeta(bin), { version: '1.3.3', project: 'EnergyAnalyzer' });
});

test('shared application validation preserves checksum, hash, chip, size and project checks', () => {
  for (const hashAppended of [false, true]) {
    const valid = makeImage(1307664, { version: '1.3.3', hashAppended });
    const result = ota.validateApplicationImage(valid);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.meta, { version: '1.3.3', project: 'EnergyAnalyzer' });
  }
  const cases = [
    ['image magic', makeImage(8192, { magic: 0 })],
    ['chip', makeImage(8192, { chipId: 0 })],
    ['OTA cap', makeImage(ota.OTA_SIZE_CAP + 1)],
    ['checksum', makeImage(8192, { badChecksum: true })], // SHA recomputed, XOR still invalid
    ['appended SHA-256', makeImage(8192, { badHash: true })],
    ['descriptor', makeImage(8192, { descriptorMagic: 0 })],
    ['project', makeImage(8192, { project: 'OtherProject' })],
    ['version', makeImage(8192, { version: '1.3' })],
  ];
  for (const [label, bin] of cases) {
    const result = ota.validateApplicationImage(bin);
    assert.equal(result.ok, false, label);
    assert.ok(result.error, label);
  }
});

test('descriptor parsing rejects wrong endian, displaced, truncated and unterminated metadata', () => {
  for (const mutate of [
    b => b.writeUInt32BE(0xABCD5432, 32),
    b => { b.writeUInt32LE(0, 32); b.writeUInt32LE(0xABCD5432, 48); },
    b => b.writeUInt32LE(255, 28),
    b => b.writeUInt32LE(0xffffffff, 28),
    b => b.fill(0x41, 48, 80),
    b => b.fill(0x41, 80, 112),
  ]) {
    const b = makeImage();
    mutate(b);
    assert.equal(ota.parseImageMeta(b), null);
  }
  assert.equal(ota.parseImageMeta(makeImage().subarray(0, 287)), null);
});

test('checksum validation walks every segment and rejects malformed lengths and footers', () => {
  const bin = makeImage(8192, { extraSegments: [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7, 8])] });
  assert.equal(ota.validateApplicationImage(bin).ok, true);
  for (const mutate of [
    b => { b[1] = 0; },
    b => { b[1] = 17; },
    b => { b[23] = 2; },
    b => b.writeUInt32LE(0xffffffff, 28),
    b => { const lastSegment = 32 + b.readUInt32LE(28) + 12; b[lastSegment + 8] ^= 1; },
  ]) {
    const b = Buffer.from(bin);
    mutate(b);
    assert.equal(ota.verifyImageChecksum(b).ok, false);
  }
  for (const b of [bin.subarray(0, 28), bin.subarray(0, -1), Buffer.concat([bin, Buffer.from([0])])]) {
    assert.equal(ota.verifyImageChecksum(b).ok, false);
  }
});
