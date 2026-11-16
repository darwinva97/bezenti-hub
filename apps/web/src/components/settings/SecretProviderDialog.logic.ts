import {
  SecretProviderId,
  SecretProviderKind,
  SecretProviderLabel,
  type SecretProviderConfig,
  type SecretReference,
} from "@t3tools/contracts";
import {
  OnePasswordSecretProviderConfig,
  type OnePasswordAccount,
} from "@t3tools/secret-provider-onepassword/shared/definition";
import {
  OpenBaoSecretProviderConfig,
  type OpenBaoAuthMethod,
} from "@t3tools/secret-provider-openbao/shared/definition";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const decodeSecretProviderId = Schema.decodeOption(SecretProviderId);
const decodeOnePasswordConfig = Schema.decodeUnknownOption(OnePasswordSecretProviderConfig);
const decodeOpenBaoConfig = Schema.decodeUnknownOption(OpenBaoSecretProviderConfig);
const checkOpenBaoConfig = Schema.decodeUnknownResult(OpenBaoSecretProviderConfig);

export type ClassifiedSecretProvider =
  | { readonly kind: "one_password"; readonly account: OnePasswordAccount }
  | { readonly kind: "openbao"; readonly config: OpenBaoSecretProviderConfig }
  | { readonly kind: "unsupported" };

/** Unknown kinds and configs that no longer decode are shown read-only; removal stays available. */
export function classifySecretProvider(provider: SecretProviderConfig): ClassifiedSecretProvider {
  if (provider.kind === "one_password") {
    const decoded = decodeOnePasswordConfig(provider.config);
    return decoded._tag === "Some"
      ? { kind: "one_password", account: decoded.value.account }
      : { kind: "unsupported" };
  }
  if (provider.kind === "openbao") {
    const decoded = decodeOpenBaoConfig(provider.config);
    return decoded._tag === "Some"
      ? { kind: "openbao", config: decoded.value }
      : { kind: "unsupported" };
  }
  return { kind: "unsupported" };
}

/** Stable and readable in settings.json, so re-adding a provider under the same name restores its variables. */
function secretProviderIdFromName(name: string): SecretProviderId | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/, "");
  return Option.getOrNull(decodeSecretProviderId(slug));
}

/** The credential each sign-in method holds; the server seals it and sends back a marker. */
export const OPENBAO_CREDENTIAL: Readonly<
  Record<OpenBaoAuthMethod, { readonly field: string; readonly label: string } | undefined>
> = {
  kubernetes: undefined,
  jwt: undefined,
  approle: { field: "secretId", label: "secret ID" },
  token: { field: "token", label: "token" },
  cert: { field: "clientKey", label: "client key" },
};

export interface OpenBaoDraft {
  readonly address: string;
  readonly namespace: string;
  /** PEM, added to the system CAs. */
  readonly caCert: string;
  /** One mount per line: `kv v2`, `team/legacy v1`. */
  readonly mounts: string;
  readonly authMethod: OpenBaoAuthMethod;
  readonly authRole: string;
  readonly authMount: string;
  readonly tokenFile: string;
  readonly roleId: string;
  readonly clientCert: string;
  /** The method's credential: a new value, the saved marker, or a reference to another provider. */
  readonly credential: string | SecretReference;
  /** Kept from a saved provider; the form has no field for it. */
  readonly refreshIntervalSeconds?: number;
}

export const emptyOpenBaoDraft: OpenBaoDraft = {
  address: "",
  namespace: "",
  caCert: "",
  mounts: "kv v2",
  authMethod: "kubernetes",
  authRole: "",
  authMount: "",
  tokenFile: "",
  roleId: "",
  clientCert: "",
  credential: "",
};

export interface SecretProviderDraft {
  /** Absent: 1Password, the kind before OpenBao. */
  readonly kind?: "one_password" | "openbao";
  readonly name: string;
  readonly account: string;
  readonly openBao?: OpenBaoDraft;
}

export function draftFromSecretProvider(provider: SecretProviderConfig): SecretProviderDraft {
  const classified = classifySecretProvider(provider);
  if (classified.kind === "openbao") {
    const config = classified.config;
    const credential = OPENBAO_CREDENTIAL[config.authMethod];
    const saved =
      credential === undefined
        ? undefined
        : (config as Readonly<Record<string, unknown>>)[credential.field];
    return {
      kind: "openbao",
      name: provider.label,
      account: "",
      openBao: {
        address: config.address,
        namespace: config.namespace ?? "",
        caCert: config.caCert ?? "",
        mounts: config.mounts.map((mount) => `${mount.path} v${mount.version}`).join("\n"),
        authMethod: config.authMethod,
        authRole: config.authRole ?? "",
        authMount: config.authMount ?? "",
        tokenFile: config.tokenFile ?? "",
        roleId: config.roleId ?? "",
        clientCert: config.clientCert ?? "",
        credential: (saved as string | SecretReference | undefined) ?? "",
        ...(config.refreshIntervalSeconds === undefined
          ? {}
          : { refreshIntervalSeconds: config.refreshIntervalSeconds }),
      },
    };
  }
  return {
    name: provider.label,
    account: classified.kind === "one_password" ? classified.account : "",
  };
}

