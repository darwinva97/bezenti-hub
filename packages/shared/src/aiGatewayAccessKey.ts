/**
 * Copyable setup for someone given a Space's access key (access-keys ticket 01): Claude Code's
 * `settings.json`, Codex's `config.toml` and its shell line, and the base URLs any Anthropic-,
 * OpenAI- or Gemini-compatible client takes. Pure, shared by the web, desktop and mobile Settings.
 * docs/internals/ai-gateway.md, «Access keys».
 */
import { gatewayOrigin } from "./aiGatewayLocalCli.ts";

export { gatewayOrigin };

/** Where the key goes when the setup is copied later: the key itself is shown only once. */
export const ACCESS_KEY_PLACEHOLDER = "<your access key>";

/** The environment variable Codex reads the key from (`env_key`). */
const CODEX_KEY_ENV = "T3_AI_GATEWAY_KEY";

export interface AccessKeySetup {
  /** Claude Code: `~/.claude/settings.json` (merge `env` into an existing file). */
  readonly claudeCode: string;
  /** Codex: `~/.codex/config.toml`, which never holds the key. */
  readonly codex: string;
  /** Codex: the key in the shell's environment (`~/.bashrc`, `~/.zshrc`…). */
  readonly codexShell: string;
  /** Any other client: the base URL of each API shape and how to send the key. */
  readonly other: string;
}

/** The models Claude Code is pinned to: its main model and each alias it may ask for. */
export interface ClaudeCodeModels {
  readonly main: string;
  readonly opus: string;
  readonly sonnet: string;
  readonly haiku: string;
}

/** `claude*` models first, each list's own order kept. */
const claudeFirst = (models: ReadonlyArray<string>) => [
  ...models.filter((model) => model.toLowerCase().startsWith("claude")),
  ...models.filter((model) => !model.toLowerCase().startsWith("claude")),
];

/**
 * Access-keys ticket 02: Claude Code's aliases pinned to models the key may use and its accounts
 * serve, so neither the user's choice nor its background model (Haiku) asks for one the key
 * refuses. Each alias takes its family's model, else the first; the main model Sonnet's, else
 * Opus's, else the first. Null when no model is known.
 */
export function claudeCodeModels(models: ReadonlyArray<string>): ClaudeCodeModels | null {
  const ordered = claudeFirst([...new Set(models)]);
  const first = ordered[0];
  if (first === undefined) return null;
  const family = (name: string) => ordered.find((model) => model.toLowerCase().includes(name));
  const opus = family("opus");
  const sonnet = family("sonnet");
  return {
    main: sonnet ?? opus ?? first,
    opus: opus ?? first,
    sonnet: sonnet ?? first,
    haiku: family("haiku") ?? first,
  };
}

/** Codex's model: the first OpenAI one (`gpt*`, `o<digit>*`) the key may use, else the first. */
export function codexModel(models: ReadonlyArray<string>): string | null {
  return models.find((model) => /^(?:gpt|o\d)/iu.test(model)) ?? models[0] ?? null;
}

/**
 * The setup to copy. `models`: what the key may use that its accounts serve (access-keys ticket
 * 02); Claude Code's aliases and Codex's model are pinned to them, nothing when none is known.
 */
export function accessKeySetup(
  hubOrigin: string,
  key: string | null,
  models: ReadonlyArray<string> = [],
): AccessKeySetup {
  const secret = key ?? ACCESS_KEY_PLACEHOLDER;
  const claude = claudeCodeModels(models);
  const claudeCode = JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: `${hubOrigin}/api/ai/anthropic`,
        ANTHROPIC_AUTH_TOKEN: secret,
        ...(claude === null
          ? {}
          : {
              ANTHROPIC_MODEL: claude.main,
              ANTHROPIC_DEFAULT_OPUS_MODEL: claude.opus,
              ANTHROPIC_DEFAULT_SONNET_MODEL: claude.sonnet,
              ANTHROPIC_DEFAULT_HAIKU_MODEL: claude.haiku,
            }),
      },
    },
    null,
    2,
  );
  const codexPinned = codexModel(models);
  const codex = [
    "# ~/.codex/config.toml",
    ...(codexPinned === null ? [] : [`model = ${JSON.stringify(codexPinned)}`]),
    'model_provider = "t3"',
    "",
    "[model_providers.t3]",
    'name = "T3 Code Hub"',
    `base_url = ${JSON.stringify(`${hubOrigin}/api/ai/openai/v1`)}`,
    `env_key = "${CODEX_KEY_ENV}"`,
    'wire_api = "responses"',
    `# The key: in your shell's environment as ${CODEX_KEY_ENV}, never in this file.`,
  ].join("\n");
  const codexShell = `export ${CODEX_KEY_ENV}=${shellQuoted(secret)}`;
  const other = [
    `OpenAI-compatible base URL:    ${hubOrigin}/api/ai/openai/v1`,
    `Anthropic-compatible base URL: ${hubOrigin}/api/ai/anthropic`,
    `Gemini base URL:               ${hubOrigin}/api/ai/gemini`,
    `API key:                       ${secret}`,
    ...(models.length === 0
      ? []
      : [`Models:                        ${[...new Set(models)].join(", ")}`]),
    "",
    "Send the key as `Authorization: Bearer <key>` (or `x-api-key` for Anthropic,",
    "`x-goog-api-key` for Gemini). Never put it in the address.",
  ].join("\n");
  return { claudeCode, codex, codexShell, other };
}

/**
 * Whether a key sent to this Hub would cross the network unencrypted: plain `http:` to anything but
 * this machine. The setup dialog warns then.
 */
export function sendsKeyInClear(hubOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(hubOrigin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return !(
    host === "localhost" ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host)
  );
}

const shellQuoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
