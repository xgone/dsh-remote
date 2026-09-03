# Remote access via Cloudflare Tunnel (cloudflared)

> This is a **deployment guide**: expose `dsh web` to the internet through Cloudflare Tunnel —
> no public IP, no open firewall ports, no TLS certificates to manage. Every step lists the
> command and its **expected output**, so the whole thing can be handed to an AI agent (a
> paste-ready deployment brief is included at the end).
>
> English | [中文](CLOUDFLARE-TUNNEL.md)
>
> Related docs: [README](../README.en.md) · [Full configuration reference](./REFERENCE.md) ·
> [Changelog](../CHANGELOG.md)

## How it works

```
External browser ──HTTPS──▶ Cloudflare edge ◀──outbound tunnel── cloudflared (on the dsh host)
                          (automatic TLS)         │ plain HTTP, loopback only
                                                  ▼
                                      127.0.0.1:3080  dsh web + dsh-remote gate
```

- `cloudflared` makes **outbound-only** connections from the host to the Cloudflare edge; the
  host opens no inbound ports at all;
- TLS terminates automatically at the Cloudflare edge; cloudflared talks to dsh over plain
  loopback HTTP, so there is nothing extra to expose;
- The dsh-remote login gate, MFA and sessions work exactly as usual — the tunnel only solves
  "how to get in"; authentication stays the plugin's job;
- `dsh web` only listens on loopback, which matches the tunnel's local origin fetch perfectly.

## Prerequisites

- A domain hosted on Cloudflare (the free plan is enough; Plan A, the quick tunnel, needs no
  domain at all);
