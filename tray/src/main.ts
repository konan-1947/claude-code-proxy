import { app, Tray, Menu, shell, BrowserWindow, ipcMain, dialog } from "electron";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import * as fs from "fs";
import { createHash, randomBytes } from "crypto";
import { spawn } from "child_process";
import { ProxyManager } from "./proxy";
import {
  enableCodexMode,
  enableDirectMode,
  getCodexAdvancedSettings,
  getCodexAliases,
  importCodexAliasesFromTomlFile,
  setCodexAdvancedSettings,
  setCodexAliases,
} from "./settings";

const ASSETS = path.join(__dirname, "..", "assets");
const AUTH_JSON = path.join(
  os.homedir(),
  ".config",
  "claude-code-proxy",
  "codex",
  "auth.json"
);

app.setAppUserModelId("claude-code-proxy-tray");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  showMainWindow();
});

const LOG_FILE = path.join(
  process.env["XDG_STATE_HOME"] ?? path.join(os.homedir(), ".local", "state"),
  "claude-code-proxy",
  "proxy.log"
);

const PORT = parseInt(process.env["PORT"] ?? "18765", 10);
const HEALTH_URL = `http://127.0.0.1:${PORT}/healthz`;
const POLL_INTERVAL_MS = 3000;
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_OAUTH_PORT = 1455;
const CODEX_OAUTH_REDIRECT_URI = `http://localhost:${CODEX_OAUTH_PORT}/auth/callback`;
const CODEX_ORIGINATOR = "claude-code-proxy";

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
const proxy = new ProxyManager();
let loginInProgress = false;
let logoutInProgress = false;
let activeLoginCancel: (() => void) | null = null;

// ---- UI logging --------------------------------------------------------

const UI_LOG_LIMIT = 400;
const uiLogs: string[] = [];

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return "\"<unserializable>\"";
  }
}

function pushUiLog(line: string): void {
  uiLogs.push(line);
  if (uiLogs.length > UI_LOG_LIMIT) uiLogs.splice(0, uiLogs.length - UI_LOG_LIMIT);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("ui-log", line);
  }
}

function uiLog(message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const suffix = data ? ` ${safeJson(data)}` : "";
  pushUiLog(`[tray] ${ts} ${message}${suffix}`);
}

// ---- Proxy log tail ----------------------------------------------------

let proxyLogOffset = 0;
let proxyLogPartial = "";
let proxyLogWarnedMissing = false;

function startProxyLogTail(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    const tailBytes = 32 * 1024;
    proxyLogOffset = Math.max(0, stat.size - tailBytes);
    pushUiLog(`[proxy] ${new Date().toISOString()} tail start ${safeJson({ file: LOG_FILE, offset: proxyLogOffset })}`);
  } catch (err) {
    pushUiLog(`[proxy] ${new Date().toISOString()} missing ${safeJson({ file: LOG_FILE, err: String(err) })}`);
    proxyLogWarnedMissing = true;
    proxyLogOffset = 0;
  }

  setInterval(pollProxyLog, 800);
}

function pollProxyLog(): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(LOG_FILE);
    if (proxyLogWarnedMissing) {
      pushUiLog(`[proxy] ${new Date().toISOString()} found ${safeJson({ file: LOG_FILE })}`);
      proxyLogWarnedMissing = false;
      proxyLogOffset = Math.max(0, stat.size - 8 * 1024);
    }
  } catch {
    if (!proxyLogWarnedMissing) {
      pushUiLog(`[proxy] ${new Date().toISOString()} missing ${safeJson({ file: LOG_FILE })}`);
      proxyLogWarnedMissing = true;
    }
    return;
  }

  if (stat.size < proxyLogOffset) {
    // rotated/truncated
    proxyLogOffset = 0;
    proxyLogPartial = "";
  }
  if (stat.size === proxyLogOffset) return;

  const start = proxyLogOffset;
  const end = stat.size;

  const len = Math.max(0, end - start);
  if (len === 0) return;

  let raw = "";
  try {
    const fd = fs.openSync(LOG_FILE, "r");
    try {
      const buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, buf, 0, len, start);
      raw = buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    pushUiLog(`[proxy] ${new Date().toISOString()} read failed ${safeJson({ err: String(err) })}`);
    return;
  }

  proxyLogOffset = end;
  const text = proxyLogPartial + raw;
  const parts = text.split("\n");
  proxyLogPartial = parts.pop() ?? "";

  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    pushUiLog(formatProxyLogLine(trimmed));
  }
}

