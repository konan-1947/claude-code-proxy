import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { getClaudeEnv } from "./settings";

// After tsc: __dirname = <repo>/tray/dist → two levels up = repo root
export function resolveProxyRoot(): string {
  const packagedProxyRoot = path.join(process.resourcesPath, "proxy");
  if (fs.existsSync(path.join(packagedProxyRoot, "src", "cli.ts"))) {
    return packagedProxyRoot;
  }

  return path.resolve(__dirname, "..", "..");
}

function resolveBun(): string {
  const candidates: string[] = [
    path.join(os.homedir(), ".bun", "bin", "bun.exe"),
    "bun.exe",
  ];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }

  return "bun.exe";
}

export type ProxyStatus = "running" | "stopped" | "starting" | "stopping";

export class ProxyManager {
  private child: ChildProcess | null = null;
  private _status: ProxyStatus = "stopped";

  get status(): ProxyStatus {
    return this._status;
  }

  start(): void {
    if (this._status === "running" || this._status === "starting") return;
    this._status = "starting";

    const bunExe = resolveBun();
    const proxyRoot = resolveProxyRoot();
    const persistedEnv = getClaudeEnv();
    this.child = spawn(bunExe, ["run", "src/cli.ts", "serve"], {
      cwd: proxyRoot,
      stdio: "ignore",
      env: {
        ...process.env,
        ...persistedEnv,
        PATH: [
          path.join(os.homedir(), ".bun", "bin"),
          persistedEnv["PATH"] ?? process.env["PATH"] ?? "",
        ].join(";"),
      },
    });

    this.child.on("error", (err) => {
      console.error("[proxy] spawn error:", err.message);
      this._status = "stopped";
      this.child = null;
    });

    this.child.on("exit", (code, signal) => {
      console.log(`[proxy] exited code=${code} signal=${signal}`);
      this._status = "stopped";
      this.child = null;
    });

    // Health polling in main.ts will confirm actual running state.
    // Set "running" optimistically after 2s so the menu doesn't stay stuck on "starting".
    setTimeout(() => {
      if (this._status === "starting") this._status = "running";
    }, 2000);
  }

  stop(): void {
    if (this._status === "stopped" || this._status === "stopping") return;
    this._status = "stopping";

    if (this.child?.pid != null) {
      spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    }
    // Status becomes "stopped" via the exit handler.
  }

  setStatus(s: ProxyStatus): void {
    this._status = s;
  }

  isRunning(): boolean {
    return this._status === "running";
  }
}
