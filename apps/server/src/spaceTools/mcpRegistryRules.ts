/**
 * The official MCP registry's answer (registry.modelcontextprotocol.io, `GET /v0/servers`) turned
 * into drafts for the "Add MCP server" form. The answer is untrusted: an entry that does not
 * decode, or whose draft breaks the Space MCP rules, is dropped, never repaired.
 */
import {
  SPACE_TOOL_NAME_PATTERN,
  SpaceMcpConfig,
  type SpaceMcpSearchResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { configProblem, referencesOf, secretLiteralIn } from "./spaceToolRules.ts";

const Text = Schema.String.check(Schema.isMaxLength(4096));

const Input = Schema.Struct({
  name: Schema.optionalKey(Text),
  value: Schema.optionalKey(Text),
  default: Schema.optionalKey(Text),
  valueHint: Schema.optionalKey(Text),
  type: Schema.optionalKey(Text),
  isSecret: Schema.optionalKey(Schema.Boolean),
  isRequired: Schema.optionalKey(Schema.Boolean),
  variables: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ isSecret: Schema.optionalKey(Schema.Boolean) })),
  ),
});
type Input = typeof Input.Type;

const Package = Schema.Struct({
  registryType: Text,
  identifier: Text,
  version: Schema.optionalKey(Text),
  runtimeHint: Schema.optionalKey(Text),
  transport: Schema.Struct({ type: Text }),
  runtimeArguments: Schema.optionalKey(Schema.Array(Input)),
  packageArguments: Schema.optionalKey(Schema.Array(Input)),
  environmentVariables: Schema.optionalKey(Schema.Array(Input)),
});
type Package = typeof Package.Type;

const Remote = Schema.Struct({
  type: Text,
  url: Text,
  headers: Schema.optionalKey(Schema.Array(Input)),
});
type Remote = typeof Remote.Type;

const Server = Schema.Struct({
  name: Text,
  title: Schema.optionalKey(Text),
  description: Schema.optionalKey(Text),
  version: Text,
  websiteUrl: Schema.optionalKey(Text),
  packages: Schema.optionalKey(Schema.Array(Package)),
  remotes: Schema.optionalKey(Schema.Array(Remote)),
});
type Server = typeof Server.Type;

const Answer = Schema.Struct({ servers: Schema.Array(Schema.Unknown) });
const decodeAnswer = Schema.decodeUnknownOption(Answer);
const decodeEntry = Schema.decodeUnknownOption(Schema.Struct({ server: Server }));
const isConfig = Schema.is(SpaceMcpConfig);

/** `SOME_NAME` from a registry name such as `token` or `api-key`. */
const envName = (name: string) =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");

/** A registry value with its secret `{variables}` turned into `${NAME}` references. */
const valueOf = (input: Input) => {
  const raw =
    input.value ?? input.default ?? (input.valueHint === undefined ? "" : `<${input.valueHint}>`);
  return raw.replace(/\{([A-Za-z0-9_-]+)\}/gu, (whole, variable: string) => {
    if (input.variables?.[variable]?.isSecret !== true) return whole;
    return `\${${envName(variable)}}`;
  });
};

const argumentsOf = (inputs: ReadonlyArray<Input> | undefined) =>
  (inputs ?? []).flatMap((input) => {
    const value = valueOf(input);
    if (input.type === "named" && input.name !== undefined) {
      return value === "" ? [input.name] : [input.name, value];
    }
    return value === "" ? [] : [value];
  });

/** How each package kind runs; one the Hub does not know how to start is not offered. */
const LAUNCHERS: Record<string, (pkg: Package) => { command: string; args: string[] }> = {
  npm: (pkg) => ({
    command: pkg.runtimeHint ?? "npx",
    args: ["-y", pkg.version === undefined ? pkg.identifier : `${pkg.identifier}@${pkg.version}`],
  }),
  pypi: (pkg) => ({
    command: pkg.runtimeHint ?? "uvx",
    args: [pkg.version === undefined ? pkg.identifier : `${pkg.identifier}==${pkg.version}`],
  }),
  oci: () => ({ command: "docker", args: ["run", "-i", "--rm"] }),
};

