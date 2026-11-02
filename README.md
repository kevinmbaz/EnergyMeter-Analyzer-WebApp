# TPM-04-100D · Energy Analytics

Node.js energy-monitoring server + dashboard for the TPM-04-100D three-phase
analyzer, read by an ESP32 over Modbus RTU (USB / RS-485).

**Current state (phase 2 — live ESP32):** the server polls
`http://energymeter.local/api/readings` every 2 seconds (no ESP32 firmware
change needed) and switches automatically from the simulator to device data on
first contact. No dependencies (`npm install` not even needed) — Chart.js and
the Inter font are vendored under `public/vendor/`, so it works completely
offline on the LAN.

Data-source modes (Settings → Data source):
- **Auto** (default): simulator until the ESP32 answers, then device data.
- **ESP32 only**: device data, sim off.
- **Simulator only**: dev mode with sim controls (load, noise, spike).

The dashboard shows communication faults, not a provisional-register-map
banner. Register labels/units still await verification. Energy counters are
integrated server-side from active power until the meter's energy registers
are decoded.

## Run

```bash
node server.js          # or: npm start  → http://localhost:8090/
# PORT=8090 HOST=0.0.0.0 node server.js
```

Open http://localhost:8090/ (or the LAN address printed at startup).
Default port is 8090 — 8080 is used by the `~/energy-server` Python app on
this machine.

## What's inside

- **Overview** — KPI row with sparklines (power, energy, PF, frequency,
  current, phase imbalance), stacked per-phase power chart, energy-share
  donut, system panel.
- **Power** — active (stacked), reactive, apparent and demand charts.
- **Voltage** — L-N and L-L charts, per-phase min/max/avg cards with range bars.
- **Current** — line currents and demand.
- **Power quality** — power factor, frequency, phase-balance breakdown.
- **Energy** — kWh per minute/hour bars, since-start / 1 h / 24 h totals,
  CSV export (energy and power).
- **Live data** — the 19 measurement groups × 3 phases, live (same set as the
  ESP32 dashboard).
- **Settings** — data-source status, simulator controls (on/off, load
  multiplier, noise, spike injection), theme, poll interval.

Interactions: phase toggles (L1/L2/L3/Total) apply to every chart, time-range
selector (10 min live → 7 days), pause/resume live updates, dark/light theme
(persisted), CSV export.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | source + source mode, ESP32 status, uptime, buffers |
| `GET /api/readings` | latest full measurement snapshot |
| `GET /api/history?range=live\|1h\|6h\|24h\|7d` | time series (≤720 pts) |
| `POST /api/source` | `{mode: auto\|device\|simulation}` — data source switch |
| `POST /api/sim` | `{running, multiplier, noise, spike}` (simulator dev tool) |
| `POST /api/ingest` | push seam — the ESP32 may POST readings here instead |

ESP32 config via env: `ESP32_URL` (default `http://energymeter.local/api/readings`),
`ESP32_POLL_MS` (default 2000), `ESP32_TIMEOUT_MS` (default 4000).

## Database & CSV export

Every sample (device and simulator) is stored in SQLite via Node's built-in
`node:sqlite` — no external database service needed. File:
`data/energymeter.db` (WAL mode, ~50 MB/year at 1 sample/s).

- `DB_PATH` env overrides the file location.
- `DB_RETENTION_DAYS` (default 0 = keep forever) prunes old samples daily.
- On restart, the in-memory live buffers (2 h seconds + 7 d minute aggregates)
  are reloaded from the database, so charts survive reboots.
- CSV export: `GET /api/export?range=live|1h|6h|24h|7d|all&group=raw|minute|hour|auto`
  (Settings → Database & export panel has the download button). Raw export is
  capped at 100,000 rows — use minute/hour grouping for longer ranges.

History: 1 s resolution kept for 2 h, 1 min aggregates kept for 7 days
(in memory for the live UI; the database keeps everything long-term). Restarting resets history and integrated energy.

## Communication feedback

The dashboard shows a persistent warning and sidebar status for:

- **ESP32 offline:** no valid payload received for 15 seconds, or a failed pull
  when push is not active. Check ESP32 power, Wi-Fi and the network path.
- **RS-485 disconnected:** the ESP32 explicitly reports `adapter_connected: false`.
- **Meter error:** the ESP32 is reachable but reports `meter.last_error` (shown
  verbatim as text, for example a Modbus timeout).
- **No meter data:** the ESP32 reports `has_sample: false`.
- **Meter stale:** the firmware reports `stale: true`, sample age reaches 15
  seconds, or the meter sequence stops advancing for 15 seconds while messages
  continue to arrive.
- **Server offline:** the browser cannot reach the Node API (5-second request
  timeout). This is distinct from an ESP32 or meter fault.

Faults clear automatically on healthy data. The UI refreshes on its selected
poll interval (2 seconds by default); health monitoring continues while charts
are paused. Settings includes last contact, last valid meter sample, sample age,
and separate transport/meter errors. Both `/api/status` and `/api/readings`
include `device.health` (`code`, `severity`, `message`) and freshness metadata;
`/api/readings` returns HTTP 200 with `sample: null` if no valid sample exists.

