import type { SecretProviderKind } from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process";

import type { SecretProviderDefinition } from "../shared/definition.ts";

/** What the server gives every driver. A driver builds anything else it needs itself. */
export type SecretProviderDriverServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | SecureRandom.SecureRandom;

/**
 * Why a reference was not read. A class, never text: a provider's own messages (a CLI's stderr,
 * an HTTP body) can echo what they hold, so none of them leaves a driver.
 */
export type SecretReadError = "not-found" | "forbidden" | "unavailable" | "invalid";

/** One reference's outcome. `expiresAt`: epoch milliseconds after which it is read again. */
export type SecretReadResult =
  | {
      readonly _tag: "value";
      readonly value: string;
      readonly expiresAt?: number;
      readonly version?: string;
    }
  | { readonly _tag: "error"; readonly error: SecretReadError };

/** «Test connection»: whether the provider takes the configured sign-in. Never its text. */
export interface SecretProviderTestReport {
  readonly ok: boolean;
  readonly error?: SecretReadError;
}

export const readValue = (value: string): SecretReadResult => ({ _tag: "value", value });
export const readError = (error: SecretReadError): SecretReadResult => ({ _tag: "error", error });

/** The value of a read, or `undefined` for a reference that could not be read. */
export const valueOfRead = (result: SecretReadResult | undefined): string | undefined =>
  result?._tag === "value" ? result.value : undefined;

export interface SecretProviderDriver {
  readonly kind: SecretProviderKind;
  readonly definition: SecretProviderDefinition;
  /**
   * Outcomes in input order. `config` has decoded with the definition's `configSchema` and every
   * reference passed its `isReference`.
   */
  readonly read: (
    config: unknown,
    references: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<SecretReadResult>, never, SecretProviderDriverServices>;
  readonly test: (
    config: unknown,
  ) => Effect.Effect<SecretProviderTestReport, never, SecretProviderDriverServices>;
}

export const defineSecretProviderDriver = <Config>(driver: {
  readonly kind: SecretProviderKind;
  readonly definition: SecretProviderDefinition<Config>;
  readonly read: (
    config: Config,
    references: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<SecretReadResult>, never, SecretProviderDriverServices>;
  readonly test: (
    config: Config,
  ) => Effect.Effect<SecretProviderTestReport, never, SecretProviderDriverServices>;
}): SecretProviderDriver => {
  const isConfig = Schema.is(driver.definition.configSchema);
  return {
    kind: driver.kind,
    definition: driver.definition,
    read: (config, references) =>
      isConfig(config)
        ? driver.read(config, references)
        : Effect.succeed(references.map(() => readError("invalid"))),
    test: (config) =>
      isConfig(config) ? driver.test(config) : Effect.succeed({ ok: false, error: "invalid" }),
  };
};