const stdioDraft = (pkg: Package): SpaceMcpConfig | undefined => {
  const launcher = LAUNCHERS[pkg.registryType];
  if (launcher === undefined || pkg.transport.type !== "stdio") return undefined;
  const { command, args } = launcher(pkg);
  const runtime = argumentsOf(pkg.runtimeArguments);
  const packageArgs = argumentsOf(pkg.packageArguments);
  const env: Record<string, string> = {};
  for (const variable of pkg.environmentVariables ?? []) {
    if (variable.name === undefined) continue;
    if (variable.isSecret === true) {
      env[variable.name] = `\${${envName(variable.name)}}`;
    } else if (variable.isRequired === true || variable.default !== undefined) {
      env[variable.name] = valueOf(variable);
    }
  }
  return {
    transport: "stdio",
    command,
    args:
      pkg.registryType === "oci"
        ? [...args, ...runtime, pkg.identifier, ...packageArgs]
        : [...runtime, ...args, ...packageArgs],
    env,
  };
};

const httpDraft = (remote: Remote, tokenName: string): SpaceMcpConfig | undefined => {
  if (remote.type !== "streamable-http" || !remote.url.startsWith("https://")) return undefined;
  const headers: Record<string, string> = {};
  for (const header of remote.headers ?? []) {
    if (header.name === undefined) continue;
    if (header.isSecret === true) {
      const bearer = header.name.toLowerCase() === "authorization";
      const name = bearer ? tokenName : envName(header.name);
      headers[header.name] = bearer ? `Bearer \${${name}}` : `\${${name}}`;
    } else {
      headers[header.name] = valueOf(header);
    }
  }
  return { transport: "http", url: remote.url, headers };
};

/** A valid Space MCP name from a registry name such as `io.github.owner/some_server`. */
const suggestedName = (registryName: string) => {
  const last = registryName.split("/").at(-1) ?? registryName;
  const name = last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63);
  return SPACE_TOOL_NAME_PATTERN.test(name) ? name : "mcp-server";
};

const resultOf = (server: Server): SpaceMcpSearchResult | undefined => {
  const name = suggestedName(server.name);
  const tokenName = `${envName(name)}_TOKEN`;
  // A remote runs nothing on a machine, so it comes first.
  const drafts = [
    ...(server.remotes ?? []).map((remote) => () => httpDraft(remote, tokenName)),
    ...(server.packages ?? []).map((pkg) => () => stdioDraft(pkg)),
  ];
  for (const draft of drafts) {
    const config = draft();
    if (config === undefined || !isConfig(config)) continue;
    if (configProblem(config) !== undefined || secretLiteralIn(config) !== undefined) continue;
    const refs = referencesOf(config);
    if (!("names" in refs)) continue;
    return {
      source: {
        registry: "mcp-registry",
        id: server.name.slice(0, 256),
        version: server.version.slice(0, 64),
      },
      title: server.title ?? server.name,
      description: (server.description ?? "").slice(0, 500),
      ...(server.websiteUrl?.startsWith("https://") ? { websiteUrl: server.websiteUrl } : {}),
      name,
      config,
      secrets: refs.names,
    };
  }
  return undefined;
};

export const MCP_REGISTRY_MAX_RESULTS = 20;

/** The usable entries of a registry answer, one per registry name; `undefined` if it is not one. */
export const registryResults = (
  answer: unknown,
): ReadonlyArray<SpaceMcpSearchResult> | undefined => {
  const decoded = decodeAnswer(answer);
  if (Option.isNone(decoded)) return undefined;
  const seen = new Set<string>();
  const results: SpaceMcpSearchResult[] = [];
  for (const entry of decoded.value.servers) {
    const server = decodeEntry(entry);
    if (Option.isNone(server) || seen.has(server.value.server.name)) continue;
    const result = resultOf(server.value.server);
    if (result === undefined) continue;
    seen.add(server.value.server.name);
    results.push(result);
    if (results.length === MCP_REGISTRY_MAX_RESULTS) break;
  }
  return results;
};
