# Private pull-based OTA for the EnergyMeter ESP32

The EnergyMeter Node server (Jetson Nano, tailnet 100.75.214.91, port 8090)
hosts a private, pull-based firmware feed. The ESP32 polls the feed and only
installs a strictly newer version. Everything is token-gated and restricted to
the tailnet — nothing is exposed publicly.

## How it works

```
ESP32 (tailnet) ── every 60 s ──▶ GET /api/firmware/manifest   (X-OTA-Token, UA: EnergyAnalyzer-OTA/<v>)
                                 GET /firmware/<v>/firmware.bin  (X-OTA-Token)
```

- The server answers the manifest with the active release
  `{enabled, version, project, chip, layout, size, sha256, path}`.
- `enabled:false` means the feed is off (no update available) — the device
  keeps running its current firmware.
- The device compares `version` with its own; it downloads and flashes only
  when the manifest version is strictly newer. Current USB-flashed version:
  1.3.0. First OTA release: 1.3.1.
- The server records the version each polling device reports in its
  `User-Agent` (`EnergyAnalyzer-OTA/<version>`) and exposes it under
  `ota.reported_version` in `GET /api/status`.

## Server setup (Jetson)

Environment variables:

| Var | Meaning | Default |
|---|---|---|
| `OTA_TOKEN` | Shared secret the ESP32 sends as `X-OTA-Token`. **Fail closed: without it every OTA request is rejected (401).** | unset → OTA off |
| `OTA_DIR` | Firmware store root. | `<project>/firmware` |
| `OTA_ALLOW_CIDRS` | Comma-separated CIDRs allowed to reach the OTA endpoints. | `100.64.0.0/10,127.0.0.1/32,::1/128` (tailnet + localhost) |

Start the server (token is loaded from the private secrets file at runtime —
never put the token in a command line or shell history):

```bash
cd ~/Documents/Projects/EnergyMeter
export OTA_TOKEN="$(python3 -c "import json;print(json.load(open('ota.secrets.json'))['ota_token'])")"
node server.js
```

The secrets file lives at `~/Documents/Projects/EnergyMeter/ota.secrets.json`
(mode 0600, gitignored), JSON with a single `ota_token` key, matching your
firmware project's ota.secrets.json. Copy it with:

```bash
scp ota.secrets.json nadir@100.75.214.91:~/Documents/Projects/EnergyMeter/
```

Token rules:

- Keep the token in a private file (e.g. `ota.secrets.json` on your laptop,
  mode 0600, gitignored — `*.secrets.json` is already ignored).
- The server compares tokens as SHA-256 digests in constant time and never
  logs or echoes the token. Do not paste the token into chat or git.
- The same token must appear in the ESP32 firmware config.

Store layout (managed by the publish CLI, never edit by hand):

```
firmware/
  releases/<version>/firmware.bin   immutable, one per release, retained
  manifest.json                     active feed, atomically replaced
```

## Publishing a release (from your laptop)

Build the firmware and package it (your firmware repo already produces these):

```bash
# scripts/package_ota.py emits firmware.bin + manifest.json with:
#   {version, project, chip:"esp32s3", layout, size, sha256}
```

Copy the two files to the Jetson, then publish:

```bash
scp firmware.bin manifest.json nadir@100.75.214.91:/tmp/
ssh nadir@100.75.214.91 \
  'node ~/Documents/Projects/EnergyMeter/scripts/publish_ota.js \
     /tmp/firmware.bin /tmp/manifest.json \
     --ota-dir ~/Documents/Projects/EnergyMeter/firmware'
```

The publish CLI validates everything before anything changes:

- manifest metadata (strict semver `x.y.z`, `chip:"esp32s3"`, non-empty
  `project`/`layout`, size/sha256 fields)
- the binary is an ESP-IDF application image (magic byte 0xE9, chip id 0x0009
  = ESP32-S3)
- SHA-256 of the binary matches the manifest, size matches, and
  size ≤ 0x3f0000 (the OTA partition budget)
- releases are immutable: re-publishing the same version with identical bytes
  is a no-op; different bytes are refused

Then it copies the binary first, hash-verifies the copy on disk, and only
then atomically replaces the active manifest — a polling device can never see
a manifest pointing at a missing or half-written binary.

Useful variants:

```bash
node scripts/publish_ota.js firmware.bin manifest.json --disable   # publish but keep feed off
node scripts/publish_ota.js firmware.bin manifest.json             # enable (default)
```

Rollback: republish the old version's binary + manifest — old releases are
never deleted, so keep them around for this.

No automatic publishing happens during setup or at boot — releases only
change when you run the publish CLI.

## ESP32 firmware side (your laptop)

Requirements for the firmware's OTA client:

- Poll `https://100.75.214.91:8090/api/firmware/manifest` every 60 seconds
  (plain HTTP over the tailnet is fine; the feed is token-gated).
- Send headers:
  - `X-OTA-Token: <same token as the server's OTA_TOKEN>`
  - `User-Agent: EnergyAnalyzer-OTA/<current-firmware-version>`
- Parse the JSON. If `enabled` is true and `version` is strictly newer than
  the running version, download `path` (same host, same token header),
  verify `sha256` of the downloaded bytes, then `esp_ota` write + reboot.
- If `enabled` is false, 401 or 404: do nothing, keep the current firmware.
- Initial USB-flashed version is 1.3.0; the first OTA release should be
  `1.3.1` so the strict-version check installs it.

## Verification

```bash
# from the Jetson (or any tailnet host)
curl -i http://100.75.214.91:8090/api/firmware/manifest \
  -H 'X-OTA-Token: <token>' -H 'User-Agent: EnergyAnalyzer-OTA/1.3.0'
curl -s http://100.75.214.91:8090/api/status | python3 -m json.tool   # ota.* block
```

Regression tests: `npm test` — includes authorization (fail-closed, wrong
token, non-tailnet source), disabled-feed behavior, byte-for-byte download
integrity and the publish CLI validation matrix.