function formatProxyLogLine(line: string): string {
  try {
    const obj = JSON.parse(line) as {
      t?: string;
      service?: string;
      msg?: string;
      fields?: Record<string, unknown>;
    };
    const ts = typeof obj.t === "string" ? obj.t : new Date().toISOString();
    const service = typeof obj.service === "string" ? obj.service : "proxy";
    const msg = typeof obj.msg === "string" ? obj.msg : "";
    const f = obj.fields ?? {};

    if (service === "server" && msg === "request") {
      const method = typeof f["method"] === "string" ? f["method"] : "";
      const path = typeof f["path"] === "string" ? f["path"] : "";
      const query = typeof f["query"] === "string" ? f["query"] : "";
      const full = `${path}${query || ""}`;
      return `[user request] ${ts} ${method} ${full}`.trim();
    }

    if (service === "server" && msg === "response") {
      const status = typeof f["status"] === "number" ? f["status"] : f["status"];
      const ms = typeof f["ms"] === "number" ? f["ms"] : f["ms"];
      return `[user response] ${ts} ${String(status)} ${String(ms)}ms`.trim();
    }

    return `[proxy] ${ts} ${service} ${msg} ${safeJson(f)}`.trim();
  } catch {
    return `[proxy] ${line}`;
  }
}

// ---- Auth check --------------------------------------------------------

interface AuthInfo {
  valid: boolean;
  email?: string;
}

interface TokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

function checkAuth(): AuthInfo {
  try {
    const raw = fs.readFileSync(AUTH_JSON, "utf8");
    const data = JSON.parse(raw) as { access?: string; expires?: number };
    if (!data.access || !data.expires) return { valid: false };
    if (Date.now() > data.expires - 60_000) return { valid: false };
    try {
      const payload = JSON.parse(
        Buffer.from(data.access.split(".")[1]!, "base64url").toString()
      ) as Record<string, unknown>;
      const profile = payload["https://api.openai.com/profile"] as
        | { email?: string }
        | undefined;
      return { valid: true, email: profile?.email };
    } catch {
      return { valid: true };
    }
  } catch (err) {
    uiLog("checkAuth failed", { err: String(err) });
    return { valid: false };
  }
}

function getStatus() {
  const auth = checkAuth();
  return {
    proxyRunning: proxy.isRunning(),
    authValid: auth.valid,
    authEmail: auth.email,
    loginInProgress,
    logoutInProgress,
    port: PORT,
    codexAliases: getCodexAliases(),
    codexAdvanced: getCodexAdvancedSettings(),
  };
}

// ---- Window ------------------------------------------------------------

function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 560,
    height: 560,
    frame: false,
    resizable: false,
    center: true,
    icon: path.join(ASSETS, "icon-256.png"),
    show: true,
    backgroundColor: "#ffffff",
    skipTaskbar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  void splash.loadFile(path.join(ASSETS, "splash.html"));
  return splash;
}

function pushStatusUpdate(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("status-update", getStatus());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProxyStopped(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (proxy.status !== "stopped" && Date.now() < deadline) {
    await sleep(100);
  }
  if (proxy.status !== "stopped") {
    throw new Error("Timed out waiting for proxy to stop");
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("status-update", getStatus());
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 560,
    minWidth: 480,
    minHeight: 480,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    frame: false,
    title: "",
    icon: path.join(ASSETS, "icon-256.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
    },
    show: false,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
  });

  // Keep the window aspect ratio aligned with bg.png (square).
  win.setAspectRatio(1);

  void win.loadFile(path.join(ASSETS, "index.html"));

  win.once("ready-to-show", () => {
    win.show();
  });

  // Push initial status after page scripts have run, in case the renderer's
  // api.getStatus() IPC call fails silently.
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("status-update", getStatus());
  });

  // Hide instead of closing — keeps app in tray
  win.on("close", (e) => {
    e.preventDefault();
    win.hide();
  });

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F12") {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: "detach" });
      }
      event.preventDefault();
    }
  });

  return win;
}

// ---- Login flow --------------------------------------------------------

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = randomBytes(length);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

function buildAuthorizeUrl(pkceChallenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: pkceChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: CODEX_ORIGINATOR,
  });
  return `${CODEX_ISSUER}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code: string, verifier: string): Promise<TokenResponse> {
  const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CODEX_OAUTH_REDIRECT_URI,
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TokenResponse;
}

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractAccountId(claims: Record<string, unknown> | undefined): string | undefined {
  if (!claims) return undefined;
  if (typeof claims["chatgpt_account_id"] === "string") return claims["chatgpt_account_id"];
  const auth = claims["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
  if (typeof auth?.chatgpt_account_id === "string") return auth.chatgpt_account_id;
  if (typeof claims["https://api.openai.com/auth.chatgpt_account_id"] === "string") {
    return claims["https://api.openai.com/auth.chatgpt_account_id"];
  }
  const orgs = claims["organizations"] as Array<{ id?: unknown }> | undefined;
  return typeof orgs?.[0]?.id === "string" ? orgs[0].id : undefined;
}

function saveCodexAuth(tokens: TokenResponse): void {
  const claims = parseJwtClaims(tokens.id_token ?? tokens.access_token);
  const auth = {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(claims),
  };
  fs.mkdirSync(path.dirname(AUTH_JSON), { recursive: true });
  const tmp = `${AUTH_JSON}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort on Windows
  }
  fs.renameSync(tmp, AUTH_JSON);
}

