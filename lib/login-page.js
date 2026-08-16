/**
 * dsh-remote — self-contained login page.
 *
 * Served by the gated fallback for unauthenticated browsers, so it must not
 * reference any bundled asset (everything is inline). The page is a complete
 * auth surface on its own:
 *   - bootstrap: no account exists yet -> create the first admin (loopback only)
 *   - login:     username + password
 *   - mfa code:  accounts with two-factor enabled -> 6-digit code / backup code
 *   - mfa offer: accounts without two-factor -> optional in-place binding
 *                (secret, otpauth link, backup codes, verify) using the session
 *                cookie the password step just issued
 * On completion it redirects to `next` (the originally requested path) or `/`.
 */

/** HTML-escape user-controlled values (the `next` path). */
function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/**
 * @param {object} options
 * @param {boolean} options.bootstrap - whether to show the first-admin form.
 * @param {string} options.next - path to redirect to after login.
 * @param {string} [options.error] - pre-rendered error message.
 * @param {string} [options.title] - page title text.
 * @returns {string} the full HTML document.
 */
export function renderLoginPage({ bootstrap, next = "/", error = "", title = "DeepSeek Harness" }) {
	const heading = bootstrap ? "创建首个管理员账号" : "登录 DeepSeek Harness";
	const button = bootstrap ? "创建管理员账号" : "登录";
	const endpoint = bootstrap ? "/auth/bootstrap" : "/auth/login";
	const hint = bootstrap
		? "尚未配置任何账号。出于安全考虑，首个管理员账号只能在本地（loopback）创建。"
		: "请输入用户名和密码。";
	const errorHtml = error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : "";
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 登录</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1117;
    --panel: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #4c8bf5;
    --accent-hover: #5d9bfa;
    --danger: #f85149;
    --ok: #3fb950;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", "Noto Sans", sans-serif;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 420px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 28px 26px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, .35);
  }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
  .sub { color: var(--muted); font-size: 13px; line-height: 1.6; margin-bottom: 20px; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 14px 0 6px; }
  input[type="text"], input[type="password"] {
    width: 100%; padding: 9px 12px;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 8px;
    font-size: 14px; outline: none;
  }
  input:focus { border-color: var(--accent); }
  button {
    width: 100%; margin-top: 20px; padding: 10px 12px;
    background: var(--accent); color: #fff;
    border: 0; border-radius: 8px; font-size: 14px; font-weight: 500;
    cursor: pointer;
  }
  button:hover { background: var(--accent-hover); }
  button:disabled { opacity: .6; cursor: wait; }
  button.secondary {
    background: transparent; color: var(--text);
    border: 1px solid var(--border); margin-top: 10px;
  }
  button.secondary:hover { background: rgba(255, 255, 255, .05); }
  .error {
    margin-top: 16px; padding: 9px 12px;
    background: rgba(248, 81, 73, .12); color: var(--danger);
    border: 1px solid rgba(248, 81, 73, .35); border-radius: 8px;
    font-size: 13px;
  }
  .note { margin-top: 16px; font-size: 12px; color: var(--muted); text-align: center; }
  .ttl { margin-top: 6px; font-size: 12px; color: var(--muted); }
  .ttl.warn { color: var(--danger); }
  .ok { margin-top: 16px; padding: 9px 12px; background: rgba(63, 185, 80, .12); color: var(--ok); border: 1px solid rgba(63, 185, 80, .35); border-radius: 8px; font-size: 13px; }
  .secret {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; word-break: break-all;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 9px 10px; margin-top: 4px;
    user-select: all;
  }
  .codes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .codes span {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 3px 8px;
  }
  .offer { margin-top: 18px; border-top: 1px solid var(--border); padding-top: 14px; }
