import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

const PROXY_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const;

type SettingsJson = {
  env?: Record<string, string>;
  [key: string]: unknown;
};

function readSettings(): SettingsJson {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    return JSON.parse(raw) as SettingsJson;
  } catch {
    return {};
  }
}

function writeSettings(data: SettingsJson): void {
  const dir = path.dirname(SETTINGS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function enableCodexMode(port: number = 18765): void {
  const settings = readSettings();
  settings.env = {
    ...(settings.env ?? {}),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: "unused",
    ANTHROPIC_MODEL: "gpt-5.4",
    ANTHROPIC_SMALL_FAST_MODEL: "gpt-5.4-mini",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  writeSettings(settings);
}

export function enableDirectMode(): void {
  const settings = readSettings();
  if (settings.env) {
    for (const key of PROXY_ENV_KEYS) {
      delete settings.env[key];
    }
    if (Object.keys(settings.env).length === 0) {
      delete settings.env;
    }
  }
  writeSettings(settings);
}

export function currentMode(): "codex" | "direct" {
  const settings = readSettings();
  const base = settings.env?.["ANTHROPIC_BASE_URL"];
  return typeof base === "string" && base.includes("127.0.0.1") ? "codex" : "direct";
}
