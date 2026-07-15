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

const CODEX_TARGET_MODEL_SUGGESTIONS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.2",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;

export type CodexAliases = Record<string, string>;

export type CodexAdvancedSettings = {
  anthropicModel: string;
  anthropicSmallFastModel: string;
};

export const DEFAULT_CODEX_ALIASES: CodexAliases = {
  haiku: "gpt-5.4-mini",
  "claude-haiku-4-5": "gpt-5.4-mini",
  "claude-haiku-4-5-20251001": "gpt-5.4-mini",
  sonnet: "gpt-5.4",
  "claude-sonnet-4-6": "gpt-5.4",
  "claude-sonnet-5": "gpt-5.4",
  "sonnet[1m]": "gpt-5.4",
  best: "gpt-5.4",
  fable: "gpt-5.4",
  "claude-fable-5": "gpt-5.4",
  opus: "gpt-5.5",
  "claude-opus-4-7": "gpt-5.5",
  "claude-opus-4-8": "gpt-5.5",
  "opus[1m]": "gpt-5.5",
  opusplan: "gpt-5.5",
};

export const DEFAULT_CODEX_ADVANCED: CodexAdvancedSettings = {
  anthropicModel: "sonnet",
  anthropicSmallFastModel: "haiku",
};

function parseCodexAliasEnv(raw: string | undefined): CodexAliases | undefined {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const out: CodexAliases = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      if (key.trim() === "" || value.trim() === "") continue;
      out[key] = value;
    }
    return out;
  } catch {
    return undefined;
  }
}

function normalizeAliases(next: Record<string, unknown>): CodexAliases {
  const out: CodexAliases = {};
  for (const [key, value] of Object.entries(next)) {
    if (typeof value !== "string") continue;
    const k = key.trim();
    const v = value.trim();
    if (!k || !v) continue;
    out[k] = v;
  }
  return out;
}

function stripTomlComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  let out = "";

  for (const ch of line) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inDouble) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === "\"" && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "#" && !inDouble && !inSingle) break;
    out += ch;
  }

  return out.trim();
}

function splitTomlAssignment(line: string): [string, string] | undefined {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inDouble) {
      escaped = true;
      continue;
    }
    if (ch === "\"" && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "=" && !inDouble && !inSingle) {
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }
  }

  return undefined;
}

function parseTomlString(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value || undefined;
}

function parseTomlKey(raw: string): string | undefined {
  const key = raw.trim();
  if (key.startsWith("\"") || key.startsWith("'")) return parseTomlString(key);
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : undefined;
}

function isAliasSection(section: string | undefined): boolean {
  return (
    section === undefined ||
    section === "mapping" ||
    section === "aliases" ||
    section === "codex.aliases" ||
    section === "CCP_CODEX_MODEL_ALIASES"
  );
}

export function parseCodexMappingToml(raw: string): CodexAliases {
  const out: CodexAliases = {};
  let section: string | undefined;

  for (const originalLine of raw.split(/\r?\n/)) {
    const line = stripTomlComment(originalLine);
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1]?.trim();
      continue;
    }

    if (!isAliasSection(section)) continue;

    const assignment = splitTomlAssignment(line);
    if (!assignment) continue;
    const [rawKey, rawValue] = assignment;
    const key = parseTomlKey(rawKey);
    const value = parseTomlString(rawValue);
    if (!key || !value) continue;
    out[key] = value;
  }

  return normalizeAliases(out);
}

function stringOrDefault(value: string | undefined, fallback: string): string {
  return value && value.trim() ? value : fallback;
}

const CODEX_SPINNER_VERBS = [
  ""
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
  const raw = settings.env?.["CCP_CODEX_MODEL_ALIASES"];
  if (raw === undefined || raw === "") return { ...DEFAULT_CODEX_ALIASES };
  const parsed = parseCodexAliasEnv(raw);
  return parsed ?? { ...DEFAULT_CODEX_ALIASES };
}

export function setCodexAliases(next: Record<string, unknown>): void {
  const settings = readSettings();
  if (!settings.env) settings.env = {};
  settings.env["CCP_CODEX_MODEL_ALIASES"] = JSON.stringify(normalizeAliases(next));
  writeSettings(settings);
}

export function importCodexAliasesFromTomlFile(filePath: string): CodexAliases {
  const raw = fs.readFileSync(filePath, "utf8");
  const aliases = parseCodexMappingToml(raw);
  if (Object.keys(aliases).length === 0) {
    throw new Error("No valid mappings found in TOML file");
  }
  setCodexAliases(aliases);
  return aliases;
}

export function getCodexAdvancedSettings(): CodexAdvancedSettings {
  const settings = readSettings();
  return {
    anthropicModel: stringOrDefault(
      settings.env?.["ANTHROPIC_MODEL"],
      DEFAULT_CODEX_ADVANCED.anthropicModel,
    ),
    anthropicSmallFastModel: stringOrDefault(
      settings.env?.["ANTHROPIC_SMALL_FAST_MODEL"],
      DEFAULT_CODEX_ADVANCED.anthropicSmallFastModel,
    ),
  };
}

export function setCodexAdvancedSettings(next: Partial<CodexAdvancedSettings>): void {
  const settings = readSettings();
  const current = getCodexAdvancedSettings();
  if (!settings.env) settings.env = {};
  settings.env["ANTHROPIC_MODEL"] = stringOrDefault(
    next.anthropicModel,
    current.anthropicModel,
  );
  settings.env["ANTHROPIC_SMALL_FAST_MODEL"] = stringOrDefault(
    next.anthropicSmallFastModel,
    current.anthropicSmallFastModel,
  );
  writeSettings(settings);
}

export function codexTargetModelSuggestions(): readonly string[] {
  return CODEX_TARGET_MODEL_SUGGESTIONS;
}

export function enableCodexMode(port: number = 18765): void {
  const settings = readSettings();
  const advanced = getCodexAdvancedSettings();
  settings.env = {
    ...(settings.env ?? {}),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: "unused",
    ANTHROPIC_MODEL: advanced.anthropicModel,
    ANTHROPIC_SMALL_FAST_MODEL: advanced.anthropicSmallFastModel,
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