function startLogin(): Promise<void> {
  if (loginInProgress || logoutInProgress) return Promise.resolve();
  loginInProgress = true;
  pushStatusUpdate();
  pushUiLog(`[user action] ${new Date().toISOString()} login start ${safeJson({ provider: "codex" })}`);

  return new Promise((resolve) => {
    const verifier = generateRandomString(43);
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(32));
    let timeout: NodeJS.Timeout | undefined;
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      server.close();
      server.closeAllConnections?.();
      loginInProgress = false;
      activeLoginCancel = null;
      if (err) {
        const action = err.name === "LoginCanceledError" ? "login canceled" : "login error";
        pushUiLog(`[user action] ${new Date().toISOString()} ${action} ${safeJson({ provider: "codex", err: err.message })}`);
      } else {
        pushUiLog(`[user action] ${new Date().toISOString()} login success ${safeJson({ provider: "codex" })}`);
      }
      pushStatusUpdate();
      resolve();
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${CODEX_OAUTH_PORT}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const receivedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      if (error || !code || receivedState !== state) {
        const msg = error || "Invalid callback";
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`Auth failed: ${msg}`);
        finish(new Error(msg));
        return;
      }
      exchangeCodeForTokens(code, verifier)
        .then((tokens) => {
          saveCodexAuth(tokens);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body><h1>Authorization Successful</h1><p>You can close this window.</p></body></html>");
          finish();
        })
        .catch((err) => {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(String(err));
          finish(err instanceof Error ? err : new Error(String(err)));
        });
    });

    server.on("error", (err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });

    activeLoginCancel = () => {
      const err = new Error("Login canceled");
      err.name = "LoginCanceledError";
      finish(err);
    };

    server.listen(CODEX_OAUTH_PORT, () => {
      const authUrl = buildAuthorizeUrl(challenge, state);
      pushUiLog(`[user action] ${new Date().toISOString()} opening browser ${safeJson({ url: `${CODEX_ISSUER}/oauth/authorize?...` })}`);
      shell.openExternal(authUrl).catch((err) => {
        finish(err instanceof Error ? err : new Error(String(err)));
      });
    });

    timeout = setTimeout(() => finish(new Error("OAuth timeout")), 5 * 60 * 1000);
  });
}

function cancelLogin(): Promise<void> {
  if (!loginInProgress || !activeLoginCancel) return Promise.resolve();
  pushUiLog(`[user action] ${new Date().toISOString()} cancel login`);
  activeLoginCancel();
  return Promise.resolve();
}

function startLogout(): Promise<void> {
  if (loginInProgress || logoutInProgress) return Promise.resolve();
  logoutInProgress = true;
  pushStatusUpdate();
  pushUiLog(`[user action] ${new Date().toISOString()} logout start ${safeJson({ provider: "codex" })}`);

  try {
    fs.unlinkSync(AUTH_JSON);
    pushUiLog(`[user action] ${new Date().toISOString()} logout success ${safeJson({ provider: "codex" })}`);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      pushUiLog(`[user action] ${new Date().toISOString()} logout success ${safeJson({ provider: "codex", alreadySignedOut: true })}`);
    } else {
      pushUiLog(`[user action] ${new Date().toISOString()} logout error ${safeJson({ provider: "codex", err: String(err) })}`);
    }
  } finally {
    logoutInProgress = false;
    pushStatusUpdate();
  }
  return Promise.resolve();
}

// ---- Tray --------------------------------------------------------------

function buildMenu(): Electron.Menu {
  const running = proxy.isRunning();

  return Menu.buildFromTemplate([
    {
      label: running ? `Proxy: Running on :${PORT}` : "Proxy: Stopped",
      enabled: false,
    },
    {
      label: running ? "Stop" : "Start",
      click: () => {
        if (running) {
          enableDirectMode();
          proxy.stop();
        } else {
          enableCodexMode(PORT);
          proxy.start();
        }
        updateTray();
        pushStatusUpdate();
      },
    },
    { type: "separator" },
    {
      label: "Open Window",
      click: () => showMainWindow(),
    },
    {
      label: "Open Logs",
      click: () => {
        void shell.openPath(LOG_FILE);
      },
    },
    { type: "separator" },
    {
      label: "Exit",
      click: () => {
        enableDirectMode();
        proxy.stop();
        // Allow close to proceed by removing the guard
        mainWindow?.removeAllListeners("close");
        app.quit();
      },
    },
  ]);
}

