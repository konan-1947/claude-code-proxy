import { app, Tray, Menu, shell, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import * as fs from "fs";
import { spawn } from "child_process";
import { ProxyManager } from "./proxy";
import { enableCodexMode, enableDirectMode } from "./settings";

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

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
const proxy = new ProxyManager();
let loginInProgress = false;

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
    port: PORT,
  };
}

// ---- Window ------------------------------------------------------------

function pushStatusUpdate(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("status-update", getStatus());
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
    title: "Claude Code Proxy",
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

function resolveBunForAuth(): string {
  const bunPath = path.join(os.homedir(), ".bun", "bin", "bun.exe");
  return fs.existsSync(bunPath) ? bunPath : "bun.exe";
}

function getRepoRoot(): string {
  // After tsc: __dirname = tray/dist → two levels up = repo root
  return path.resolve(__dirname, "..", "..");
}

function startLogin(): void {
  if (loginInProgress) return;
  loginInProgress = true;
  pushStatusUpdate();
  pushUiLog(`[user action] ${new Date().toISOString()} login start ${safeJson({ provider: "codex" })}`);

  const bunExe = resolveBunForAuth();
  const child = spawn(bunExe, ["run", "src/cli.ts", "codex", "auth", "login"], {
    cwd: getRepoRoot(),
    stdio: "ignore",
    env: {
      ...process.env,
      PATH: [
        path.join(os.homedir(), ".bun", "bin"),
        process.env["PATH"] ?? "",
      ].join(";"),
    },
  });

  child.on("error", () => {
    loginInProgress = false;
    pushUiLog(`[user action] ${new Date().toISOString()} login spawn error ${safeJson({ provider: "codex" })}`);
    pushStatusUpdate();
  });

  child.on("exit", () => {
    loginInProgress = false;
    pushUiLog(`[user action] ${new Date().toISOString()} login exit ${safeJson({ provider: "codex" })}`);
    pushStatusUpdate();
  });
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
  ipcMain.handle("login-codex", () => startLogin());
  ipcMain.on("minimize-to-tray", () => mainWindow?.hide());

  mainWindow = createMainWindow();
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
