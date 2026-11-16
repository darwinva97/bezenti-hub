import { SecretProviderKind, SettingsSecretValue } from "@t3tools/contracts";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Schema from "effect/Schema";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `https://` anywhere; `http://` only to this machine (`bao server -dev`). An origin, no path. */
const addressProblem = (value: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "OpenBao address must be a URL like https://bao.example.com:8200.";
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    return "OpenBao address must use https:// (http:// only to localhost).";
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return "OpenBao address carries no user, query, or fragment.";
  }
  if (url.pathname !== "/" && url.pathname !== "") return "OpenBao address has no path.";
  return undefined;
};

const OpenBaoAddress = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter((value: string) => addressProblem(value) ?? true),
);

const SEGMENTS = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
/** A mount or namespace path: plain segments, no leading or trailing slash. */
const OpenBaoPath = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter((value: string) =>
    SEGMENTS.test(value) ? true : "Use plain path segments like kv or team/kv.",
  ),
);

const NAME = /^[A-Za-z0-9._@-]+$/;
const OpenBaoName = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter((value: string) =>
    NAME.test(value) ? true : "Use letters, digits, and . _ @ - only.",
  ),
);

/** A certificate in PEM, inline: not a secret. A private key pasted here is refused. */
const Certificate = Schema.String.check(
  Schema.isMaxLength(64 * 1024),
  Schema.makeFilter((value: string) =>
    !value.includes("-----BEGIN CERTIFICATE-----")
      ? "Paste a PEM certificate (-----BEGIN CERTIFICATE-----)."
      : /PRIVATE KEY/.test(value)
        ? "A private key never goes in a certificate field."
        : true,
  ),
);

/** A file the Hub reads to sign in; it must also lie under the operator's file roots. */
const AbsoluteFile = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter((value: string) =>
    value.startsWith("/") && !/[\u0000-\u001f]/.test(value) ? true : "Use an absolute file path.",
  ),
);

export const OpenBaoAuthMethod = Schema.Literals(["kubernetes", "jwt", "approle", "token", "cert"]);
export type OpenBaoAuthMethod = typeof OpenBaoAuthMethod.Type;

const OpenBaoMount = Schema.Struct({ path: OpenBaoPath, version: Schema.Literals([1, 2]) });
export type OpenBaoMount = typeof OpenBaoMount.Type;

const REQUIRED_BY_METHOD: Readonly<Record<OpenBaoAuthMethod, ReadonlyArray<string>>> = {
  kubernetes: ["authRole"],
  jwt: ["authRole", "tokenFile"],
  approle: ["roleId", "secretId"],
  token: ["token"],
  cert: ["clientCert", "clientKey"],
};

/**
 * Credentials (`token`, `secretId`, `clientKey`) are sealed by the server; on disk and to
 * clients they read "". A certificate or CA is inline PEM. There is no switch to skip TLS checks.
 */
export const OpenBaoSecretProviderConfig = Schema.Struct({
  address: OpenBaoAddress,
  namespace: Schema.optional(OpenBaoPath),
  caCert: Schema.optional(Certificate),
  mounts: Schema.Array(OpenBaoMount).check(
    Schema.isMinLength(1),
    Schema.makeFilter((mounts: ReadonlyArray<OpenBaoMount>) =>
      new Set(mounts.map((mount) => mount.path)).size === mounts.length
        ? true
        : "Declare each mount once.",
    ),
  ),
  authMethod: OpenBaoAuthMethod,
  authMount: Schema.optional(OpenBaoPath),
  authRole: Schema.optional(OpenBaoName),
  tokenFile: Schema.optional(AbsoluteFile),
  roleId: Schema.optional(OpenBaoName),
  secretId: Schema.optional(SettingsSecretValue),
  token: Schema.optional(SettingsSecretValue),
  clientCert: Schema.optional(Certificate),
  clientKey: Schema.optional(SettingsSecretValue),
  refreshIntervalSeconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 86_400 })),
  ),
}).check(
  Schema.makeFilter((config) => {
    const missing = REQUIRED_BY_METHOD[config.authMethod].filter(
      (field) => (config as Readonly<Record<string, unknown>>)[field] === undefined,
    );
    return missing.length === 0
      ? true
      : `Sign-in with ${config.authMethod} needs ${missing.join(", ")}.`;
  }),
);
export type OpenBaoSecretProviderConfig = typeof OpenBaoSecretProviderConfig.Type;
const isConfig = Schema.is(OpenBaoSecretProviderConfig);