function updateTray(): void {
  if (!tray) return;
  tray.setImage(path.join(ASSETS, "icon-tray.png"));
  tray.setToolTip(proxy.isRunning() ? `Proxy running on :${PORT}` : "Proxy stopped");
  tray.setContextMenu(buildMenu());
}

function pollHealth(): void {
  const req = http.get(HEALTH_URL, { timeout: 2000 }, (res) => {
    res.resume();
    const wasRunning = proxy.isRunning();
    proxy.setStatus(res.statusCode === 200 ? "running" : "stopped");
    if (wasRunning !== proxy.isRunning()) {
      pushUiLog(`[health] ${new Date().toISOString()} status change ${safeJson({
        running: proxy.isRunning(),
        statusCode: res.statusCode ?? 0,
      })}`);
      updateTray();
      pushStatusUpdate();
    }
  });

  req.on("error", () => {
    const wasRunning = proxy.isRunning();
    proxy.setStatus("stopped");
    if (wasRunning !== proxy.isRunning()) {
      pushUiLog(`[health] ${new Date().toISOString()} poll error ${safeJson({ running: false })}`);
      updateTray();
      pushStatusUpdate();
    }
  });

  req.on("timeout", () => req.destroy());
}

// ---- Bootstrap ---------------------------------------------------------

app.whenReady().then(() => {
  (app as { dock?: { hide(): void } }).dock?.hide();

  ipcMain.handle("get-status", () => getStatus());
  ipcMain.handle("get-logs", () => uiLogs.slice());
  ipcMain.handle("start-proxy", () => {
    pushUiLog(`[user action] ${new Date().toISOString()} start proxy`);
    enableCodexMode(PORT);
    proxy.start();
    updateTray();
    pushStatusUpdate();
  });
  ipcMain.handle("stop-proxy", () => {
    pushUiLog(`[user action] ${new Date().toISOString()} stop proxy`);
    enableDirectMode();
    proxy.stop();
    updateTray();
    pushStatusUpdate();
  });
  ipcMain.handle("restart-proxy", async () => {
    pushUiLog(`[user action] ${new Date().toISOString()} restart proxy`);
    if (proxy.isRunning()) {
      proxy.stop();
      await waitForProxyStopped(3000);
    }
    enableCodexMode(PORT);
    proxy.start();
    updateTray();
    pushStatusUpdate();
  });
  ipcMain.handle("set-codex-aliases", (_event, next: Record<string, unknown>) => {
    pushUiLog(`[user action] ${new Date().toISOString()} set codex aliases ${safeJson(next)}`);
    setCodexAliases(next);
    pushStatusUpdate();
  });
  ipcMain.handle("import-codex-mapping", async () => {
    pushUiLog(`[user action] ${new Date().toISOString()} import codex mapping start`);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "Import model mapping",
      properties: ["openFile"],
      filters: [
        { name: "TOML", extensions: ["toml"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || !result.filePaths[0]) {
      pushUiLog(`[user action] ${new Date().toISOString()} import codex mapping canceled`);
      return { imported: false, count: 0 };
    }

    const filePath = result.filePaths[0];
    const aliases = importCodexAliasesFromTomlFile(filePath);
    const count = Object.keys(aliases).length;
    pushUiLog(`[user action] ${new Date().toISOString()} import codex mapping success ${safeJson({ filePath, count })}`);
    pushStatusUpdate();
    return { imported: true, count, filePath };
  });
  ipcMain.handle("set-codex-advanced", (_event, next: { anthropicModel?: string; anthropicSmallFastModel?: string }) => {
    pushUiLog(`[user action] ${new Date().toISOString()} set codex advanced ${safeJson(next)}`);
    setCodexAdvancedSettings(next);
    pushStatusUpdate();
  });
  ipcMain.handle("login-codex", () => startLogin());
  ipcMain.handle("cancel-login-codex", () => cancelLogin());
  ipcMain.handle("logout-codex", () => startLogout());
  ipcMain.on("minimize-to-tray", () => mainWindow?.hide());

  const splash = createSplashWindow();
  mainWindow = createMainWindow();
  mainWindow.once("ready-to-show", () => splash.destroy());
  uiLog("app ready", { port: PORT });
  pushStatusUpdate();
  startProxyLogTail();

  tray = new Tray(path.join(ASSETS, "icon-tray.png"));
  tray.setToolTip("Proxy: starting...");
  tray.setContextMenu(buildMenu());
  tray.on("click", () => showMainWindow());

  enableCodexMode(PORT);
  proxy.start();
  updateTray();

  setInterval(pollHealth, POLL_INTERVAL_MS);
  setTimeout(pollHealth, 1500);
});

app.on("window-all-closed", () => {
  // Keep alive — tray app survives window close
});
