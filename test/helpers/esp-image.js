'use strict';

const crypto = require('node:crypto');

// Synthetic ESP-IDF application, not a device firmware artifact. The 24-byte
// image header includes its extended header; the first 8-byte segment header
// puts the 256-byte app descriptor at byte 32. Includes the real footer rules.
function makeImage(size = 8192, opts = {}) {
  const hashAppended = opts.hashAppended ?? true;
  const total = Math.ceil(Math.max(size, 336) / 16) * 16;
  const buf = Buffer.alloc(total);
  const imageEnd = total - (hashAppended ? 32 : 0);
  const checksumOffset = imageEnd - 1;
  const extraSegments = opts.extraSegments || [];
  const dataEnd = checksumOffset - 3 - extraSegments.reduce((n, data) => n + 8 + data.length, 0);
  const dataSize = dataEnd - 32;
  buf[0] = opts.magic ?? 0xE9;
  buf[1] = 1 + extraSegments.length;
  buf.writeUInt32LE(0x40380000, 4);
  buf.writeUInt16LE(opts.chipId ?? 9, 12);
  buf[23] = hashAppended ? 1 : 0;
  buf.writeUInt32LE(0x3c000020, 24);
  buf.writeUInt32LE(dataSize, 28);
  buf.writeUInt32LE(opts.descriptorMagic ?? 0xABCD5432, 32);
  buf.write(opts.version ?? '1.4.0', 48, 32, 'utf8');
  buf.write(opts.project ?? 'EnergyAnalyzer', 80, 32, 'utf8');
  buf.write('v5.5.3', 176, 32, 'utf8');
  // Patterned data after the descriptor makes corruption tests meaningful.
  for (let i = 288; i < dataEnd; i++) buf[i] = i & 0xff;
  let checksum = 0xEF;
  for (let i = 32; i < dataEnd; i++) checksum ^= buf[i];
  let offset = dataEnd;
  for (const data of extraSegments) {
    buf.writeUInt32LE(0x3fc80000, offset);
    buf.writeUInt32LE(data.length, offset + 4);
    data.copy(buf, offset + 8);
    for (const value of data) checksum ^= value;
    offset += 8 + data.length;
  }
  buf[checksumOffset] = opts.badChecksum ? checksum ^ 1 : checksum;
  if (hashAppended) {
    const hash = crypto.createHash('sha256').update(buf.subarray(0, imageEnd)).digest();
    if (opts.badHash) hash[0] ^= 1;
    hash.copy(buf, imageEnd);
  }
  return buf;
}

module.exports = { makeImage };
