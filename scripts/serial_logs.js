'use strict';

const { TextDecoder } = require('node:util');

const MAX_BYTES = 4096;
const MAX_PAGE = 200;
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BOOT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UINT64_MAX = 18446744073709551615n;

function initDatabase(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS serial_log_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_name TEXT NOT NULL,
    firmware_version TEXT NOT NULL,
    boot_id TEXT NOT NULL,
    sequence TEXT NOT NULL,
    dropped_bytes TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    content BLOB NOT NULL CHECK(length(content) <= 4096),
    UNIQUE(device_name, boot_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_serial_logs_device_id ON serial_log_batches(device_name, id);`);
}

function identifier(value, pattern) {
  if (typeof value !== 'string') return false;
  const m = pattern.exec(value);
  return !!m && m[0] === value;
}

function unsigned(value, max = UINT64_MAX) {
  if (typeof value !== 'string' || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return BigInt(value) <= max ? value : null;
}

// Never apply the dashboard's wildcard CORS to private console logs. Both JSON
// and raw responses stay inert, even if the console contains HTML or scripts.
function reply(res, code, data, type = 'application/json; charset=utf-8', headers = {}) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  res.writeHead(code, {
    'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
    ...headers,
  });
  res.end(body);
}

async function post(req, res, { db, tokenMatches, sourceAllowed, validFirmwareVersion, readRawBody }) {
  if (!tokenMatches(req.headers['x-ota-token'])) return reply(res, 401, { error: 'unauthorized' });
  if (!sourceAllowed(req.socket && req.socket.remoteAddress)) return reply(res, 403, { error: 'forbidden' });
  if (!/^text\/plain\s*;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/i.test(req.headers['content-type'] || '')
      || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
    return reply(res, 415, { error: 'use text/plain; charset=utf-8 with an uncompressed body' });
  }
  const device = req.headers['x-device-name'];
  const version = validFirmwareVersion(req.headers['x-firmware-version']);
  const boot = req.headers['x-log-boot-id'];
  const sequence = unsigned(req.headers['x-log-sequence']);
  const dropped = unsigned(req.headers['x-log-dropped-bytes']);
  if (!identifier(device, DEVICE) || !version || !identifier(boot, BOOT) || sequence === null || dropped === null) {
    return reply(res, 400, { error: 'missing or invalid serial-log metadata headers' });
  }
  if (!db) return reply(res, 503, { error: 'log storage unavailable' });
  let content;
  try {
    content = await readRawBody(req, MAX_BYTES);
  } catch (error) {
    return reply(res, error.status === 413 ? 413 : 400, { error: error.status === 413 ? 'console batch exceeds 4096 bytes' : 'incomplete console batch' });
  }
  try {
    // Validate UTF-8 only; never use the decoder's output, trim, split lines,
    // strip escape sequences, normalize newlines or parse the console as JSON.
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return reply(res, 400, { error: 'console batch is not valid UTF-8' });
  }
  try {
    const result = db.prepare(`INSERT INTO serial_log_batches
      (device_name, firmware_version, boot_id, sequence, dropped_bytes, received_at, content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_name, boot_id, sequence) DO NOTHING`)
      .run(device, version, boot, sequence, dropped, Date.now(), content);
    const stored = db.prepare(`SELECT id, content FROM serial_log_batches
      WHERE device_name = ? AND boot_id = ? AND sequence = ?`).get(device, boot, sequence);
    if (!Buffer.from(stored.content).equals(content)) {
      return reply(res, 409, { error: 'device/boot/sequence already contains a different batch' });
    }
    return reply(res, 200, { ok: true, id: stored.id, duplicate: result.changes === 0 });
  } catch {
    // Never acknowledge storage failure; the ESP32 must be able to retry.
    return reply(res, 503, { error: 'log storage unavailable; retry the batch' });
  }
}

function get(req, res, url, { db, sourceAllowed, defaultDevice }) {
  // Same-origin dashboard reads over the private tailnet need no embedded OTA
  // token. Network access uses the existing OTA_ALLOW_CIDRS policy.
  if (!sourceAllowed(req.socket && req.socket.remoteAddress)) return reply(res, 403, { error: 'forbidden' });
  const device = url.searchParams.get('device') ?? defaultDevice;
  const after = unsigned(url.searchParams.get('after') ?? '0', BigInt(Number.MAX_SAFE_INTEGER));
  const limit = unsigned(url.searchParams.get('limit') ?? '100', BigInt(MAX_PAGE));
  const format = url.searchParams.get('format') ?? 'json';
  if (!identifier(device, DEVICE) || after === null || limit === null || limit === '0' || !['json', 'text'].includes(format)) {
    return reply(res, 400, { error: 'invalid device, after, limit (1..200) or format (json|text)' });
  }
  if (!db) return reply(res, 503, { error: 'log storage unavailable' });
  try {
    const rows = db.prepare(`SELECT * FROM serial_log_batches
      WHERE device_name = ? AND id > ? ORDER BY id LIMIT ?`).all(device, Number(after), Number(limit) + 1);
    const hasMore = rows.length > Number(limit);
    const page = rows.slice(0, Number(limit));
    const next = page.length ? page[page.length - 1].id : Number(after);
    if (format === 'text') {
      return reply(res, 200, Buffer.concat(page.map(r => Buffer.from(r.content))), 'text/plain; charset=utf-8', {
        'X-Log-Next-After': String(next), 'X-Log-Has-More': String(hasMore),
      });
    }
    const batches = page.map(({ content, ...metadata }) => ({ ...metadata, text: Buffer.from(content).toString('utf8') }));
    return reply(res, 200, { batches, next_after: next, has_more: hasMore });
  } catch {
    return reply(res, 503, { error: 'log storage unavailable' });
  }
}

module.exports = { initDatabase, post, get };
