import { contextBridge, ipcRenderer } from "electron";

export interface AppStatus {
  proxyRunning: boolean;
  authValid: boolean;
  authEmail?: string;
  loginInProgress: boolean;
  logoutInProgress: boolean;
  port: number;
  codexAliases: Record<string, string>;
  codexAdvanced: {
    anthropicModel: string;
    anthropicSmallFastModel: string;
  };
}

export type UiLogLine = string;

export type ImportMappingResult = {
  imported: boolean;
  count: number;
  filePath?: string;
};

contextBridge.exposeInMainWorld("api", {
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke("get-status"),
  getLogs: (): Promise<UiLogLine[]> => ipcRenderer.invoke("get-logs"),
  startProxy: (): Promise<void> => ipcRenderer.invoke("start-proxy"),
  stopProxy: (): Promise<void> => ipcRenderer.invoke("stop-proxy"),
  restartProxy: (): Promise<void> => ipcRenderer.invoke("restart-proxy"),
  loginCodex: (): Promise<void> => ipcRenderer.invoke("login-codex"),
  cancelLoginCodex: (): Promise<void> => ipcRenderer.invoke("cancel-login-codex"),
  logoutCodex: (): Promise<void> => ipcRenderer.invoke("logout-codex"),
  setCodexAliases: (aliases: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke("set-codex-aliases", aliases),
  importCodexMapping: (): Promise<ImportMappingResult> =>
    ipcRenderer.invoke("import-codex-mapping"),
  setCodexAdvanced: (settings: {
    anthropicModel?: string;
    anthropicSmallFastModel?: string;
  }): Promise<void> => ipcRenderer.invoke("set-codex-advanced", settings),
  minimizeToTray: (): void => ipcRenderer.send("minimize-to-tray"),
  onStatusUpdate: (cb: (s: AppStatus) => void): void => {
    ipcRenderer.on("status-update", (_event, data: AppStatus) => cb(data));
  },
  onLog: (cb: (line: UiLogLine) => void): void => {
    ipcRenderer.on("ui-log", (_event, line: UiLogLine) => cb(line));
  },
});
