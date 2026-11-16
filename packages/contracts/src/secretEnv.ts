/** Spec 5 ticket 04: a Thread's secrets on their way to one process, as environment variables. */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The executor contract from which a machine receives `secretEnv`. */
export const SECRET_ENV_CONTRACT_VERSION = 10;

/** The executor contract from which a machine receives Secret files (`secretEnv.files`). */
export const SECRET_FILES_CONTRACT_VERSION = 14;

/** A Secret file's content, at most this many bytes; all of one process's, at most 1 MiB. */
export const SECRET_FILE_MAX_BYTES = 64 * 1024;
export const SECRET_FILES_MAX_TOTAL_BYTES = 1024 * 1024;

/**
 * One Secret file: written in the machine's folder in memory, never on its disk, and its path set
 * as variable `name`. `mode` is 0400 or 0600 (owner only).
 */
export const SecretEnvFile = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]{0,127}$/)),
  content: Schema.String,
  mode: Schema.Literals([0o400, 0o600]),
  /** A Variable template's file: configuration, never masked. */
  plain: Schema.optionalKey(Schema.Literal(true)),
});
export type SecretEnvFile = typeof SecretEnvFile.Type;

/**
 * Where a machine writes Secret files (`<root>/<filesFolder>/<NAME>`), as it says in its hello.
 * `inMemory` false: no folder in memory, so it receives no Secret file at all.
 */
export const SecretFilesRoot = Schema.Struct({
  path: Schema.String,
  inMemory: Schema.Boolean,
});
export type SecretFilesRoot = typeof SecretFilesRoot.Type;

/** The folder of one Thread root and User's Secret files: an id the Hub derives, never a path. */
export const SecretFilesFolder = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/));

/**
 * One variable of a Thread's secrets, with its value. Sent only over the Environment's link.
 * `plain`: a Vault Variable, never masked. An older executor ignores it and masks it in its own
 * logs (more masking, never less).
 */
export const SecretEnvVariable = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  plain: Schema.optionalKey(Schema.Literal(true)),
});
export type SecretEnvVariable = typeof SecretEnvVariable.Type;

/** The fingerprint of no secrets: sent explicitly, so a set that became empty is a change. */
export const NO_SECRETS_FINGERPRINT = "none";

/**
 * The secrets of the User who starts a process. `fingerprint` names the set (names and value ids,
 * never values). Without `variables` it only says which set is current: a running process with
 * another is stale, and a process that would start asks for the values (`secrets_required`).
 */
export const SecretEnv = Schema.Struct({
  fingerprint: TrimmedNonEmptyString,
  variables: Schema.optionalKey(Schema.Array(SecretEnvVariable)),
  /**
   * Spec 4 ticket 07: the variable among `variables` that holds the Thread's direct AI account
   * credential. Its process drops every ambient AI credential first and starts only on a provider
   * that takes it (`acceptsAiCredential`). Machines of contract 13 and later only.
   */
  aiCredential: Schema.optionalKey(Schema.String),
  /**
   * Contract 14: Secret files, written in `filesFolder` under the machine's `SecretFilesRoot` while
   * the process lives; each one's path goes in its variable. Never sent to an older machine.
   */
  files: Schema.optionalKey(Schema.Array(SecretEnvFile)),
  filesFolder: Schema.optionalKey(SecretFilesFolder),
});
export type SecretEnv = typeof SecretEnv.Type;

/** `secrets.refreshFiles`: new contents for a folder's files, in place, while processes hold it. */
export const SecretFilesRefreshInput = Schema.Struct({
  filesFolder: SecretFilesFolder,
  files: Schema.Array(SecretEnvFile),
});
export type SecretFilesRefreshInput = typeof SecretFilesRefreshInput.Type;

/**
 * Secret files a machine did not write: no folder in memory, a folder that is not its own (a
 * symlink, another user's), or a file it could not write. Names only, never a content.
 */
export class SecretFilesError extends Schema.TaggedError<SecretFilesError>()("SecretFilesError", {
  reason: Schema.Literals(["not-in-memory", "unsafe-folder", "write-failed", "invalid"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** The key `secretEnv` travels under in a request payload. */
export const SECRET_ENV_FIELD = "secretEnv";

/** Run failures whose code starts with this are a Secret provider's: «Retry» starts the turn again. */
export const SECRET_PROVIDER_FAILURE_CODE_PREFIX = "secret_provider_";

/**
 * A Secret provider did not give a Provider entry's value, so the process did not start: nothing
 * of the set is delivered (never the last value known). Names the provider (its label), the scope
 * and the entries; never a value nor anything the provider said.
 */
export class SecretProviderReadError extends Schema.TaggedError<SecretProviderReadError>()(
  "SecretProviderReadError",
  {
    reason: Schema.Literals(["unavailable", "forbidden", "not-found", "invalid"]),
    provider: Schema.String,
    scope: Schema.NullOr(Schema.String),
    entries: Schema.Array(Schema.String),
  },
) {
  /** The run failure's code (`secret_provider_<reason>`): clients offer «Retry» on it. */
  get code(): string {
    return `${SECRET_PROVIDER_FAILURE_CODE_PREFIX}${this.reason.replace("-", "_")}`;
  }

  override get message(): string {
    const names = this.entries.join(", ");
    switch (this.reason) {
      case "unavailable":
        return `${this.provider} didn't answer for ${names}. Retry, or start without them by removing them from the Thread's Vaults.`;
      case "forbidden":
        return `${this.provider} refused to give ${names}: check the role the Hub signs in with.`;
      case "not-found":
        return `${this.provider} has nothing at the reference of ${names}.`;
      case "invalid":
        return `${names}: the reference is not one ${this.provider} reads.`;
    }
  }
}

/**
 * Why a process of a Thread with secrets was not started (never without them): a machine before
 * contract 10 (or 14 for files) or without memory for files; a template's entry a filter cannot
 * take; a provider that cannot take an environment per session, or shares its process.
 */
export class SecretDeliveryError extends Schema.TaggedError<SecretDeliveryError>()(
  "SecretDeliveryError",
  {
    reason: Schema.Literals([
      "outdated-machine",
      "outdated-machine-files",
      "files-not-in-memory",
      "template",
      "provider",
      "shared-process",
    ]),
    environmentName: Schema.optional(Schema.String),
    provider: Schema.optional(Schema.String),
    entries: Schema.optional(Schema.Array(Schema.String)),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "outdated-machine":
        return `${this.environmentName ?? "This machine"} needs an update to receive this Thread's secrets.`;
      case "outdated-machine-files":
        return `${this.environmentName ?? "This machine"} needs an update to receive this Thread's secret files.`;
      case "template":
        return `${this.entries?.[0] ?? "A template"} could not be composed: ${this.entries?.[1] ?? "an entry"} is not what its filter takes.`;
      case "files-not-in-memory":
        return `${this.environmentName ?? "This machine"} has no folder in memory, so it gets no secret files (${(this.entries ?? []).join(", ")}): they are never written to its disk. Deliver them as environment variables, or run the Thread on another machine.`;
      case "provider":
        return `${this.provider ?? "This provider"} can't receive this Thread's secrets yet. Pick another provider, or remove the Vaults from this Project.`;
      case "shared-process":
        return `${this.provider ?? "This provider"} runs this Thread in a process shared with other Threads, so it can't receive this Thread's secrets. Start a new Thread to receive them.`;
    }
  }
}