- The host can run `dsh web` (default `127.0.0.1:3080`) with dsh-remote installed and
  configured (the login page shows up — see the
  [README quick start](../README.en.md#getting-started));
- The host has outbound internet access (cloudflared needs outbound connections).

> Throughout, replace `dsh.example.com` with your public hostname and `3080` with your actual
> dsh web port.

## Plan A: quick tunnel (5-minute trial)

No domain, no Cloudflare login — ideal for a first smoke test. **The hostname is random and
changes on restart; never use it long-term.**

```sh
# on the dsh host (install cloudflared first — see B0 below)
cloudflared tunnel --url http://127.0.0.1:3080
```

Expected output includes:

```
+--------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://xxxx-yyyy-zzzz.trycloudflare.com                    |
+--------------------------------------------------------------+
```

Open the URL in a browser → the dsh-remote login page should appear. Once verified, `Ctrl+C`
and move on to Plan B/C.

## Plan B: named tunnel (recommended for production, local config file)

### B0. Install cloudflared

```sh
# macOS (brew)
brew install cloudflared

# Debian/Ubuntu (official Cloudflare apt repo)
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

# Windows (admin PowerShell)
winget install --id Cloudflare.cloudflared
```

Verify: `cloudflared --version` prints a version.

### B1. Log in to Cloudflare

```sh
cloudflared tunnel login
```

This prints an authorization URL and tries to open a browser — sign in to Cloudflare and pick
your zone. Expected: `~/.cloudflared/cert.pem` is created (Windows:
`C:\Users\<you>\.cloudflared\cert.pem`).

> Host without a browser? Copy the printed URL to any machine with a browser and authorize
> there.

### B2. Create the tunnel

```sh
cloudflared tunnel create dsh
```

Expected output:

```
Created tunnel dsh with id 6ff42ae2-765d-4adf-8684-xxxxxxxxxxxx
```

Note the **tunnel UUID** and confirm the credentials file
`~/.cloudflared/6ff42ae2-….json` exists.

### B3. Write the config file

Create `~/.cloudflared/config.yml` (Windows: `C:\Users\<you>\.cloudflared\config.yml`):

```yaml
tunnel: 6ff42ae2-765d-4adf-8684-xxxxxxxxxxxx          # the UUID from B2
credentials-file: /home/USER/.cloudflared/6ff42ae2-765d-4adf-8684-xxxxxxxxxxxx.json  # actual path

ingress:
  - hostname: dsh.example.com                          # your public hostname
    service: http://127.0.0.1:3080                     # local dsh web address (adjust port)
    originRequest:
      # Optional: send the public hostname as the Host header to dsh (by default cloudflared
      # rewrites it to 127.0.0.1:3080). Everything works without it; setting it makes the
      # plugin's "remote" detection and logs more accurate — see "Optional tuning".
      httpHostHeader: dsh.example.com
  - service: http_status:404                           # required catch-all rule
```

### B4. Bind the hostname (creates the CNAME)

```sh
cloudflared tunnel route dns dsh dsh.example.com
```

Expected: a proxied CNAME pointing at `<UUID>.cfargotunnel.com` appears in Cloudflare DNS.

### B5. Run in the foreground (smoke test)

```sh
cloudflared tunnel run dsh
```

Expected log lines: `Registered tunnel connection` (usually 4 of them). Opening
`https://dsh.example.com` in a browser should now show the login page. After confirming,
`Ctrl+C` and continue with the service install.

### B6. Install as a system service (auto-start on boot)

```sh
# Linux (systemd) / macOS (launchd) / Windows (admin)
sudo cloudflared service install        # no sudo on macOS; admin PowerShell on Windows
```

Expected: the service is registered and started immediately; it auto-starts on boot from now
on. Manage with `sudo systemctl status cloudflared` (Linux) / the Windows Services console.

## Plan C: dashboard-managed tunnel (no config file to maintain)

Fully dashboard-driven; the config lives on Cloudflare's side (handy when managing several
connectors):

1. Sign in at the [Cloudflare Dashboard](https://dash.cloudflare.com/) →
   **Zero Trust** → **Networks → Tunnels** → **Create a tunnel**, type **Cloudflared**;
2. Name it (e.g. `dsh`) → after saving, the page shows an **install command with a token** —
   run it verbatim on the dsh host; the connector comes online;
3. On that tunnel's **Public Hostname** tab add a route:
   - Subdomain: `dsh`, Domain: `example.com` (pick from the dropdown);
   - Service: Type `HTTP`, URL `127.0.0.1:3080`;
   - (optional) Additional application settings → HTTP → HTTP Host Header: `dsh.example.com`;
4. Save — the DNS record is created automatically; verify `https://dsh.example.com` in a
   browser.

## dsh-remote side configuration

Edit `~/.dsh/profiles/web/cordis.patch.yml` — one recommended change, everything else stays
default:

```yaml
- id: remote
  config:
    enabled: true
    session:
      secure: true        # the only recommended change: the public path is HTTPS, mark
                          # the session cookie Secure
```

**Why nothing else needs changing:**

- `trustProxy` (default `true`): after authentication the plugin normalizes Host/Origin to the
  loopback authority so DSH's loopback trust fence lets privileged methods through — required
  behind a tunnel;
- `browserAuth` (default `true`): mints the `dsh-auth-*` cookies required by dsh ≥ 0.1.2-alpha
  automatically (plugin ≥ 0.3.1; **sign in once more** after upgrading);
- `gzip` (default on): the Cloudflare edge compresses text responses anyway, so both ends never
  conflict regardless of the Host header cloudflared sends;
- The plugin already serves rev-hashed static assets with `Cache-Control: immutable` and
  `CDN-Cache-Control`, which is exactly what Cloudflare's default caching expects (HTML / API
  responses are not cached by default, so the login page is never cached).

**Restart `dsh web`** for config changes to take effect (HMR is disabled on the web surface).

> **Optional tuning (`httpHostHeader`)**: by default cloudflared rewrites the Host header sent
> to the origin to the service address (`127.0.0.1:3080`) — the link works fine. Setting
> `httpHostHeader` to your public hostname (as in B3 / C-3) makes dsh see the real host, so the
> plugin's `gzip.remoteOnly` remote detection, the file-panel interception and access logs are
> all more accurate. Recommended.

## Verification checklist

Run in order; every step has a definite expectation (agent-friendly assertions):

```sh
# 1. Tunnel online: should return 200
cloudflared tunnel info dsh
curl -s -o /dev/null -w '%{http_code}\n' https://dsh.example.com/        # expect 200 (login page)

# 2. Auth surface reachable: /auth/me must be visible and unauthenticated
curl -s https://dsh.example.com/auth/me
# expect {"authEnabled":true,"bootstrap":false,"authenticated":false, ...}

# 3. Gate blocks /api: must be 403 without a session
curl -s -o /dev/null -w '%{http_code}\n' https://dsh.example.com/api     # expect 403

# 4. First-admin bootstrap is loopback-only: must be rejected over the public hostname
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://dsh.example.com/auth/bootstrap  # expect 403
```

Browser verification (one manual step):

1. Open `https://dsh.example.com` → the login page appears with a valid HTTPS padlock;
2. Sign in (password + MFA) → the workspace loads;
3. DevTools → Network → WS: `/api/remote.mux` (or `events.mux`) shows 101 / stays connected,
   session messages stream in;
4. Click a file path → the remote file panel renders correctly.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Browser shows Cloudflare error 1033 | cloudflared is not running / tunnel name or UUID misconfigured | `cloudflared tunnel run dsh` and read the log; with the service installed check `systemctl status cloudflared` |
| 530 / 1016 | DNS record missing or not pointing at the tunnel | Re-run `cloudflared tunnel route dns dsh <hostname>`; for dashboard tunnels check the Public Hostname |
| After login every `/api` call returns 401 | dsh ≥ 0.1.2-alpha requires `dsh-auth-*` cookies; plugin < 0.3.1 | Upgrade the plugin to ≥ 0.3.1 and **sign in once more** (old sessions self-heal on the next request) — see the [CHANGELOG](../CHANGELOG.md) |
| MFA codes always rejected | Host clock drift (TOTP counts 30-second steps) | Sync the host clock: `sudo timedatectl set-ntp true` (or the platform's NTP service) |
| Login page loads, but you bounce back after signing in / cookies ignored | `session.secure: true` while accessing over plain HTTP | Access via the `https://` hostname; loopback access on modern browsers accepts Secure cookies |
| WebSocket keeps disconnecting and reconnecting | The edge reaps long-idle connections | Normal — the DSH client reconnects automatically; if it happens too often, upgrade the plugin and dsh first |
| Large uploads fail | Cloudflare free plan caps a single request upload at 100 MB | Unrelated to the plugin; avoid huge uploads over the public path |
| Public hostname unreachable (though `route dns` succeeded) | DNSSEC / proxy status issue on the record | Check the CNAME is proxied (orange cloud); tunnel hostnames must be proxied |

## Appendix: paste-ready deployment brief for AI agents

Copy the whole block below to an AI agent (with shell access on the dsh host), replacing the
angle-bracket variables:

```text
Goal: on this machine, deploy a Cloudflare Tunnel for dsh web (127.0.0.1:3080) under the
public hostname <dsh.example.com>, and install cloudflared as a boot-persistent service.
Proceed step by step with verification.

Rules:
1. For each step, state the command first, run it, and compare against the expectation before
   continuing; on failure stop and report — do not improvise around the goal;
2. Only touch files under ~/.cloudflared/ and system services; do not modify any dsh or
   dsh-remote configuration;
3. Never create or push any git tag (in this repository, pushing a tag auto-publishes to npm).

Steps:
1. Check dsh web: curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/
   Expect 200 or 401/403 (a login gate is fine). Stop on failure.
2. Install cloudflared (brew / official apt repo / winget depending on platform); verify with
   cloudflared --version.
3. cloudflared tunnel login; if the host has no browser, print the authorization URL and wait
   for me to finish it, then confirm with ls ~/.cloudflared/cert.pem.
4. cloudflared tunnel create dsh; record the UUID from the output and confirm
   ~/.cloudflared/<UUID>.json exists.
5. Write ~/.cloudflared/config.yml:
   tunnel: <UUID>
   credentials-file: <absolute path>/.cloudflared/<UUID>.json
   ingress:
     - hostname: <dsh.example.com>
       service: http://127.0.0.1:3080
       originRequest:
         httpHostHeader: <dsh.example.com>
     - service: http_status:404
6. cloudflared tunnel route dns dsh <dsh.example.com>
7. Run cloudflared tunnel run dsh in the foreground, confirm "Registered tunnel connection"
   appears in the log, then Ctrl+C.
8. sudo cloudflared service install && systemctl enable --now cloudflared (adjust per
   platform); cloudflared tunnel info dsh to confirm the connector is online.
9. Verify:
   a. curl -s -o /dev/null -w '%{http_code}' https://<dsh.example.com>/ → 200
   b. curl -s https://<dsh.example.com>/auth/me → JSON with authenticated:false
   c. curl -s -o /dev/null -w '%{http_code}' https://<dsh.example.com>/api → 403
   All three must pass to call this done.
10. Remind me of the manual steps: set session.secure to true in cordis.patch.yml and restart
    dsh web; sign in in a browser and bind MFA.
```

## Security notes

- The login gate + MFA is the **only authentication layer**: always bind MFA and keep
  `session.ttlSeconds` sensible (7 days by default);
- Hostnames are discoverable: Cloudflare scans common subdomains, so never rely on "nobody
  knows my domain" — the gate must be solid, which is exactly why dsh-remote exists;
- For an extra SSO / IP-policy layer, put the hostname behind **Cloudflare Access** in Zero
  Trust (one more Cloudflare login before reaching the app) — it stacks cleanly with the
  plugin's login gate;
- Login rate limiting (IP + username, 5 attempts / 15 min by default) is enforced inside the
  plugin and keeps working through the tunnel; over a tunnel all clients share the connector's
  origin IP, so limits aggregate per connector — raise `rateLimit.maxAttempts` if needed;
- Quick tunnels (trycloudflare.com) are for trials only; production should use a named tunnel
  on your own domain.