</style>
</head>
<body>
  <form class="card" id="form" autocomplete="on" novalidate>
    <h1 id="heading">${heading}</h1>
    <div class="sub" id="sub">${hint}</div>

    <div id="fields">
      <label for="username">用户名</label>
      <input type="text" id="username" name="username" autocomplete="username" required spellcheck="false">
      <label for="password">密码</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
    </div>

    <div id="code-step" hidden>
      <label for="code">两步验证码（或备用码）</label>
      <input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
      <div class="ttl" id="code-ttl"></div>
    </div>

    <div id="offer" hidden>
      <div class="ok">双重验证尚未开启。现在用认证器 App 绑定，为账号加一层保护。</div>
      <button type="button" id="offer-bind" class="secondary">绑定双重验证</button>
      <button type="button" id="offer-skip" class="secondary">跳过，直接进入</button>
    </div>

    <div id="setup" hidden>
      <p class="sub">用认证器 App（Google Authenticator、1Password、Authy 等）添加账号：</p>
      <div id="setup-qr-wrap" style="display:flex;justify-content:center;margin:6px 0 2px">
        <img id="setup-qr" alt="扫码绑定二维码" style="width:180px;height:180px;image-rendering:pixelated;border-radius:8px" hidden>
      </div>
      <label>或手动录入密钥</label>
      <div class="secret" id="setup-secret"></div>
      <label>otpauth 链接</label>
      <div class="secret" id="setup-otpauth"></div>
      <label>一次性备用码（每个仅可使用一次，请妥善保存）</label>
      <div class="codes" id="setup-codes"></div>
      <label for="setup-code">在认证器中输入当前 6 位验证码以启用：</label>
      <input type="text" id="setup-code" inputmode="numeric" autocomplete="one-time-code">
      <div class="ttl" id="setup-ttl"></div>
    </div>

    ${errorHtml}
    <button type="submit" id="submit">${button}</button>
    <div class="note" id="note" hidden></div>
  </form>
