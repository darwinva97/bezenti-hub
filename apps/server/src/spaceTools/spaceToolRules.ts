import {
  SPACE_MCPS_CONTRACT_VERSION,
  SPACE_SKILL_MAX_BYTES,
  SPACE_SKILL_MAX_FILES,
  SPACE_TOOL_NAME_PATTERN,
  type SpaceMcpConfig,
  type SpaceMcpUnavailableReason,
  type SpaceSkillFiles,
} from "@t3tools/contracts";
import { parse as parseYamlDocument } from "yaml";

export type RuleProblem = {
  readonly reason: "invalid" | "secret-literal";
  readonly message: string;
};

const REFERENCE = /\$\{([^}]*)\}/gu;
const VAULT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const CREDENTIAL_VARIABLE = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL/iu;
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie)$|[-_](token|key|secret)$/iu;

const valuesOf = (config: SpaceMcpConfig) =>
  config.transport === "stdio"
    ? [config.command, ...config.args, ...Object.values(config.env)]
    : [config.url, ...Object.values(config.headers)];

/** The Vault names a configuration's `${NAME}` references, or the first malformed one. */
export const referencesOf = (
  config: SpaceMcpConfig,
): { readonly names: ReadonlyArray<string> } | RuleProblem => {
  const names = new Set<string>();
  for (const value of valuesOf(config)) {
    for (const match of value.matchAll(REFERENCE)) {
      const name = match[1] ?? "";
      if (!VAULT_NAME.test(name)) {
        return { reason: "invalid", message: `\${${name}} is not a Vault name.` };
      }
      names.add(name);
    }
  }
  return { names: [...names].toSorted() };
};

/**
 * Not complete, only the obvious mistake: a credential-looking variable or header given as a
 * literal. Anything else literal (arguments, URLs) is the Admin's to keep free of Secrets.
 */
export const secretLiteralIn = (config: SpaceMcpConfig): RuleProblem | undefined => {
  const entries =
    config.transport === "stdio"
      ? Object.entries(config.env).filter(([key]) => CREDENTIAL_VARIABLE.test(key))
      : Object.entries(config.headers).filter(([key]) => CREDENTIAL_HEADER.test(key));
  const literal = entries.find(([, value]) => value.trim() !== "" && !value.includes("${"));
  return literal === undefined
    ? undefined
    : {
        reason: "secret-literal",
        message: `${literal[0]} looks like a credential: put it in the Vault and write \${NAME}.`,
      };
};

export const nameProblem = (name: string): RuleProblem | undefined =>
  !SPACE_TOOL_NAME_PATTERN.test(name)
    ? { reason: "invalid", message: "Use lowercase letters, digits and dashes." }
    : name.startsWith("t3-code")
      ? { reason: "invalid", message: "Names starting with t3-code are the Hub's own." }
      : undefined;

export const configProblem = (config: SpaceMcpConfig): RuleProblem | undefined => {
  if (config.transport === "stdio") {
    if (config.command.trim() === "") return { reason: "invalid", message: "Give a command." };
    if (config.command.includes("${")) {
      return { reason: "invalid", message: "The command itself cannot be a Vault reference." };
    }
    const badKey = Object.keys(config.env).find((key) => !VAULT_NAME.test(key));
    if (badKey !== undefined) {
      return { reason: "invalid", message: `${badKey} is not an environment variable name.` };
    }
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    return { reason: "invalid", message: "Give the server's URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { reason: "invalid", message: "The URL must be http or https." };
  }
  if (url.username !== "" || url.password !== "" || config.url.includes("${")) {
    return {
      reason: "secret-literal",
      message: "Put credentials in a header that references the Vault, not in the URL.",
    };
  }
  return undefined;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

/** `SKILL.md`'s name and description, and the bundle's paths and size, checked. */
export const readSkill = (
  files: SpaceSkillFiles,
): { readonly name: string; readonly description: string } | RuleProblem => {
  const paths = Object.keys(files);
  if (paths.length > SPACE_SKILL_MAX_FILES) {
    return { reason: "invalid", message: `At most ${SPACE_SKILL_MAX_FILES} files.` };
  }
  const badPath = paths.find(
    (path) =>
      path === "" ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => part === "" || part === "." || part === ".."),
  );
  if (badPath !== undefined) return { reason: "invalid", message: `${badPath} is not a path.` };
  const size = Object.values(files).reduce(
    (total, text) => total + Buffer.byteLength(text, "utf8"),
    0,
  );
  if (size > SPACE_SKILL_MAX_BYTES) {
    return { reason: "invalid", message: "A Skill holds at most 256 KiB of text." };
  }
  const skill = files["SKILL.md"];
  if (skill === undefined) return { reason: "invalid", message: "A Skill needs SKILL.md." };
  const frontmatter = FRONTMATTER.exec(skill)?.[1];
  let parsed: unknown;
  try {
    parsed = frontmatter === undefined ? undefined : parseYamlDocument(frontmatter);
  } catch {
    parsed = undefined;
  }
  const fields =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  const problem = nameProblem(name);
  if (problem !== undefined) {
    return {
      reason: "invalid",
      message: `SKILL.md's frontmatter needs a name. ${problem.message}`,
    };
  }
  if (description === "") {
    return { reason: "invalid", message: "SKILL.md's frontmatter needs a description." };
  }
  return { name, description: description.slice(0, 1024) };
};

export const expectsProblem = (expects: ReadonlyArray<string>): RuleProblem | undefined => {
  const bad = expects.find((name) => !VAULT_NAME.test(name));
  return bad === undefined
    ? undefined
    : { reason: "invalid", message: `${bad} is not a Vault name.` };
};

export interface SpaceMcpDecision {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly config: SpaceMcpConfig;
  readonly available: boolean;
  readonly reason?: SpaceMcpUnavailableReason;
  readonly missing: ReadonlyArray<string>;
}

/**
 * Which of a Thread's Space MCPs its session gets, decided on the Hub before it opens. One whose
 * referenced name the Thread does not receive is never sent: it would start with an empty value.
 */
export const decideSpaceMcps = (input: {
  readonly mcps: ReadonlyArray<{ readonly name: string; readonly config: SpaceMcpConfig }>;
  readonly delivered: ReadonlySet<string>;
  readonly receivesSpaceMcps: boolean;
  readonly receivesSecretEnv: boolean;
  readonly contractVersion: number;
}): ReadonlyArray<SpaceMcpDecision> =>
  input.mcps.map(({ name, config }) => {
    const base = { name, transport: config.transport, config };
    const refs = referencesOf(config);
    const names = "names" in refs ? refs.names : [];
    const unavailable = (
      reason: SpaceMcpUnavailableReason,
      missing: ReadonlyArray<string> = [],
    ) => ({
      ...base,
      available: false,
      reason,
      missing,
    });
    if (!input.receivesSpaceMcps) return unavailable("not-supported");
    if (input.contractVersion < SPACE_MCPS_CONTRACT_VERSION) return unavailable("outdated-machine");
    if (!("names" in refs)) return unavailable("not-delivered");
    if (names.length > 0 && !input.receivesSecretEnv) return unavailable("no-secrets");
    const missing = names.filter((ref) => !input.delivered.has(ref));
    if (missing.length > 0) return unavailable("not-delivered", missing);
    return { ...base, available: true, missing: [] };
  });