const SEGMENT = String.raw`(?!\.{1,2}(?:[/?#]|$))[A-Za-z0-9._-]+`;
const REFERENCE = new RegExp(
  String.raw`^(${SEGMENT}(?:/${SEGMENT})+)(?:\?version=([1-9][0-9]{0,9}))?#([A-Za-z0-9._-]+)$`,
);
const MAX_REFERENCE_LENGTH = 1024;

/** A reference read against the provider's mounts: KV path, field, and pinned version. */
export interface OpenBaoReference {
  readonly mount: string;
  readonly kvVersion: 1 | 2;
  readonly path: string;
  readonly version: number | undefined;
  readonly field: string;
}

/** The longest declared mount the reference lies under, by whole segments; else undefined. */
export const parseReference = (
  mounts: ReadonlyArray<OpenBaoMount>,
  reference: string,
): OpenBaoReference | undefined => {
  const match = reference.length <= MAX_REFERENCE_LENGTH ? REFERENCE.exec(reference) : null;
  if (match === null) return undefined;
  const [, fullPath = "", version, field = ""] = match;
  const mount = mounts
    .filter((candidate) => fullPath.startsWith(`${candidate.path}/`))
    .reduce<OpenBaoMount | undefined>(
      (longest, candidate) =>
        longest === undefined || candidate.path.length > longest.path.length ? candidate : longest,
      undefined,
    );
  if (mount === undefined) return undefined;
  return {
    mount: mount.path,
    kvVersion: mount.version,
    path: fullPath.slice(mount.path.length + 1),
    version: version === undefined ? undefined : Number(version),
    field,
  };
};

/** What a Provider scope may change: never a credential, nor the sign-in method itself. */
const withScopeAuth = (
  config: OpenBaoSecretProviderConfig,
  auth: Readonly<Record<string, string>>,
): OpenBaoSecretProviderConfig | undefined => {
  const overrides: { authRole?: string; authMount?: string; namespace?: string } = {};
  for (const [field, value] of Object.entries(auth)) {
    switch (field) {
      case "method":
        if (value !== config.authMethod) return undefined;
        break;
      case "role":
        overrides.authRole = value;
        break;
      case "mount":
        overrides.authMount = value;
        break;
      case "namespace":
        overrides.namespace = value;
        break;
      default:
        return undefined;
    }
  }
  const next = { ...config, ...overrides };
  return isConfig(next) ? next : undefined;
};

export const definition = defineSecretProvider({
  kind: SecretProviderKind.make("openbao"),
  label: "OpenBao / HashiCorp Vault",
  configSchema: OpenBaoSecretProviderConfig,
  isReference: (reference) => reference.length <= MAX_REFERENCE_LENGTH && REFERENCE.test(reference),
  configReferenceProblem: (config, reference) => {
    const parsed = parseReference(config.mounts, reference);
    if (parsed === undefined) {
      return `The reference must start with a mount this provider declares: ${config.mounts
        .map((mount) => mount.path)
        .join(", ")}.`;
    }
    return parsed.version !== undefined && parsed.kvVersion === 1
      ? `Mount ${parsed.mount} is KV v1: it has no ?version=.`
      : undefined;
  },
  withScopeAuth,
  referencePlaceholder: "kv/acme/app#token",
  invalidReferenceMessage: "Use a reference like kv/acme/app#token or kv/acme/app?version=2#token.",
  credentialFields: ["token", "secretId", "clientKey"],
});
