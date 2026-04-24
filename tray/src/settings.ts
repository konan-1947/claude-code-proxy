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
  "CCP_CODEX_MODEL_ALIASES",
] as const;

const CODEX_ALLOWED_UPSTREAM_MODELS = [
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;

export type CodexAllowedUpstreamModel = (typeof CODEX_ALLOWED_UPSTREAM_MODELS)[number];

export type CodexAliases = {
  haiku: CodexAllowedUpstreamModel;
  sonnet: CodexAllowedUpstreamModel;
  opus: CodexAllowedUpstreamModel;
};

export const DEFAULT_CODEX_ALIASES: CodexAliases = {
  haiku: "gpt-5.4-mini",
  sonnet: "gpt-5.4",
  opus: "gpt-5.2",
};

const CODEX_ALIAS_KEYS = {
  haiku: ["haiku", "claude-haiku-4-5", "claude-haiku-4-5-20251001"],
  sonnet: ["sonnet", "claude-sonnet-4-6"],
  opus: ["opus", "claude-opus-4-7"],
} as const;

function isAllowedUpstreamModel(x: unknown): x is CodexAllowedUpstreamModel {
  return (
    typeof x === "string" &&
    (CODEX_ALLOWED_UPSTREAM_MODELS as readonly string[]).includes(x)
  );
}

function parseCodexAliasEnv(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

const CODEX_SPINNER_VERBS = [
  "Hello ae, chào mừng ae đến với Trực Tiếp Game",
  "Hello ae, chào mừng ae đến với Gián Tiếp Game",
  "Anh em có giật lag gì không?",
  "F5 đi anh em",
  "Gái gú là phù du, trực tiếp game là bất diệt",
  "Từ game kinh dị thành game hài",
  "Con game này chỉ dành cho trẻ con",
  "Game này chó chơi à",
  "Ae đợi tôi tí",
  "Học sinh cấp 3 sao giờ này còn coi anh chơi game? Đi ngủ nhanh đi em",
  "Trên thế giới này có 7 tỷ người, không có người này thì có người khác",
  "Địt con mẹ cuộc đời",
  "Tao là bố chúng mày. Chúng mày là con tao",
  "Alo Vũ à Vũ",
  "Sợ quá, sợ quá, phải ban nó thôi",
  "Khó hiểu vailon nhề",
] as const;

type SettingsJson = {
  env?: Record<string, string>;
  spinnerVerbs?: {
    mode: "append" | "replace";
    verbs: string[];
  };
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

export function getClaudeEnv(): Record<string, string> {
  const settings = readSettings();
  return { ...(settings.env ?? {}) };
}

export function getCodexAliases(): CodexAliases {
  const settings = readSettings();
  const parsed = parseCodexAliasEnv(settings.env?.["CCP_CODEX_MODEL_ALIASES"]);

  const out: CodexAliases = { ...DEFAULT_CODEX_ALIASES };
  for (const [alias, keys] of Object.entries(CODEX_ALIAS_KEYS)) {
    for (const key of keys) {
      const v = parsed[key];
      if (isAllowedUpstreamModel(v)) {
        out[alias as keyof CodexAliases] = v;
        break;
      }
    }
  }
  return out;
}

export function setCodexAliases(next: Partial<CodexAliases>): void {
  const settings = readSettings();
  const current = getCodexAliases();
  const merged: CodexAliases = {
    haiku: next.haiku ?? current.haiku,
    sonnet: next.sonnet ?? current.sonnet,
    opus: next.opus ?? current.opus,
  };

  if (!settings.env) settings.env = {};

  const envObj: Record<string, string> = {};
  for (const [alias, keys] of Object.entries(CODEX_ALIAS_KEYS)) {
    const value = merged[alias as keyof CodexAliases];
    for (const k of keys) envObj[k] = value;
  }

  settings.env["CCP_CODEX_MODEL_ALIASES"] = JSON.stringify(envObj);
  writeSettings(settings);
}

export function isCodexAllowedUpstreamModel(x: unknown): x is CodexAllowedUpstreamModel {
  return isAllowedUpstreamModel(x);
}

export function codexAllowedUpstreamModels(): readonly CodexAllowedUpstreamModel[] {
  return CODEX_ALLOWED_UPSTREAM_MODELS;
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
  settings.spinnerVerbs = {
    mode: "replace",
    verbs: [...CODEX_SPINNER_VERBS],
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
  delete settings.spinnerVerbs;
  writeSettings(settings);
}

export function currentMode(): "codex" | "direct" {
  const settings = readSettings();
  const base = settings.env?.["ANTHROPIC_BASE_URL"];
  return typeof base === "string" && base.includes("127.0.0.1") ? "codex" : "direct";
}