export type SecretProviderTarget =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly id: SecretProviderId };

export interface SecretProviderDraftIssues {
  readonly name?: string;
  readonly account?: string;
  readonly openBao?: string;
}

function decodeField<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: string,
  emptyMessage: string,
): Result.Result<S["Type"], string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return Result.fail(emptyMessage);
  return Result.mapError(Schema.decodeResult(schema)(trimmed), (error) => error.message);
}

const MOUNT_LINE = /^(\S+)\s+v?([12])$/;

function mountsFromText(
  text: string,
): Result.Result<ReadonlyArray<{ readonly path: string; readonly version: 1 | 2 }>, string> {
  const mounts: Array<{ readonly path: string; readonly version: 1 | 2 }> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = MOUNT_LINE.exec(trimmed);
    if (match === null) {
      return Result.fail(`Write each mount as a path and its KV version, v1 or v2: «${trimmed}».`);
    }
    mounts.push({ path: match[1]!, version: match[2] === "1" ? 1 : 2 });
  }
  return mounts.length === 0
    ? Result.fail("Declare at least one KV mount, like kv v2.")
    : Result.succeed(mounts);
}

const optional = (field: string, value: string) => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? {} : { [field]: trimmed };
};

/** The OpenBao config a draft sends: only the fields its sign-in method uses. */
function openBaoConfigFromDraft(draft: OpenBaoDraft): Result.Result<unknown, string> {
  const mounts = mountsFromText(draft.mounts);
  if (Result.isFailure(mounts)) return mounts;
  const method = draft.authMethod;
  const credential = OPENBAO_CREDENTIAL[method];
  if (credential !== undefined && draft.credential === "") {
    return Result.fail(`Enter the ${credential.label}.`);
  }
  const config = {
    address: draft.address.trim(),
    ...optional("namespace", draft.namespace),
    ...optional("caCert", draft.caCert),
    mounts: mounts.success,
    authMethod: method,
    ...(method === "approle" ? {} : optional("authRole", draft.authRole)),
    ...optional("authMount", draft.authMount),
    ...(method === "kubernetes" || method === "jwt" ? optional("tokenFile", draft.tokenFile) : {}),
    ...(method === "approle" ? optional("roleId", draft.roleId) : {}),
    ...(method === "cert" ? optional("clientCert", draft.clientCert) : {}),
    ...(credential === undefined ? {} : { [credential.field]: draft.credential }),
    ...(draft.refreshIntervalSeconds === undefined
      ? {}
      : { refreshIntervalSeconds: draft.refreshIntervalSeconds }),
  };
  return Result.mapBoth(checkOpenBaoConfig(config), {
    onFailure: (error) => error.message,
    onSuccess: () => config,
  });
}

/** The settings entry a draft adds or replaces, or every field that blocks it, one message each. */
export function secretProviderFromDraft(
  draft: SecretProviderDraft,
  existingIds: ReadonlySet<string>,
  target: SecretProviderTarget,
): Result.Result<
  { readonly id: SecretProviderId; readonly config: SecretProviderConfig },
  SecretProviderDraftIssues
> {
  const label = decodeField(SecretProviderLabel, draft.name, "Enter a name.");
  const content: Result.Result<
    { readonly kind: SecretProviderKind; readonly config: unknown },
    SecretProviderDraftIssues
  > =
    draft.kind === "openbao"
      ? Result.mapBoth(openBaoConfigFromDraft(draft.openBao ?? emptyOpenBaoDraft), {
          onFailure: (openBao) => ({ openBao }),
          onSuccess: (config) => ({ kind: SecretProviderKind.make("openbao"), config }),
        })
      : Result.mapBoth(
          decodeField(
            OnePasswordSecretProviderConfig.fields.account,
            draft.account,
            "Enter the 1Password account.",
          ),
          {
            onFailure: (account) => ({ account }),
            onSuccess: (account) => ({
              kind: SecretProviderKind.make("one_password"),
              config: { account },
            }),
          },
        );

  let id: SecretProviderId | null = null;
  let nameIssue: string | undefined;
  if (Result.isFailure(label)) {
    nameIssue = label.failure;
  } else {
    id = target.mode === "edit" ? target.id : secretProviderIdFromName(label.success);
    if (id === null) nameIssue = "The name needs at least one letter or digit.";
    else if (target.mode === "add" && existingIds.has(id))
      nameIssue = "A secret provider with this name exists.";
  }

  if (
    id === null ||
    nameIssue !== undefined ||
    Result.isFailure(label) ||
    Result.isFailure(content)
  ) {
    return Result.fail({
      ...(nameIssue === undefined ? {} : { name: nameIssue }),
      ...(Result.isFailure(content) ? content.failure : {}),
    });
  }
  return Result.succeed({
    id,
    config: { kind: content.success.kind, label: label.success, config: content.success.config },
  });
}
