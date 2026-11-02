# ESP32 → Tailscale → Server (remote install guide)

Goal: the ESP32 (installed on a different network) keeps feeding this server.
Architecture: the ESP32 joins the tailnet with microlink and PUSHES its
readings JSON to the server's tailnet address every 2 s. Everything stays
private inside the tailnet (WireGuard-encrypted), no public URLs, no port
forwarding. The server side is already done and tested.

Server facts you need on the ESP32:
- Server tailnet IP:  100.75.214.91   (node name: jetson-energy)
- Ingest endpoint:    POST http://100.75.214.91:8090/api/ingest
- Body: the exact same JSON the ESP32 already serves at /api/readings
  (top-level {ap, meter:{groups, registers, sequence, stale, ...}, network,
  uptime_ms}). The server parses `meter` — no reformatting needed.
- Optional shared secret: if you later expose ingest publicly, start the
  server with INGEST_TOKEN=secret and send header X-Ingest-Token: secret.
  Not needed for tailnet-only traffic.

## Prerequisites (on the laptop)

- ESP-IDF v5.0+ (microlink is tested on v5.3)
- ESP32-S3 with PSRAM (8 MB recommended) — confirmed on this board
- Git
- Tailscale account that owns the tailnet (primetech299)

## Steps

### 1. Add the microlink component

Inside your existing ESP-IDF firmware project:

    cd <your-firmware-project>
    mkdir -p components
    cd components
    git clone https://github.com/CamM2325/microlink.git

(or add it as a git submodule — same thing, your choice)

### 2. sdkconfig.defaults additions

Add these to your project's sdkconfig.defaults (merge with what you have):

    # PSRAM (required)
    CONFIG_SPIRAM=y
    CONFIG_SPIRAM_MODE_OCT=y
    CONFIG_SPIRAM_TYPE_AUTO=y
    CONFIG_SPIRAM_SPEED_80M=y
    CONFIG_SPIRAM_ALLOW_STACK_EXTERNAL_MEMORY=y
    CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=4096
    CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL=32768
    # Bigger app partition (microlink + your app ~1MB+)
    CONFIG_PARTITION_TABLE_SINGLE_APP_LARGE=y
    # TLS for the control plane + DERP relay (required)
    CONFIG_ESP_TLS_USING_MBEDTLS=y
    CONFIG_MBEDTLS_SSL_PROTO_TLS1_2=y
    # Optional: microlink's own web UI on the tailnet IP
    # CONFIG_ML_ENABLE_CONFIG_HTTPD=y

### 3. Generate a Tailscale auth key

https://login.tailscale.com/admin/settings/keys → Generate auth key
- Reusable: ON
- Ephemeral: OFF (identity must survive reboots)
- Optional: tag it (e.g. tag:iot) if your tailnet uses tags
- Copy the tskey-auth-... value. It goes in the firmware config below and
  must stay private (it only lives in your code/sdkconfig).

### 4. Firmware changes (small, additive)

Your existing WiFi + Modbus + web-server code stays exactly as it is. Add:

a) In main (after your WiFi is connected):

    #include "microlink.h"

    static microlink_t *ml;

    static void tailscale_init(void) {
        microlink_config_t cfg = {
            .auth_key    = "tskey-auth-XXXX",   // your key
            .device_name = "energymeter",       // becomes energymeter.<tailnet>.ts.net
            .enable_derp = true,
            .enable_disco = true,
            .enable_stun = true,
            .max_peers   = 16,
        };
        ml = microlink_init(&cfg);
        microlink_start(ml);   // WiFi must already be up
    }

b) A push task (every 2 s, when tailscale is connected):

    static void tailscale_push_task(void *arg) {
        // Buffer for the JSON you already build for /api/readings
        while (1) {
            vTaskDelay(pdMS_TO_TICKS(2000));
            if (!ml || !microlink_is_connected(ml)) continue;

            // Reuse your existing JSON builder for /api/readings
            const char *body = build_readings_json();   // your function
            size_t body_len = strlen(body);

            // Hostname resolution works too: microlink_resolve(ml, "jetson-energy")
            microlink_tcp_socket_t *sock =
                microlink_tcp_connect(ml, "100.75.214.91", 8090);
            if (!sock) continue;

            char head[256];
            int n = snprintf(head, sizeof(head),
                "POST /api/ingest HTTP/1.0\r\n"
                "Host: jetson-energy\r\n"
                "User-Agent: EnergyAnalyzer-OTA/%s\r\n"   // running firmware version
                "Content-Type: application/json\r\n"
                "Content-Length: %u\r\n"
                "Connection: close\r\n"
                "\r\n", FIRMWARE_VERSION, (unsigned)body_len);
            microlink_tcp_send(sock, head, n);
            microlink_tcp_send(sock, body, body_len);
            microlink_tcp_close(sock);
        }
    }

    // start it: xTaskCreate(tailscale_push_task, "ts_push", 8192, NULL, 5, NULL);

Notes:
- microlink's TCP connect does the WireGuard handshake on demand; the first
  push after boot may take a few seconds. Failures just skip a tick.
- The old LAN dashboard (http://energymeter.local/) keeps working unchanged.
- Menuconfig alternative to hardcoding: MicroLink V2 → Credentials.

### 5. Build, flash, approve

    source ~/esp/esp-idf/export.sh
    idf.py build
    idf.py -p <COM_PORT> flash monitor

First boot prints a Tailscale approval/enrollment URL. Open it in a browser
logged into your tailnet account, approve the node → "energymeter" appears
in Machines. In the Machines page, set Key expiry: Disabled for the node.

### 6. Verify

On this server (Jetson):

    tailscale ping energymeter        # pong via DERP/direct
    tailscale status                  # energymeter listed

Then open the dashboard (http://localhost:8090/): Settings → Data source
should show Source: ESP32 device, Data flow: ESP32 → server (push), meter
sequence advancing. The dashboard switches automatically on first push.

### 7. Installing it remotely

Nothing to change. On any network, the ESP32 reconnects through Tailscale's
DERP relays (HTTPS 443 outbound), then the server sees fresh pushes again.
Optionally disable the now-useless LAN poll on the server:

    ESP32_URL='' node server.js

(pull is also auto-disabled in push mode — poll errors never flip the status).

## Troubleshooting

- No approval URL in the log → wrong/expired auth key; regenerate.
- tailscale ping says node offline → ESP32 lost WiFi; check your WiFi logic.
- Pushes arrive but readings look stale → the analyzer/USB side, not the link;
  the meter object carries `stale` and the dashboard shows the same warning
  your old ESP32 dashboard did.
- Jetson unreachable from ESP32 → the server binds 0.0.0.0:8090 and the
  Jetson's tailnet IP is 100.75.214.91 (verified: pong 1ms to the laptop).
