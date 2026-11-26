/**
 * A Space's MCP servers and Skills as every client words and edits them (web, desktop, mobile).
 * The forms keep a server's settings as lines of text; these turn them into the RPC's shape.
 */
import type {
  SpaceMcpConfig,
  SpaceMcpUnavailableReason,
  SpaceToolsThreadStatus,
} from "@t3tools/contracts";

/** `KEY=value` lines (environment variables) or `Name: value` lines (headers), blank lines skipped. */
export const parsePairs = (
  text: string,
  separator: "=" | ":",
): { readonly pairs: Record<string, string> } | { readonly error: string } => {
  const pairs: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const at = line.indexOf(separator);
    if (at <= 0) {
      return { error: `Write each line as ${separator === "=" ? "NAME=value" : "Name: value"}.` };
    }
    pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { pairs };
};

export const pairsText = (pairs: Readonly<Record<string, string>>, separator: "=" | ":") =>
  Object.entries(pairs)
    .map(([key, value]) => (separator === "=" ? `${key}=${value}` : `${key}: ${value}`))
    .join("\n");

export interface SpaceMcpForm {
  readonly transport: "stdio" | "http";
  readonly command: string;
  /** One argument per line. */
  readonly args: string;
  readonly env: string;
  readonly url: string;
  readonly headers: string;
}

export const emptyMcpForm: SpaceMcpForm = {
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  url: "",
  headers: "",
};

export const mcpFormOf = (config: SpaceMcpConfig): SpaceMcpForm =>
  config.transport === "stdio"
    ? {
        ...emptyMcpForm,
        transport: "stdio",
        command: config.command,
        args: config.args.join("\n"),
        env: pairsText(config.env, "="),
      }
    : {
        ...emptyMcpForm,
        transport: "http",
        url: config.url,
        headers: pairsText(config.headers, ":"),
      };

export const mcpConfigOf = (
  form: SpaceMcpForm,
): { readonly config: SpaceMcpConfig } | { readonly error: string } => {
  if (form.transport === "http") {
    const headers = parsePairs(form.headers, ":");
    if ("error" in headers) return headers;
    return { config: { transport: "http", url: form.url.trim(), headers: headers.pairs } };
  }
  const env = parsePairs(form.env, "=");
  if ("error" in env) return env;
  return {
    config: {
      transport: "stdio",
      command: form.command.trim(),
      args: form.args
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
      env: env.pairs,
    },
  };
};

const REASONS: Record<SpaceMcpUnavailableReason, string> = {
  "not-delivered": "this Thread does not receive",
  "not-supported": "this agent does not take Space MCP servers",
  "no-secrets": "this agent cannot receive Vault entries",
  "outdated-machine": "this Thread's machine needs an update",
};

/** Why a Space MCP server is not available to a Thread, in words. */
export const unavailableText = (mcp: SpaceToolsThreadStatus["mcps"][number]) =>
  mcp.reason === undefined
    ? "Available"
    : mcp.reason === "not-delivered"
      ? `Unavailable: ${REASONS[mcp.reason]} ${mcp.missing.join(", ")}`
      : `Unavailable: ${REASONS[mcp.reason]}`;
