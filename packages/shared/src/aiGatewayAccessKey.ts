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

export function accessKeySetup(hubOrigin: string, key: string | null): AccessKeySetup {
  const secret = key ?? ACCESS_KEY_PLACEHOLDER;
  const claudeCode = JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: `${hubOrigin}/api/ai/anthropic`,
        ANTHROPIC_AUTH_TOKEN: secret,
      },
    },
    null,
    2,
  );
  const codex = [
    "# ~/.codex/config.toml",
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
