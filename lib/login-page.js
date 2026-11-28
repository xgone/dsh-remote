import { randomBytes } from "node:crypto";

/**
 * dsh-remote — self-contained login page (all DSH locales).
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
 *
 * i18n: the host passes a DSH locale id (`en`, `zh`, `ja`, `es`, `fr`, `de`,
 * `ru`, `pt`, derived from `locale.preference` then Accept-Language). All
 * user-visible copy is selected from STRINGS at render time, so the page never
 * renegotiates language client-side.
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

/** UI copy. Every locale shares the English key set; unknown keys fall back to en. */
const STRINGS = {
	zh: {
		pageTitle: "登录",
		headingBootstrap: "创建首个管理员账号",
		headingLogin: "登录 DeepSeek Harness",
		buttonBootstrap: "创建管理员账号",
		buttonLogin: "登录",
		hintBootstrap: "尚未配置任何账号。出于安全考虑，首个管理员账号只能在本地（loopback）创建。",
		hintLogin: "请输入用户名和密码。",
		username: "用户名",
		password: "密码",
		code: "两步验证码（或备用码）",
		offerOk: "双重验证尚未开启。现在用认证器 App 绑定，为账号加一层保护。",
		offerBind: "绑定双重验证",
		offerSkip: "跳过，直接进入",
		setupIntro: "用认证器 App（Google Authenticator、1Password、Authy 等）添加账号：",
		qrAlt: "扫码绑定二维码",
		setupSecret: "或手动录入密钥",
		setupOtpauth: "otpauth 链接",
		setupBackup: "一次性备用码（每个仅可使用一次，请妥善保存）",
		setupVerify: "在认证器中输入当前 6 位验证码以启用：",
		countdown: "有效剩余 {n} 秒",
		offerHeading: "绑定双重验证",
		offerSub: "为账号 {user} 开启两步验证。",
		generating: "正在生成密钥…",
		setupStep1: "第 1 步：在认证器 App 中添加以下账号（扫描或手动录入）。",
		verifyEnable: "验证并启用",
		verifying: "正在验证…",
		enabled: "双重验证已启用。请保存好备用码。",
		success: "登录成功，正在跳转…",
		codeHeading: "两步验证",
		codeSub: "请输入认证器中的动态验证码（或一次性备用码）。",
		verify: "验证",
		failed: "登录失败 ({status})",
	},
	en: {
		pageTitle: "Sign in",
		headingBootstrap: "Create the first admin account",
		headingLogin: "Sign in to DeepSeek Harness",
		buttonBootstrap: "Create admin account",
		buttonLogin: "Sign in",
		hintBootstrap: "No account is configured yet. For safety, the first admin account can only be created locally (loopback).",
		hintLogin: "Enter your username and password.",
		username: "Username",
		password: "Password",
		code: "Two-factor code (or backup code)",
		offerOk: "Two-factor authentication is not enabled yet. Bind it now with an authenticator app to protect this account.",
		offerBind: "Bind two-factor",
		offerSkip: "Skip for now",
		setupIntro: "Add the account in an authenticator app (Google Authenticator, 1Password, Authy, …):",
		qrAlt: "QR code for two-factor binding",
		setupSecret: "Or enter the key manually",
		setupOtpauth: "otpauth link",
		setupBackup: "One-time backup codes (each usable once — save them somewhere safe)",
		setupVerify: "Enter the current 6-digit code from the authenticator to enable:",
		countdown: "Valid for {n}s",
		offerHeading: "Bind two-factor",
		offerSub: "Enable two-factor for account {user}.",
		generating: "Generating key…",
		setupStep1: "Step 1: add the account in your authenticator app (scan or enter it manually).",
		verifyEnable: "Verify & enable",
		verifying: "Verifying…",
		enabled: "Two-factor enabled. Keep your backup codes safe.",
		success: "Signed in — redirecting…",
		codeHeading: "Two-factor",
		codeSub: "Enter the code from your authenticator (or a one-time backup code).",
		verify: "Verify",
		failed: "Sign-in failed ({status})",
	},
	ja: {
		pageTitle: "ログイン",
		headingBootstrap: "最初の管理者アカウントを作成",
		headingLogin: "DeepSeek Harness にログイン",
		buttonBootstrap: "管理者アカウントを作成",
		buttonLogin: "ログイン",
		hintBootstrap: "アカウントがまだ設定されていません。安全のため、最初の管理者アカウントはローカル（ループバック）でのみ作成できます",
		hintLogin: "ユーザー名とパスワードを入力してください",
		username: "ユーザー名",
		password: "パスワード",
		code: "二要素認証コード（またはバックアップコード）",
		offerOk: "二要素認証はまだ有効になっていません。今すぐ認証アプリで設定して、このアカウントを保護してください",
		offerBind: "二要素認証を設定",
		offerSkip: "今はスキップ",
		setupIntro: "認証アプリ（Google Authenticator、1Password、Authy など）にアカウントを追加してください：",
		qrAlt: "二要素認証の設定用 QR コード",
		setupSecret: "またはキーを手動で入力",
		setupOtpauth: "otpauth リンク",
		setupBackup: "ワンタイムバックアップコード（各 1 回のみ使用可。安全な場所に保存してください）",
		setupVerify: "有効にするには、認証アプリに表示されている現在の 6 桁のコードを入力してください：",
		countdown: "残り {n} 秒有効",
		offerHeading: "二要素認証を設定",
		offerSub: "アカウント {user} の二要素認証を有効にします",
		generating: "キーを生成中…",
		setupStep1: "ステップ 1：認証アプリにアカウントを追加します（スキャンまたは手動入力）",
		verifyEnable: "確認して有効化",
		verifying: "確認中…",
		enabled: "二要素認証を有効にしました。バックアップコードは大切に保管してください",
		success: "ログインしました。リダイレクトしています…",
		codeHeading: "二要素認証",
		codeSub: "認証アプリのコード（またはワンタイムバックアップコード）を入力してください",
		verify: "確認",
		failed: "ログインに失敗しました（{status}）",
	},
	es: {
		pageTitle: "Iniciar sesión",
		headingBootstrap: "Crear la primera cuenta de administrador",
		headingLogin: "Inicia sesión en DeepSeek Harness",
		buttonBootstrap: "Crear cuenta de administrador",
		buttonLogin: "Iniciar sesión",
		hintBootstrap: "Aún no hay ninguna cuenta configurada. Por seguridad, la primera cuenta de administrador solo se puede crear en local (loopback).",
		hintLogin: "Introduce tu usuario y contraseña.",
		username: "Usuario",
		password: "Contraseña",
		code: "Código de doble factor (o código de respaldo)",
		offerOk: "La autenticación en dos pasos aún no está activada. Vincúlala ahora con una app de autenticación para proteger esta cuenta.",
		offerBind: "Vincular doble factor",
		offerSkip: "Omitir por ahora",
		setupIntro: "Añade la cuenta en una app de autenticación (Google Authenticator, 1Password, Authy, …):",
		qrAlt: "Código QR para vincular el doble factor",
		setupSecret: "O introduce la clave manualmente",
		setupOtpauth: "enlace otpauth",
		setupBackup: "Códigos de respaldo de un solo uso (cada uno sirve una vez; guárdalos en un lugar seguro)",
		setupVerify: "Introduce el código de 6 dígitos actual del autenticador para activarlo:",
		countdown: "Válido durante {n} s",
		offerHeading: "Vincular doble factor",
		offerSub: "Activa el doble factor para la cuenta {user}.",
		generating: "Generando clave…",
		setupStep1: "Paso 1: añade la cuenta en tu app de autenticación (escanea el código o introdúcela manualmente).",
		verifyEnable: "Verificar y activar",
		verifying: "Verificando…",
		enabled: "Doble factor activado. Guarda tus códigos de respaldo en un lugar seguro.",
		success: "Sesión iniciada; redirigiendo…",
		codeHeading: "Doble factor",
		codeSub: "Introduce el código de tu autenticador (o un código de respaldo de un solo uso).",
		verify: "Verificar",
		failed: "Error al iniciar sesión ({status})",
	},
	fr: {
		pageTitle: "Connexion",
		headingBootstrap: "Créer le premier compte administrateur",
		headingLogin: "Se connecter à DeepSeek Harness",
		buttonBootstrap: "Créer le compte administrateur",
		buttonLogin: "Se connecter",
		hintBootstrap: "Aucun compte n'est encore configuré. Pour des raisons de sécurité, le premier compte administrateur ne peut être créé que localement (boucle locale).",
		hintLogin: "Saisissez votre nom d'utilisateur et votre mot de passe.",
		username: "Nom d'utilisateur",
		password: "Mot de passe",
		code: "Code à deux facteurs (ou code de secours)",
		offerOk: "L'authentification à deux facteurs n'est pas encore activée. Associez-la maintenant à une application d'authentification pour protéger ce compte.",
		offerBind: "Configurer la double authentification",
		offerSkip: "Passer pour l'instant",
		setupIntro: "Ajoutez le compte dans une application d'authentification (Google Authenticator, 1Password, Authy, …) :",
		qrAlt: "Code QR pour associer la double authentification",
		setupSecret: "Ou saisir la clé manuellement",
		setupOtpauth: "lien otpauth",
		setupBackup: "Codes de secours à usage unique (chacun utilisable une seule fois — conservez-les en lieu sûr)",
		setupVerify: "Saisissez le code à 6 chiffres affiché actuellement dans l'application d'authentification pour activer :",
		countdown: "Valide {n} s",
		offerHeading: "Configurer la double authentification",
		offerSub: "Activer la double authentification pour le compte {user}.",
		generating: "Génération de la clé…",
		setupStep1: "Étape 1 : ajoutez le compte dans votre application d'authentification (scannez le code QR ou saisissez-le manuellement).",
		verifyEnable: "Vérifier et activer",
		verifying: "Vérification…",
		enabled: "Double authentification activée. Conservez vos codes de secours en lieu sûr.",
		success: "Connecté — redirection…",
		codeHeading: "Double authentification",
		codeSub: "Saisissez le code de votre application d'authentification (ou un code de secours à usage unique).",
		verify: "Vérifier",
		failed: "Échec de la connexion ({status})",
	},
	de: {
		pageTitle: "Anmelden",
		headingBootstrap: "Erstes Administratorkonto erstellen",
		headingLogin: "Bei DeepSeek Harness anmelden",
		buttonBootstrap: "Administratorkonto erstellen",
		buttonLogin: "Anmelden",
		hintBootstrap: "Es ist noch kein Konto eingerichtet. Aus Sicherheitsgründen kann das erste Administratorkonto nur lokal (loopback) erstellt werden.",
		hintLogin: "Geben Sie Ihren Benutzernamen und Ihr Passwort ein.",
		username: "Benutzername",
		password: "Passwort",
		code: "Zwei-Faktor-Code (oder Backup-Code)",
		offerOk: "Die Zwei-Faktor-Authentifizierung ist noch nicht aktiviert. Binden Sie sie jetzt mit einer Authenticator-App ein, um dieses Konto zu schützen.",
		offerBind: "Zwei-Faktor einrichten",
		offerSkip: "Vorerst überspringen",
		setupIntro: "Fügen Sie das Konto in einer Authenticator-App hinzu (Google Authenticator, 1Password, Authy, …):",
		qrAlt: "QR-Code zum Einrichten der Zwei-Faktor-Authentifizierung",
		setupSecret: "Oder Schlüssel manuell eingeben",
		setupOtpauth: "otpauth-Link",
		setupBackup: "Einmalige Backup-Codes (jeder nur einmal gültig – sicher aufbewahren)",
		setupVerify: "Geben Sie den aktuellen 6-stelligen Code aus der Authenticator-App ein, um zu aktivieren:",
		countdown: "Noch {n} s gültig",
		offerHeading: "Zwei-Faktor einrichten",
		offerSub: "Zwei-Faktor-Authentifizierung für Konto {user} aktivieren.",
		generating: "Schlüssel wird erzeugt…",
		setupStep1: "Schritt 1: Fügen Sie das Konto in Ihrer Authenticator-App hinzu (scannen oder manuell eingeben).",
		verifyEnable: "Bestätigen & aktivieren",
		verifying: "Wird geprüft…",
		enabled: "Zwei-Faktor-Authentifizierung aktiviert. Bewahren Sie Ihre Backup-Codes sicher auf.",
		success: "Angemeldet – Weiterleitung…",
		codeHeading: "Zwei-Faktor",
		codeSub: "Geben Sie den Code aus Ihrer Authenticator-App ein (oder einen einmaligen Backup-Code).",
		verify: "Bestätigen",
		failed: "Anmeldung fehlgeschlagen ({status})",
	},
	ru: {
		pageTitle: "Вход",
		headingBootstrap: "Создание первого аккаунта администратора",
		headingLogin: "Вход в DeepSeek Harness",
		buttonBootstrap: "Создать аккаунт администратора",
		buttonLogin: "Войти",
		hintBootstrap: "Аккаунты пока не настроены. В целях безопасности первый аккаунт администратора можно создать только локально (loopback).",
		hintLogin: "Введите имя пользователя и пароль.",
		username: "Имя пользователя",
		password: "Пароль",
		code: "Код двухфакторной аутентификации (или резервный код)",
		offerOk: "Двухфакторная аутентификация пока не включена. Привяжите её сейчас в приложении-аутентификаторе, чтобы защитить этот аккаунт.",
		offerBind: "Привязать двухфакторную аутентификацию",
		offerSkip: "Пропустить",
		setupIntro: "Добавьте аккаунт в приложении-аутентификаторе (Google Authenticator, 1Password, Authy, …):",
		qrAlt: "QR-код для привязки двухфакторной аутентификации",
		setupSecret: "Или введите ключ вручную",
		setupOtpauth: "Ссылка otpauth",
		setupBackup: "Одноразовые резервные коды (каждый можно использовать один раз — сохраните их в надёжном месте)",
		setupVerify: "Введите текущий 6-значный код из аутентификатора, чтобы включить:",
		countdown: "Действителен {n} с",
		offerHeading: "Привязка двухфакторной аутентификации",
		offerSub: "Включите двухфакторную аутентификацию для аккаунта {user}.",
		generating: "Генерация ключа…",
		setupStep1: "Шаг 1: добавьте аккаунт в приложении-аутентификаторе (отсканируйте QR-код или введите данные вручную).",
		verifyEnable: "Проверить и включить",
		verifying: "Проверка…",
		enabled: "Двухфакторная аутентификация включена. Сохраните резервные коды.",
		success: "Вход выполнен — перенаправление…",
		codeHeading: "Двухфакторная аутентификация",
		codeSub: "Введите код из аутентификатора (или одноразовый резервный код).",
		verify: "Проверить",
		failed: "Не удалось войти ({status})",
	},
	pt: {
		pageTitle: "Entrar",
		headingBootstrap: "Criar a primeira conta de administrador",
		headingLogin: "Entrar no DeepSeek Harness",
		buttonBootstrap: "Criar conta de administrador",
		buttonLogin: "Entrar",
		hintBootstrap: "Nenhuma conta está configurada ainda. Por segurança, a primeira conta de administrador só pode ser criada localmente (loopback).",
		hintLogin: "Digite seu nome de usuário e senha.",
		username: "Nome de usuário",
		password: "Senha",
		code: "Código de dois fatores (ou código de backup)",
		offerOk: "A autenticação em dois fatores ainda não está ativada. Vincule-a agora com um app autenticador para proteger esta conta.",
		offerBind: "Vincular dois fatores",
		offerSkip: "Pular por enquanto",
		setupIntro: "Adicione a conta em um app autenticador (Google Authenticator, 1Password, Authy, …):",
		qrAlt: "Código QR para vincular dois fatores",
		setupSecret: "Ou insira a chave manualmente",
		setupOtpauth: "link otpauth",
		setupBackup: "Códigos de backup de uso único (cada um vale uma vez — guarde-os em local seguro)",
		setupVerify: "Digite o código de 6 dígitos atual do autenticador para ativar:",
		countdown: "Válido por {n}s",
		offerHeading: "Vincular dois fatores",
		offerSub: "Ativar dois fatores para a conta {user}.",
		generating: "Gerando chave…",
		setupStep1: "Etapa 1: adicione a conta no seu app autenticador (escaneie ou insira manualmente).",
		verifyEnable: "Verificar e ativar",
		verifying: "Verificando…",
		enabled: "Dois fatores ativados. Guarde seus códigos de backup em segurança.",
		success: "Sessão iniciada — redirecionando…",
		codeHeading: "Dois fatores",
		codeSub: "Digite o código do seu autenticador (ou um código de backup de uso único).",
		verify: "Verificar",
		failed: "Falha no login ({status})",
	}
};