<script>
(function () {
  var form = document.getElementById("form");
  var submit = document.getElementById("submit");
  var note = document.getElementById("note");
  var heading = document.getElementById("heading");
  var sub = document.getElementById("sub");
  var fields = document.getElementById("fields");
  var codeStep = document.getElementById("code-step");
  var codeInput = document.getElementById("code");
  var offer = document.getElementById("offer");
  var setup = document.getElementById("setup");
  var endpoint = ${JSON.stringify(endpoint)};
  var next = ${JSON.stringify(next)};
  var mfaToken = null;
  var phase = "password"; // password | code | offer | setup
  // Live TOTP countdown: updates the element with the seconds left in the
  // current 30s window, so a stale code is obvious before submission.
  var startCountdown = function (el) {
    el.className = "ttl";
    var tick = function () {
      var remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
      el.textContent = "有效剩余 " + remaining + " 秒";
      el.classList.toggle("warn", remaining <= 5);
    };
    tick();
    var timer = setInterval(tick, 1000);
    return function () { clearInterval(timer); };
  };
  var stopCountdown = null;
  var showError = function (message) {
    var old = form.querySelector(".error");
    if (old && !old.parentNode.hidden) old.remove();
    var err = document.createElement("div");
    err.className = "error";
    err.setAttribute("role", "alert");
    err.textContent = message;
    form.insertBefore(err, submit);
    submit.disabled = false;
  };
  var go = function (path) { location.href = path && path.indexOf("/") === 0 ? path : "/"; };
  var bindOffer = function () {
    phase = "offer";
    heading.textContent = "绑定双重验证";
    sub.textContent = "为账号 " + (form.querySelector("#username") ? document.getElementById("username").value.trim() : "") + " 开启两步验证。";
    fields.hidden = true;
    codeStep.hidden = true;
    offer.hidden = false;
    setup.hidden = true;
    submit.hidden = true;
    submit.disabled = false;
    note.hidden = true;
  };
  var startSetup = async function () {
    note.hidden = false;
    note.textContent = "正在生成密钥…";
    try {
      var res = await fetch("/auth/mfa/setup", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: "{}"
      });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || "setup failed");
      phase = "setup";
      heading.textContent = "绑定双重验证";
      sub.textContent = "第 1 步：在认证器 App 中添加以下账号（扫描或手动录入）。";
      offer.hidden = true;
      setup.hidden = false;
      submit.hidden = false;
      submit.disabled = false;
      submit.textContent = "验证并启用";
      document.getElementById("setup-secret").textContent = data.secret;
      document.getElementById("setup-otpauth").textContent = data.otpauth;
      var qrImg = document.getElementById("setup-qr");
      if (data.qr) {
        qrImg.src = data.qr;
        qrImg.hidden = false;
      }
      var codes = document.getElementById("setup-codes");
      codes.innerHTML = "";
      (data.backupCodes || []).forEach(function (c) {
        var s = document.createElement("span");
        s.textContent = c;
        codes.appendChild(s);
      });
      note.hidden = true;
      if (stopCountdown) stopCountdown();
      stopCountdown = startCountdown(document.getElementById("setup-ttl"));
      document.getElementById("setup-code").focus();
    } catch (e) {
      note.hidden = true;
      showError(String(e.message || e));
    }
  };
  var verifySetup = async function () {
    var code = document.getElementById("setup-code").value.trim();
    if (!code) return;
    note.hidden = false;
    note.textContent = "正在验证…";
    try {
      var res = await fetch("/auth/mfa/verify", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ code: code })
      });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || "invalid code");
      setup.hidden = true;
      submit.hidden = true;
      var ok = document.createElement("div");
      ok.className = "ok";
      ok.textContent = "双重验证已启用。请保存好备用码。";
      form.insertBefore(ok, submit);
      setTimeout(function () { go(next); }, 1500);
    } catch (e) {
      note.hidden = true;
      showError(String(e.message || e));
    }
  };
  document.getElementById("offer-bind").addEventListener("click", startSetup);
  document.getElementById("offer-skip").addEventListener("click", function () { go(next); });
  // Real-time verification: a complete 6-digit TOTP code submits immediately
  // (backup codes contain letters and still use the button).
  var bindAutoVerify = function (input, onComplete) {
    input.addEventListener("input", function () {
      if (/^\\d{6}$/.test(input.value.trim())) onComplete();
    });
  };
  bindAutoVerify(document.getElementById("setup-code"), function () { verifySetup(); });
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    doSubmit();
  });
  var doSubmit = async function () {
    if (phase === "setup") { verifySetup(); return; }
    submit.disabled = true;
    note.hidden = false;
    var payload;
    if (phase === "code") {
      var code = codeInput.value.trim();
      if (!code) { submit.disabled = false; note.hidden = true; return; }
      note.textContent = "正在验证…";
      payload = { mfaToken: mfaToken, code: code };
    } else {
      var username = document.getElementById("username").value.trim();
      var password = document.getElementById("password").value;
      if (!username || !password) { submit.disabled = false; note.hidden = true; return; }
      note.textContent = "正在验证…";
      payload = { username: username, password: password };
    }
    try {
      var res = await fetch(phase === "code" ? "/auth/mfa/login" : endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload)
      });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (res.ok && data && data.ok && !data.mfaRequired) {
        // Session issued. Accounts without two-factor get the optional binding offer.
        if (data.mfa === false && phase !== "setup") { bindOffer(); return; }
        note.textContent = "登录成功，正在跳转…";
        go(next);
        return;
      }
      if (res.ok && data && data.mfaRequired && data.mfaToken) {
        phase = "code";
        mfaToken = data.mfaToken;
        heading.textContent = "两步验证";
        sub.textContent = "请输入认证器中的动态验证码（或一次性备用码）。";
        fields.hidden = true;
        codeStep.hidden = false;
        offer.hidden = true;
        setup.hidden = true;
        codeInput.required = true;
        codeInput.focus();
        if (stopCountdown) stopCountdown();
        stopCountdown = startCountdown(document.getElementById("code-ttl"));
        note.hidden = true;
        submit.disabled = false;
        submit.textContent = "验证";
        return;
      }
      var message = (data && (data.error || data.message)) || ("登录失败 (" + res.status + ")");
      note.hidden = true;
      showError(message);
      var target = phase === "code" ? codeInput : document.getElementById("password");
      if (target) target.select();
    } catch (e) {
      note.hidden = true;
      submit.disabled = false;
    }
  };
  bindAutoVerify(codeInput, function () { doSubmit(); });
})();
</script>
</body>
</html>`;
}
