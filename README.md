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

While the register map stays unverified, a "Provisional register map" banner
is shown and all labels/units are treated as provisional. Energy counters are
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

History: 1 s resolution kept for 2 h, 1 min aggregates kept for 7 days
(in memory — persistence comes later).

## Phase 3 — register-map verification (next step)

The 19 measurement groups come straight from the ESP32's provisional decoder.
To finalize:

1. Compare each group against the TPM-04-100D display while a known load is
   running (check phase order L1/L2/L3 and the power scale — the raw register
   values' unit is still unconfirmed).
2. Confirm the Modbus register addresses (start 4000, 114 words) against the
   manufacturer's register map.
3. Decode the energy registers so energy comes from the meter instead of
   server-side integration.

When done, flip `candidate_layout` handling in the server/UI to drop the
provisional banner. Optional later: persistence (SQLite), alerting, and
having the ESP32 push to `POST /api/ingest` instead of being polled.

## Layout

```
server.js           HTTP server, simulator, history buffers, API
public/index.html   app shell (8 views)
public/styles.css   design system (dark default + light theme)
public/app.js       charts, polling, interactions
public/vendor/      Chart.js + Inter (vendored, offline)
```