/** Accept only a same-origin absolute path as the post-login target: reject
 *  protocol-relative (`//evil`), backslash and control-character forms. */
export const normalizeNextPath = (value) => {
	if (typeof value !== "string" || value.length === 0 || value.length > 2048) return "/";
	if (!value.startsWith("/") || value.startsWith("//")) return "/";
	if (value.includes("\\") || /[\u0000-\u001F\u007F]/.test(value)) return "/";
	return value;
};

/**
 * @param {object} options
 * @param {boolean} options.bootstrap - whether to show the first-admin form.
 * @param {string} options.next - path to redirect to after login.
 * @param {string} [options.error] - pre-rendered error message.
 * @param {string} [options.title] - page title text.
 * @param {string} [options.lang] - a DSH locale id (`en`, `zh`, `ja`, `es`,
 *   `fr`, `de`, `ru`, `pt`); unknown values fall back to English.
 * @returns {string} the full HTML document.
 */
export const LOGIN_LOCALES = ["en", "zh", "ja", "es", "fr", "de", "ru", "pt"];

/** Map an arbitrary locale tag to a login-page language table key. */
const normalizeLang = (tag) => {
	if (typeof tag !== "string") return "en";
	const primary = tag.trim().toLowerCase().replace(/_/g, "-").split("-")[0];
	return LOGIN_LOCALES.includes(primary) ? primary : "en";
};