Bad/stale samples and duplicate sequences do not enter history or accumulate
energy. The last good values remain visible and labelled as not live. Integration
skips known outages rather than estimating consumption across them. Auto mode
stops simulating as soon as the first ESP32 report arrives, even a fault report.
Before first contact, any simulated data is explicitly labelled.

The server cannot prove a physical disconnection from a generic timeout alone.
A specific adapter-disconnected message requires the firmware flag; otherwise
it reports a meter communication fault and suggests checks. If using push-only
firmware, send status payloads even when meter reads fail; if all messages stop,
the server can only report loss of ESP32 contact. Set `ESP32_URL=''` to disable
LAN polling; either successful transport counts as contact when both are active.

Run regression tests with `npm test` (no additional dependencies).

## ESP32 OTA (private, pull-based)

The server also hosts the ESP32's firmware feed: `GET /api/firmware/manifest`
and `GET /firmware/<version>/firmware.bin`. Both require an `X-OTA-Token`
matching the `OTA_TOKEN` env var (fail closed when unset) and only accept
tailnet sources (`OTA_ALLOW_CIDRS`, default `100.64.0.0/10` + localhost).
Manifest responses carry exact Content-Length, the binary is served
byte-for-byte without compression, chunking or redirects, and releases are
immutable with old versions retained for rollback.

Publishing is manual and explicit:

```bash
node scripts/publish_ota.js firmware.bin manifest.json            # enable feed
node scripts/publish_ota.js firmware.bin manifest.json --disable  # keep feed off
```

The CLI validates the ESP32-S3 image (magic, chip id, SHA-256, size
≤ 0x3f0000) and writes the binary before atomically replacing the manifest.
The last firmware version each polling device reports (User-Agent
`EnergyAnalyzer-OTA/<version>`) is exposed via `/api/status` → `ota.*`.
Full deployment, token and ESP32-side instructions: `docs/ota-guide.md`.

### Web upload & install (Settings → Firmware update)

The dashboard can publish releases without the CLI:

1. **Upload & validate** — `POST /api/ota/upload` (raw `application/octet-stream`
   body). The server validates the ESP32-S3 image header, the embedded app
   descriptor (`project` must be `EnergyAnalyzer`, strict-semver `version`),
   the optional appended SHA-256, and the 0x3f0000 size cap — then STAGES the
   binary immutably into `releases/<version>/firmware.bin`. The manifest is
   untouched, so devices see no change yet.
2. **Install Update** — `POST /api/ota/install {"version": "x.y.z"}` atomically
   activates the staged release (same tmp+rename manifest swap as the CLI) and
   requires the version to be strictly newer than the active one.
3. The panel then tracks the update: staging info, active release, ESP32
   download activity, and the device-reported version. Completion is confirmed
   when the device's User-Agent version equals the active release and its
   status uploads resume.

`OTA_TOKEN` is never used by the dashboard flow — it stays exclusively on the
server for the ESP32's authenticated pull endpoints. Uploading stages only;
nothing is activated until Install Update is clicked.

## Data interpretation (TPM-04-100D register map)

The meter's 114-word block (from address 4000) decodes as 57 big-endian
float32 pairs: live/min/max/avg L-N and L-L voltage, live + demand current,
live + demand active/reactive/apparent power, power factor, cosφ and
per-phase frequency. Verified against live captures:

- Power registers are in kW and are scaled to W on ingest (demand block
  anchor: 20 A × 220 V = 4.4 kW — internally consistent).
- Frequency is per-phase (three values); the Live data table shows all three.
- The "demand" block holds frozen max-hold values (20 A / 4.4 kW), not a
  moving average.
- Negative power factor on a phase means reverse power flow (CT polarity or
  real export); the dashboard shows a notice and total PF keeps its sign.
- Import energy is integrated server-side from live power and never goes
  negative; exporting phases freeze their accumulation. The meter's true
  energy registers (classic map 4210+, 64-bit Wh) sit outside the 114-word
  window the firmware reads — extending the firmware is the remaining step
  for real meter energy.

## Phase 3 — remaining verification

1. Compare live values against the TPM-04-100D display under known load
   (live power vs V×I×pf still disagrees ~1.3–1.6×; the kW scale is anchored
   by the demand block but live units deserve a spot check).
2. Extend the ESP32 firmware to read the energy registers beyond word 113.
3. Determine whether L2/L3 negative power factor is reversed CTs or real
   export (solar), then fix polarity or keep the export-aware display.

Persistence (SQLite) already exists; the samples table covers the full sample
shape and survives restarts. Optional later: alerting.

## Layout

```
server.js           HTTP server, simulator, history buffers, API
public/index.html   app shell (8 views)
public/styles.css   design system (dark default + light theme)
public/app.js       charts, polling, interactions
public/vendor/      Chart.js + Inter (vendored, offline)
```
