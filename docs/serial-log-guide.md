# ESP32 serial-console batches

The Node server accepts console batches at `POST /api/serial-log`. This is raw
console text, **not** a JSON ingestion endpoint. No firmware changes or automatic
OTA publication are performed by the server.

## Upload contract

- `Content-Type: text/plain; charset=utf-8` (uncompressed UTF-8).
- `X-OTA-Token`: the existing server `OTA_TOKEN`. Missing/wrong tokens, or an
  unset server token, fail closed with HTTP 401. Tokens are never returned.
- The source IP must satisfy the existing `OTA_ALLOW_CIDRS` policy (Tailscale
  `100.64.0.0/10` and loopback by default). Forwarded-IP headers are not trusted.
- Body limit: **4,096 encoded bytes**, including whitespace and escape codes.
  Both Content-Length and chunked uploads are limited by bytes actually read.
  Empty text is accepted. Over-limit bodies receive HTTP 413; malformed UTF-8
  receives 400; a wrong content type or content encoding receives 415.

All metadata headers are required:

| Header | Contract |
| --- | --- |
| `X-Device-Name` | 1–64 ASCII characters; letters/digits, `.`, `_`, `-`; starts with a letter/digit. |
| `X-Firmware-Version` | Three numeric components, each 0–65535, e.g. `1.3.3`. |
| `X-Log-Boot-ID` | 1–128 ASCII characters; letters/digits, `.`, `_`, `:`, `-`; starts with a letter/digit. Change it on every device boot. |
| `X-Log-Sequence` | Unsigned 64-bit decimal, 0–18446744073709551615, no leading zeros except `0`. Keep the same value when retrying a batch. |
| `X-Log-Dropped-Bytes` | Unsigned 64-bit decimal in the same format. Stored as reported; the server does not insert a synthetic dropped-data message. |

Successful acceptance returns HTTP 200 with `{ok:true, id, duplicate:false}`.
An identical retry for the same `(device name, boot ID, sequence)` returns the
original ID with `duplicate:true`. A reused key with different body bytes gets
HTTP 409 and never overwrites the accepted text. First-accepted metadata and
receipt time are retained, even if a retry changes its headers. Sequences may
arrive out of order. Device names and boot IDs provide independent namespaces.

Batches are stored as BLOBs in `serial_log_batches` in the existing SQLite
`DB_PATH`, with their metadata and server receipt timestamp. No trimming,
newline conversion, ANSI removal, JSON parsing or line splitting occurs.
This preserves BOMs, NULs, CRLF, partial lines and valid UTF-8 byte-for-byte.
Logs and retry deduplication survive server restarts. Batches are retained
indefinitely; measurement `DB_RETENTION_DAYS` does not delete console logs.
Storage failures return HTTP 503 rather than acknowledging and losing a batch.

Log traffic is separate from meter telemetry: it does not create measurements,
refresh meter contact/freshness, clear an RS-485 alarm or enable an OTA feed.
Firmware-version headers are retained on the log batch as metadata.

## Website reads

`GET /api/serial-log?device=energymeter&after=0&limit=100`

Read access uses `OTA_ALLOW_CIDRS` too, without requiring an OTA token in the
browser. Open the dashboard through its Tailscale address (or loopback), not an
untrusted/public proxy. JSON is same-origin only: no wildcard CORS is exposed.

Parameters:

- `device`: defaults to the server's `ESP32_DEVICE_ID` (`energymeter`).
- `after`: exclusive server batch ID cursor, defaults to `0`. This is **not**
  the firmware sequence; it remains monotonic across boots and restarts.
- `limit`: 1–200 batches, default 100.
- `format`: `json` (default) or `text`.

The JSON response contains `batches`, `next_after`, and `has_more`. Each batch
has `id`, `device_name`, `firmware_version`, `boot_id`, `sequence`,
`dropped_bytes`, `received_at` (Unix milliseconds), and `text`. Sequence and
dropped-byte counters are JSON **strings** so 64-bit values are not rounded.
Results are ordered by server ID, i.e. receipt order. Use `next_after` for the
next request; continue immediately while `has_more` is true.

Render `batch.text` using `textContent` or `document.createTextNode`, never
`innerHTML`. Do not add separators when joining batches: a batch may end in the
middle of a line. Device text is untrusted, including strings resembling HTML.

For a direct safe-text response:

`GET /api/serial-log?device=energymeter&after=0&limit=100&format=text`

This concatenates the selected batch bytes unchanged, returns
`text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`, and a restrictive
CSP. Pagination is carried in `X-Log-Next-After` and `X-Log-Has-More` headers.
All log responses use `Cache-Control: no-store`.

## Settings console

Open **Settings → ESP32 serial console**, the first full-width panel. It loads
stored logs and follows new batches while Settings is open, at the dashboard's
selected poll interval. Chart pause and console pause are independent.

- **Pause logs / Resume logs:** freeze or resume console updates.
- **Refresh:** read once, including while paused.
- **Auto-scroll:** follow the bottom; disable it to read earlier output.
- **Clear display:** clear only this browser view, not the SQLite records.
- **Device name / Load device:** select the exact name sent in X-Device-Name.
  Leave blank to use the configured ESP32. Reloading a device restores its
  stored history after a display-only clear.

The browser retains at most 200 loaded batches, safely rendered with
`textContent` without adding newlines between fragments. Metadata below the
console identifies the latest batch's device, firmware, boot, sequence,
dropped-byte count and receipt time. A 403 explains that the dashboard must be
opened over Tailscale. No token is embedded in the browser.

The older `POST /api/serial` metadata-only compatibility route remains unchanged;
firmware forwarding actual console text must use `POST /api/serial-log`.

## Verification

`node --test test/serial-log.test.js` runs real HTTP listeners on temporary
loopback ports and temporary SQLite databases. It covers unchanged raw text,
XSS-like text, token/CIDR rejection, byte limits (including chunked bodies),
metadata validation, concurrent retries, conflicts, 64-bit counters, restarts,
pagination, meter-health isolation and storage failures. It never injects test
logs or test firmware reports into the live port 8090 service.

`node --test test/serial-console-ui.test.js` verifies safe text rendering,
controls, cursor pagination, bounded display, device-switch races, error states
and input validation. Browser checks use actual received logs, not fake uploads.