/** `<html lang>` values whose region the base tag alone does not convey. */
const HTML_LANG = { zh: "zh-CN", pt: "pt-BR" };

export function renderLoginPage({ bootstrap, next = "/", error = "", title = "DeepSeek Harness", lang = "en" }) {
	const code = normalizeLang(lang);
	const s = STRINGS[code] ?? STRINGS.en;
	const htmlLang = HTML_LANG[code] ?? code;
	const safeNext = normalizeNextPath(next);
	// Per-render nonce: the inline script is the only executable script the page
	// allows, so reflected input cannot run even if it breaks a string literal.
	const nonce = randomBytes(18).toString("base64url");
	const heading = bootstrap ? s.headingBootstrap : s.headingLogin;
	const button = bootstrap ? s.buttonBootstrap : s.buttonLogin;
	const endpoint = bootstrap ? "/auth/bootstrap" : "/auth/login";
	const hint = bootstrap ? s.hintBootstrap : s.hintLogin;
	const errorHtml = error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : "";
	return `<!doctype html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'">
<title>${escapeHtml(title)} · ${s.pageTitle}</title>
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
      <label for="username">${s.username}</label>
      <input type="text" id="username" name="username" autocomplete="username" required spellcheck="false">
      <label for="password">${s.password}</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
    </div>

    <div id="code-step" hidden>
      <label for="code">${s.code}</label>
      <input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
      <div class="ttl" id="code-ttl"></div>
    </div>

    <div id="offer" hidden>
      <div class="ok">${s.offerOk}</div>
      <button type="button" id="offer-bind" class="secondary">${s.offerBind}</button>
      <button type="button" id="offer-skip" class="secondary">${s.offerSkip}</button>
    </div>

    <div id="setup" hidden>
      <p class="sub">${s.setupIntro}</p>
      <div id="setup-qr-wrap" style="display:flex;justify-content:center;margin:6px 0 2px">
        <img id="setup-qr" alt="${s.qrAlt}" style="width:180px;height:180px;image-rendering:pixelated;border-radius:8px" hidden>
      </div>
      <label>${s.setupSecret}</label>
      <div class="secret" id="setup-secret"></div>
      <label>${s.setupOtpauth}</label>
      <div class="secret" id="setup-otpauth"></div>
      <label>${s.setupBackup}</label>
      <div class="codes" id="setup-codes"></div>
      <label for="setup-code">${s.setupVerify}</label>
      <input type="text" id="setup-code" inputmode="numeric" autocomplete="one-time-code">
      <div class="ttl" id="setup-ttl"></div>
    </div>

    ${errorHtml}
    <button type="submit" id="submit">${button}</button>
    <div class="note" id="note" hidden></div>
  </form>
<script nonce="${nonce}">
(function () {
  var STR = ${JSON.stringify(s)};
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
  var next = ${JSON.stringify(safeNext)};
  var mfaToken = null;
  var phase = "password"; // password | code | offer | setup
  // Live TOTP countdown: updates the element with the seconds left in the
  // current 30s window, so a stale code is obvious before submission.
  var startCountdown = function (el) {
    el.className = "ttl";
    var tick = function () {
      var remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
      el.textContent = STR.countdown.replace("{n}", remaining);
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
  var go = function (path) {
    location.href = typeof path === "string" && path.charAt(0) === "/" && path.charAt(1) !== "/" && path.indexOf("\\") === -1 ? path : "/";
  };
  var bindOffer = function () {
    phase = "offer";
    heading.textContent = STR.offerHeading;
    sub.textContent = STR.offerSub.replace("{user}", (form.querySelector("#username") ? document.getElementById("username").value.trim() : ""));
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
    note.textContent = STR.generating;
    try {
      var res = await fetch("/auth/mfa/setup", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: "{}"
      });
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || "setup failed");
      phase = "setup";
      heading.textContent = STR.offerHeading;
      sub.textContent = STR.setupStep1;
      offer.hidden = true;
      setup.hidden = false;
      submit.hidden = false;
      submit.disabled = false;
      submit.textContent = STR.verifyEnable;
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
    note.textContent = STR.verifying;
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
      ok.textContent = STR.enabled;
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
      note.textContent = STR.verifying;
      payload = { mfaToken: mfaToken, code: code };
    } else {
      var username = document.getElementById("username").value.trim();
      var password = document.getElementById("password").value;
      if (!username || !password) { submit.disabled = false; note.hidden = true; return; }
      note.textContent = STR.verifying;
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
        note.textContent = STR.success;
        go(next);
        return;
      }
      if (res.ok && data && data.mfaRequired && data.mfaToken) {
        phase = "code";
        mfaToken = data.mfaToken;
        heading.textContent = STR.codeHeading;
        sub.textContent = STR.codeSub;
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
        submit.textContent = STR.verify;
        return;
      }
      var message = (data && (data.error || data.message)) || STR.failed.replace("{status}", res.status);
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
