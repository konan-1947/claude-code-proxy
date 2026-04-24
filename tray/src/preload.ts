import { contextBridge, ipcRenderer } from "electron";

export interface AppStatus {
  proxyRunning: boolean;
  authValid: boolean;
  authEmail?: string;
  loginInProgress: boolean;
  port: number;
  codexAliases: {
    haiku: string;
    sonnet: string;
    opus: string;
  };
}

export type UiLogLine = string;

contextBridge.exposeInMainWorld("api", {
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke("get-status"),
  getLogs: (): Promise<UiLogLine[]> => ipcRenderer.invoke("get-logs"),
  startProxy: (): Promise<void> => ipcRenderer.invoke("start-proxy"),
  stopProxy: (): Promise<void> => ipcRenderer.invoke("stop-proxy"),
  loginCodex: (): Promise<void> => ipcRenderer.invoke("login-codex"),
  setCodexAliases: (aliases: {
    haiku?: string;
    sonnet?: string;
    opus?: string;
  }): Promise<void> => ipcRenderer.invoke("set-codex-aliases", aliases),
  minimizeToTray: (): void => ipcRenderer.send("minimize-to-tray"),
  onStatusUpdate: (cb: (s: AppStatus) => void): void => {
    ipcRenderer.on("status-update", (_event, data: AppStatus) => cb(data));
  },
  onLog: (cb: (line: UiLogLine) => void): void => {
    ipcRenderer.on("ui-log", (_event, line: UiLogLine) => cb(line));
  },
});
