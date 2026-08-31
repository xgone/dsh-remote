# dsh-remote

[![npm version](https://img.shields.io/npm/v/@xgone/dsh-remote.svg)](https://www.npmjs.com/package/@xgone/dsh-remote)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[English](README.en.md)** | [中文](README.md)

**Make DeepSeek Harness safely accessible remotely**: a full account/password authentication +
MFA (two-factor) gate in front of `dsh web`, plus everything needed for remote deployments — an
external browser can sign in and use the full feature set (including workspace selection and
"Add workspace"), without any native window ever popping up on the host machine.

### Screenshots

| Login gate (any path, unauthenticated) | Settings → Auth & Accounts |
|:---:|:---:|
| ![Login page](docs/login-en.png) | ![Account management settings](docs/settings-en.png) |

---

## 1. Features (user perspective)

### 1.1 Remote access to dsh

- **Works over the internet / LAN**: once exposed behind a reverse proxy (nginx / ssh tunnel /
  Tailscale / Frp, …), an external browser can sign in and use everything. DSH's built-in `/api`
  trust fence hard-codes privileged methods (`host.pickDirectory`, `settings.*`, `credentials.*`,
  …) to loopback (the official note says "until a real authentication layer exists") — this plugin
  is that authentication layer and lets them through after authentication.
- **No host OS dialogs for workspace selection**: DSH's default directory picker calls the host's
  native OS chooser on loopback deployments (invisible to remote users). This plugin swaps the
  picker to the **browse backend** — selecting/creating a workspace becomes an **in-browser
  directory dialog** (two-pane directory view + breadcrumbs + "new folder").
- **WebSocket works end to end**: the event downlinks (`events.mux` / `events.host`) establish
  normally after authentication.

### 1.2 Account/password authentication

- **Complete login gate**: unauthenticated access to any path gets a self-contained login page;
  `/api` and WebSocket all require a valid session cookie.
- **Secure sessions**: HMAC-SHA256-signed HttpOnly cookies (configurable expiry, Secure,
  SameSite); the signing secret is randomly generated and persisted (sessions survive restarts).
- **Passwords stored safely**: scrypt hashes (`N=16384,r=8,p=1`) + constant-time comparison,
  plaintext is never written to disk.
- **Brute-force protection**: failed logins are rate limited per IP + username (default 5 attempts
  in a 15-minute window).
- **First-run bootstrap**: when no account exists, the login page offers "create the first admin",
  submit only from the local machine (loopback) to prevent remote pre-registration.
- **First account is protected**: the root account cannot be deleted or re-roled, only its
  password can be reset (prevents locking yourself out by deleting the only admin).
- **Admin-only mode (default)**: creating accounts at runtime is refused, every account is forced
  to the admin role, and the "add account" form is hidden in Settings; set `adminOnly: false` to
  re-enable multi-role account management.
- **Optional roles**: with `adminOnly` off, three method-level roles are available —
  `admin` / `user` / `guest`.

### 1.3 MFA two-factor authentication (TOTP)

- **Works with standard authenticators**: Google Authenticator, 1Password, Authy, … (RFC 6238,
  6 digits / 30 s).
- **Scan-to-bind**: enabling shows a QR code (SVG, verified scannable) + manual secret + otpauth
  link + 10 one-time backup codes (backup codes are stored as SHA-256 hashes only).
- **Live verification on sign-in**: the login page and the re-login overlay show a "valid for Ns"
  countdown and **auto-submit** once 6 digits are entered (backup codes contain letters and still
  use the button).
- **Admin recovery**: an admin can disable MFA for any account using their own password.

### 1.4 UX details

- The login page is a complete auth surface on its own: password → code / in-place binding guide
  (with QR code);
- When the session expires, a full-screen re-login overlay appears inside the SPA with
  auto-verify input;
- Settings → Auth & Accounts: MFA self-service (enable/disable), account list (card style), reset
  password, log out button.

**Mobile / touch polish** (DSH is desktop-first; this plugin fills the gaps on narrow viewports):

- **Enter no longer misfires send**: on coarse-pointer (touch) devices the chat composer's
  **Enter** inserts a newline instead of sending — the keyboard's return key is easy to hit
  accidentally on phones. Sending goes through the send button (or a hardware keyboard's
  modifier+Enter).
- **Narrow-layout injection** (≤767px): DSH's session header crams the breadcrumb title, action
  buttons and the utility pill (mode / session log) into one row where they collide, and the view
  tabs can be clipped. The plugin injects a narrow-viewport stylesheet that lets the title row
  **wrap** and the view tabs **scroll horizontally**, and keeps the composer tool row wrapping so
  the model pill truncates instead of pushing the send button off-screen.
- **Remote file panel**: the fixed 460px right-hand panel overflowed phone screens; it now fits
  the viewport (drag-resizable) instead of spilling past the edge.
- **Login / re-login overlay**: on small screens the inset shrinks and the card is height-capped
  and **scrolls internally**, so the fields stay reachable after the on-screen keyboard opens.

**AbortSignal compatibility**: DSH's client merges the RPC timeout with the caller's abort signal
via `AbortSignal.any([AbortSignal.timeout(ms), signal])`; Apple-device Chrome (really WKWebView) and
Safari < 17.4 lack `AbortSignal.any`, so **every message send threw
"AbortSignal.any is not a function"** and failed. The plugin installs a spec-compatible
`AbortSignal.any` (plus a `.timeout` fallback) at client module load — no DSH source touched.

### 1.5 Localization (`zh` / `en`)

Every plugin surface — the login page, MFA binding guide, re-login overlay, and the Settings →
Auth & Accounts page — ships in both English and Chinese, following the **DSH app language**
(Settings → General → Language):

- **Login page**: server-rendered; prefers `locale.preference` in `$DSH_HOME/settings.yaml` (the
  DSH app language) and falls back to the browser's `Accept-Language` when unset;
- **In-app UI**: wired into the official `@deepseek-ai/dsh-client-locale` service (`ctx.locale`) —
  the plugin registers its zh/en dictionaries and follows language switches live: the settings
  page and overlays update instantly, no refresh needed.

**Remote-browser language persistence**: by design DSH pins the whole settings plane to loopback
— settings reads/writes from non-loopback (remote) browsers stay in memory, so the language
preference reverts on every refresh under DSH's native mechanism. As the authentication layer for
remote deployments, this plugin takes over both directions of the language preference for
non-loopback browsers:

- **Read**: at boot, the persisted preference is fetched via the standard `settings.describe` RPC
  and applied to the UI (the login page reads the same preference server-side);
- **Write**: every language switch is mirrored into `settings.yaml` via the standard
  `settings.mutate` RPC — consistent across browsers and devices.

Local (`127.0.0.1` / `localhost`) access keeps DSH's native host-backed path untouched. Both
directions use the same standard RPC envelope DSH's own UI uses — no host internals are patched.

**Light / dark theme**: every plugin surface (login page, MFA setup, re-auth overlay, settings
page, remote file panel) takes its colors from DSH's official design tokens (`--dsw-alias-*`),
so it follows DSH's appearance setting (light / dark / system) automatically — no separate theme
configuration.

---

## 2. Installation

### 2.0 Prerequisites

- DeepSeek Harness installed and able to run `dsh web` (default port 3080);
- A `web` profile initialized (running `dsh web` once does this automatically);
- `pnpm` on PATH (`dsh plugin` uses it to manage profile plugins).

### 2.1 Install the plugin package

**Install from npm (recommended)** — the plugin is published on the npm registry:

```sh
dsh plugin --profile web add @xgone/dsh-remote
```

> - Package page: https://www.npmjs.com/package/@xgone/dsh-remote
> - Pin a version: `dsh plugin --profile web add @xgone/dsh-remote@0.1.1`

Other ways to install:

```sh
# From the public Git repository
dsh plugin --profile web add git@github.com:xgone/dsh-remote.git

# From a local source checkout (development / personal use — adjust the path)
dsh plugin --profile web add ~/path/to/dsh-remote
```

`dsh plugin` does three things:

1. Installs the package with pnpm under `~/.dsh/profiles/web/` (output `+ @xgone/dsh-remote`
   means success);
2. Automatically appends `@xgone/dsh-remote` to the profile's `dsh.profile.bundles` (the package
   declares `dsh.bundle.patch`) — no manual config needed;
3. The plugin takes effect at the next boot's composition.

### 2.2 Verify the install

```sh
# dsh-remote should appear in the bundles list
python3 -c "import json; print(json.load(open('$HOME/.dsh/profiles/web/package.json'))['dsh']['profile']['bundles'])"
# Expected output similar to: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@xgone/dsh-remote']
```

### 2.3 Restart `dsh web`

HMR is disabled on the web surface, so a patch cannot hot-reload — **a restart is required**:

```sh
# Stop the current dsh web process and start it again (or restart your launcher)
dsh web
```

### 2.4 First boot: create the admin

After restarting, open `http://127.0.0.1:3080` in your browser:

1. An unauthenticated visit shows the **login page** (self-contained, not an SPA);
2. With no account yet, the login page is in **bootstrap mode**: the title reads "Create the first
   admin account";
3. Enter a username and password (at least 6 characters) and click create — **loopback only**, to
   prevent remote pre-registration;
4. Creation signs you in immediately (a session cookie is issued).

> Verify: `curl http://127.0.0.1:3080/auth/me` should return
> `{"authEnabled":true,"bootstrap":false,"authenticated":true,...}`.

### 2.5 Bind MFA (recommended)

After signing in, go to **Settings → Auth & Accounts → Two-factor authentication (MFA) → Enable
two-factor**:

1. The page shows a **QR code** (scan with Google Authenticator / 1Password / Authy);
2. It also shows the manual secret, the otpauth link and **10 one-time backup codes** — save the
   backup codes first;
3. Enter the current 6-digit code from your authenticator → it auto-verifies and enables;
4. Every sign-in afterwards requires password + code (or backup code).

> You don't have to enter Settings: after the password step, the login page itself offers the
> "bind two-factor" guide when MFA is not yet enabled.

### 2.6 Verify the installation

- Unauthenticated visit to any path → login page; calling `/api` directly → 403;
- After signing in, `/api`, the WebSocket event stream and workspace selection (in-browser
  directory dialog) all work;
- After the session expires (or you log out) you return to the login page.

### 2.7 Uninstall

```sh
dsh plugin --profile web remove @xgone/dsh-remote
```

`dsh plugin` runs pnpm remove and automatically drops the package from `dsh.profile.bundles`;
after restarting `dsh web` the gate is gone. `$DSH_HOME/auth/store.json` and the account data are
kept (delete that file manually if you want a complete reset).

### 2.8 FAQ

| Symptom | Fix |
|---|---|
| No login page after install | Not restarted: run `dsh web` again; or `@xgone/dsh-remote` is missing from the bundles list (re-run `dsh plugin --profile web add ...`) |
| Login form submits but nothing happens | Make sure username/password are filled; `content-script.js` errors in the browser console are extension noise and can be ignored |
| 403 when creating the admin | bootstrap is loopback-only: operate from a local browser, or access `127.0.0.1` through `ssh -L`; on a server without a local browser use the `bootstrap` config below to provision the first admin |
| Locked out (misconfiguration) | Set `enabled: false` in `cordis.patch.yml` and restart; or delete `$DSH_HOME/auth/store.json` to re-enter bootstrap mode |
| Lost MFA / phone | An admin can sign in and go to Settings → Auth & Accounts → that account row → Disable MFA (requires the admin password) |
| Settings → Plugins config page is blank over remote access | Built-in fix since v0.1.5: DSH switches every settings scope to memory mode for remote browsers (reads and writes are dropped client-side); the plugin unpins the scope queue at startup and triggers a full refresh, so the config cards are readable and writable remotely. The raw settings.yaml document editor intentionally stays loopback-only |
| "Internal Testing Notice" re-pops on every remote refresh | Built-in fix since v0.1.6 (for users who already acknowledged): DSH's welcome-notice acknowledgement (`WelcomeNoticeStore`) runs in memory mode for remote browsers, so the persisted ack is never read; the plugin reads `ui-onboarding.welcomeNoticeVersion` through the official settings.describe RPC and, when one exists, sets the live store's `acknowledged` flag via the official `store.update` API — WelcomeNotice then auto-finishes and the notice stops re-popping. Uses only official slots/store/RPC; no DSH internals rewritten, no persistence flipped. First-time remote users (no ack yet) keep the original behavior |
| Opening Settings → Models remotely fails with "Failed to load provider catalog: settings are unavailable in this browser" | Built-in fix since v0.2.6: the upgraded DSH routes every settings read through a shared `SettingsDescribeMirror` that is constructed in memory mode for remote browsers (view always undefined), so the Models page rejects. The plugin reads the settings document through the official settings.describe RPC, reaches the mirror through the official `ctx.settingsScope.describe()` service, and folds the document in through the official `store.set` API — the provider catalog loads normally remotely. Uses only official RPC/service/store APIs; no DSH methods rewritten, no persistence flipped |

### 2.6 Headless / Linux server install (no local browser)

On a server without a local browser the "create the first admin" flow (loopback-only) is
unreachable. Provision the first admin at startup from config instead — equivalent to the
loopback bootstrap: same root protection, admin role, scrypt hashing:

```sh
dsh plugin --profile web add @xgone/dsh-remote
# edit ~/.dsh/profiles/web/cordis.patch.yml and add a config to the remote row:
```

```yaml
- id: remote
  config:
    enabled: true
    bootstrap:
      username: admin          # created on first start (only while the account store is empty)
      password: 'pick-a-strong-password'
```

Notes:

- **Idempotent**: once any account exists the config is ignored (the log tells you to remove the
  credentials); it never recreates an account or overwrites an existing password;
- The password must be at least 6 characters (same rule as the UI bootstrap); a violation fails
  startup with a clear error;
- The first account behaves exactly like a UI bootstrap: `protected: true` (cannot be deleted or
  re-roled, password resettable only);
- After first login, remove the config block (leaving it is harmless — it is dead once accounts
  exist); you can bind MFA afterwards in Settings → Auth & Accounts;
- Reverse-proxy deployments only need `trustProxy: true` (already the default).

## 3. Configuration (`cordis.patch.yml`)

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml (overrides the whole config of the `remote` row;
# unlisted keys fall back to schema defaults)
- id: remote
  config:
    enabled: true
    accounts: []            # seed accounts (plaintext passwords are hashed with scrypt at boot; or pass scrypt$<salt>$<hash> directly)
    secret: ''              # empty = auto-generate and persist
    session:
      cookieName: dsh_session
      ttlSeconds: 604800    # 7 days
      secure: false         # set true for HTTPS deployments
      sameSite: lax
    enforceRoles: true      # admin/user/guest method-level permissions
    adminOnly: true         # admin accounts only (default)
    trustProxy: true        # normalize Host/Origin of authenticated requests (default)
    bootstrap:
      username: admin       # optional: provision the first admin on headless servers (only while the store is empty)
      password: '...'
    mfa:
      enabled: true
      issuer: DeepSeek Harness
      window: 1             # allow ±1 30-second step
      backupCodes: 10
    rateLimit:
      maxAttempts: 5
      windowMs: 900000
    gzip:
      enabled: true          # master switch for response gzip compression (default on)
      remoteOnly: true       # compress only remote (non-loopback Host) requests; false compresses local too
      minBytes: 1024         # skip compression when a known Content-Length is below this
    files:
      enabled: true          # master switch for remote file display via /auth/file (default on)
      maxListing: 500        # max entries rendered per directory listing page
```

> **Windows note**: the directories readable by default are the DSH home dir and the dsh
> process working directory (usually the profile dir), while workspace files often live on
> other drive paths. When the pane reports `outside-roots`, sign in as an admin, open
> **Settings > Auth & Accounts > Allowed directories**, and add the workspace directory
> there (e.g. `E:\CODE`; both `E:/CODE` and `E:\\CODE` spellings are accepted in the input)
> — **applied immediately, no config edit, no restart**.

Disable authentication entirely: `enabled: false`.

**Remote file display**: clicking a file path in the DSH web UI fires the `host.openPath`
RPC, which hands the path to the **host** desktop's default application — invisible to a
remote browser user. This plugin intercepts that RPC for remote (non-loopback) browsers and
shows the file in a **right side panel** instead (host-streamed `/auth/file`, Claude
Desktop-style):
- markdown renders with the shell's own markdown renderer; images / PDF / video display
  inline; text and code preview monospaced; directories navigate level by level
- **multiple panes** can be open at once and split the panel vertically; every pane has its
  own maximize (fill the whole sidebar, toggleable) and close button in its top-right corner
- each pane's header shows the file name and full path; the sidebar's left edge is draggable
  to resize; Esc closes the maximized / topmost pane
- non-previewable binaries fall back to download / open-in-new-tab

DSH's native right "details" column (session details, single slot) is untouched — this
sidebar coexists with it as an overlay. **Which files can be viewed by default?** Only
files inside the DSH home directory and the dsh process working directory; anything else
makes the pane report `cannot display file (outside-roots)`. Every read is realpath-checked,
so symlink escapes and `..` traversal are rejected; loopback browsers keep DSH's native
behavior. `files.enabled: false` turns it off entirely.

> **How to allow other directories (done on the settings page — no config edit)**
>
> 1. Sign in as an **admin** and open **Settings > Auth & Accounts > Allowed directories**;
> 2. click **Pick directory** to choose a folder on the host, or paste an absolute path into
>    the input, then click **Add**;
> 3. the change **applies immediately, no restart** — click the file path in the session
>    again and it now renders;
> 4. when it is no longer needed, click **Remove** on that entry to revoke access.
>
> Added directories persist in `$DSH_HOME/dsh-remote-files.json` (0600, written atomically)
> and survive restarts; config-provided roots are listed read-only alongside and are not
> managed from the page. The legacy `files.roots` config option still works (also shown
> read-only), but **new directories should be added through the settings page**. The
> `allowedRoots` hint shown on a rejected panel points straight at this settings page.


**Response gzip compression**: the plugin gzips compressible responses (HTML / CSS / JS /
JSON / SVG / manifest, etc.) served to **authenticated** clients, noticeably shrinking large
history loads and big static bundles over a remote tunnel, and adds `Cache-Control: immutable`
plus `CDN-Cache-Control` to rev-hashed assets so Cloudflare and similar edges cache them. By
default it compresses **only remote (non-loopback Host) browsers** (`gzip.remoteOnly: true`)
to save local CPU; set `false` to also compress local. SSE streams, binary types
(`image/*`, etc.), already-compressed responses (any `Content-Encoding`), `204/206/304` and
small responses (`Content-Length < minBytes`) are never compressed. `gzip.enabled: false`
turns it off completely.

---

## 4. Implementation details

### Architecture overview

The plugin is a **Cordis dual-half package + bundle patch**:

```
dsh-remote/
├── cordis.patch.yml   # bundle patch: inserts the `remote` row; swaps the directory picker backend
├── lib/
│   ├── index.js       # host half: gate, sessions, rate limiting, roles, trustProxy, /auth/* routes
│   ├── store.js       # account store (scrypt hashes, protected flag, TOTP state, backup-code hashes)
│   ├── totp.js        # RFC 6238 TOTP / base32 / otpauth URI / backup codes (zero-dependency)
│   ├── login-page.js  # self-contained login page (password → code → bind guide, incl. QR), zh/en
│   └── client.js      # browser half: re-login overlay, Settings "Auth & Accounts" page, log out
└── package.json       # dsh.bundle.patch + dsh.client declaration + ./client export
```

- After install, `dsh plugin` appends `@xgone/dsh-remote` to `dsh.profile.bundles`; the patch
  composes at boot;
- The host half activates via `inject: ["webServer"]`; the browser half is picked up by the
  client module system into `window.__DSH_BOOT__` and mounts into `settings.section` / overlays.

### 4.1 The gate (`lib/index.js`)

DSH's `webServer` routing model is "exact table → prefix table → fallback" with **no middleware
hook**. The plugin implements a full gate by **wrapping the route-registration methods and
in-place wrapping of already-registered entries**:

- Wraps `register` / `registerUpgrade` / `registerFallback`, and wraps every **already-registered**
  entry in `webServer.exact / prefixes / upgrades` and the `fallback` (a `Symbol` marker prevents
  double wrapping; a `WeakMap` keeps the originals so the unload can restore them);
- Wrapped HTTP handlers: `/auth/*` passes through → without a valid session, page requests get the
  login page and everything else gets 403 → after passing, **Host/Origin are normalized before
  handing off** (see `trustProxy`);
- WebSocket upgrade handshake: no cookie → the socket is destroyed;
- Role gating: non-admin sessions first read the RPC envelope (up to 16 MiB), look up the `method`
  in a deny table and 403 on a hit; allowed requests are handed down with a replayable body
  (`Readable` + `Proxy`); admin requests have zero overhead.

### 4.2 Sessions and credentials

- **Session cookie**: `v1.<base64url payload>.<HMAC-SHA256 sig>`, payload is
  `{sub, role, iat, exp}`; verification recomputes the signature and compares in constant time,
  and the account must still exist (deleting it invalidates the session);
- **MFA challenge token**: `mfa.<payload>.<sig>`, 5-minute validity, single-use (a consumed-nonce
  set prevents replay);
- **Password**: scrypt (`node:crypto`), verified asynchronously at sign-in with constant-time
  comparison;
- **Rate limiting**: in-memory table keyed by `IP:username`; the password step and the MFA step
  use different keys (a failed MFA count is not cleared by a successful password step).

### 4.3 Remote access (`trustProxy`)

DSH's built-in browser trust fence (`dsh-client-connection`) checks `Host` (loopback or
`trustedHosts`), that `Origin` matches the Host, that `sec-fetch-site` is not cross-site, and
**privileged methods** (`host.pickDirectory`, `settings.*`, `credentials.*`, …) are hard-coded to
loopback. After authentication the plugin normalizes the request's `Host`/`Origin` to
`127.0.0.1:<port>` (preserving the original scheme) before handing it down — the fence sees
loopback and privileged methods work for external browsers. Unauthenticated requests are still
403'd by the gate, so the fence's DNS-rebinding semantics are no longer needed behind the cookie.

### 4.4 Storage (`lib/store.js`)

`$DSH_HOME/auth/store.json` (0600, atomic writes):

```jsonc
{
  "version": 1,
  "secret": "<base64url 32B>",          // session/MFA token signing secret
  "accounts": [{
    "username": "admin",
    "role": "admin",
    "passwordHash": "scrypt$<salt>$<hash>",
    "protected": true,                  // first account: cannot be removed or re-roled
    "totp": { "secret": "<base32>", "verified": true, "createdAt": 0 },  // empty when not enabled
    "backupCodes": [{ "hash": "<sha256>", "usedAt": 0 }],                // hashes only
    "createdAt": 0, "updatedAt": 0, "lastLoginAt": 0
  }]
}
```

Migration: if an older store has no `protected` field, the account with the earliest `createdAt`
is automatically marked protected and persisted.

### 4.5 TOTP (`lib/totp.js`, zero-dependency)

- base32 encode/decode (RFC 4648) and `otpauth://` URI construction;
- TOTP = HMAC-SHA1(secret, 8-byte big-endian counter) dynamic truncation to 6 digits, 30-second
  period; verification supports a ±window step; validated against the RFC 6238 SHA-1 appendix
  vectors (T=0..5);
- Backup codes: 10 unambiguous 8-character codes, stored as SHA-256 hashes, each usable once.

### 4.6 Login page (`lib/login-page.js`)

Rendered inline by the wrapped fallback for unauthenticated browsers — **zero external
resources**. State machine: `password → (code | offer) → setup`. i18n: `zh` / `en`, selected at
render time from the request's `Accept-Language`.

- Password step → with MFA, moves to the code step (with a "valid for Ns" countdown and 6-digit
  auto-submit);
- Without MFA, shows the "bind two-factor" guide (skippable);
- The bind step shows the QR code (`/auth/mfa/setup` returns an SVG data URL) + secret + otpauth +
  backup codes + verify input; on success it redirects to `next`;
- The form uses `novalidate` + manual JS validation (so hidden required controls never block
  submission).

### 4.7 Browser half (`lib/client.js`)

Hand-written `window.__ModuleLoader__.load({id, factory})` format (same as official bundles, no
bundler needed), mounted via `require("react")` / `react-dom/client`. All UI copy goes through a
built-in zh/en `t()` table selected by `document.documentElement.lang`.

- **Re-login overlay**: polls `/auth/me` (15 s + on focus); when unauthenticated and auth is
  enabled, a full-screen login overlay covers the app (supports the MFA second step);
- **Settings → Auth & Accounts** (`settings.section` slot with a user icon; CSS hides the shell's
  default gear): status, MFA self-service, account card list (reset password / disable MFA /
  remove), log out;
- **Mobile / touch UX** (see above): touch Enter=newline to avoid misfiring send, narrow-viewport
  header/composer style injection, full-width draggable remote file panel, scrollable login/re-login
  overlay on small screens;
- **AbortSignal polyfill**: installs `AbortSignal.any` / `.timeout` at module load to fix the
  "AbortSignal.any is not a function" message-send failure on Apple-device Chrome (WKWebView) / older
  Safari;
- All data goes through `fetch("/auth/*")` (same-origin cookies), independent of the settings
  domain (third-party code cannot register there).

### 4.8 Directory picker swap (`cordis.patch.yml`)

Patch rows **cannot be renamed** (a `name mismatch` is skipped), so the swap is "disable +
insert":

```yaml
- id: directory-picker        # disable the auto picker (resolves to native on loopback and pops on the host)
  disabled: true
- insert:
    - id: directory-picker-browse      # browse host backend (host.listDirectory / createDirectory)
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
      config: { maxEntries: 1000 }
    - id: directory-picker-browse-ui   # browser-side directory dialog
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

### 4.9 Security model (threat analysis)

| Attack surface | Defense |
|---|---|
| Unauthenticated `/api` / static pages / WebSocket | gate 403 / login page / handshake rejection |
| Password brute force | scrypt + rate limiting (IP+username) |
| Session forgery/tampering | HMAC signature + expiry + constant-time compare + account-existence check |
| Session replay (MFA second step) | single-use nonce + 5-minute TTL |
| Remote admin pre-registration | bootstrap loopback-only |
| Deleting the only admin | protected account + last-admin protection |
| Cross-site requests (CSRF) | HttpOnly + SameSite=lax; cross-site requests carry no cookie, so the gate 403s |
| DNS rebinding | the auth layer takes over the fence semantics; unauthenticated requests never reach the fence |

---

## 5. Remote deployment

`dsh web` still refuses `--host 0.0.0.0`, so expose it through a reverse proxy (TLS
termination + WebSocket forwarding):

```nginx
server {
  listen 8443 ssl;
  server_name dsh.example.com;
  ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket (events.mux/host)
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;                 # preserve the external Host
    proxy_set_header Origin $http_origin;
  }
}
```

The same applies to `ssh -R` tunnels, Tailscale, Frp, etc. For HTTPS deployments set
`session.secure` to `true`.

## 6. Multi-account model (design notes)

- **Done**: multiple accounts + roles (admin/user/guest), centralized management, MFA, audit
  fields (created/updated/last login);
- **Not possible at plugin level**: per-user workspaces/sessions (multi-tenant data isolation) —
  DSH core is single-tenant (`$DSH_HOME` is process-wide), so event streams, search, tasks, etc.
  leak globally and cannot be isolated by a plugin;
- **Recommended**: one profile instance per person (`dsh --profile alice --port 3081`) gives
  natural data isolation; for a shared instance, use the role system.

## 7. Endpoint reference

| Method | Path | Description |
|---|---|---|
| POST | `/auth/login` | Sign in; returns `{mfaRequired, mfaToken}` when MFA is on (no cookie issued) |
| POST | `/auth/mfa/login` | Second step: `{mfaToken, code}` (TOTP or backup code) |
| POST | `/auth/logout` | Clear the cookie |
| GET | `/auth/me` | `{authEnabled, bootstrap, authenticated, username, role, mfa, adminOnly}` |
| POST | `/auth/bootstrap` | First-admin bootstrap (loopback only, empty store only) |
| POST | `/auth/mfa/setup` | Generate secret + otpauth + QR + backup codes (pending state) |
| POST | `/auth/mfa/verify` | Confirm the pending setup with a TOTP code |
| POST | `/auth/mfa/disable` | Disable MFA for the current account (needs password + valid code/backup code) |
| POST | `/auth/accounts` | Admin: `{action: list\|upsert\|remove\|disable-mfa, ...}` |

## 8. Limitations and escape hatches

- HMR is disabled on the web surface — **restart `dsh web`** after config changes;
- Escape hatch: set `enabled: false` and restart to disable the gate; or delete
  `$DSH_HOME/auth/store.json` to re-enter bootstrap mode;
- Restore the native directory picker: see section 4.8 for the patch snippet (invert the
  `disabled` flags).
