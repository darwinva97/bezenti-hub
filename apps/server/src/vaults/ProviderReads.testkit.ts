/**
 * A fake Secret provider for Hub tests (Vaults ticket 02): a driver of kind `fake` and the Owner's
 * settings naming it «OpenBao» (`vault`). Each test sets what it answers and reads what it was asked.
 */
import { SecretProviderId, SecretProviderKind, type ServerSettings } from "@t3tools/contracts";
import {
  defineSecretProviderDriver,
  readValue,
  type SecretReadResult,
} from "@t3tools/secret-provider-core/server/driver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as ProviderReads from "./ProviderReads.ts";

const FAKE_PROVIDER_KIND = SecretProviderKind.make("fake");
export const FAKE_PROVIDER_ID = SecretProviderId.make("vault");
export const FAKE_PROVIDER_LABEL = "OpenBao";

export const makeFakeSecretProvider = () => {
  const state = {
    /** What each reference answers; by default its own text, prefixed. */
    answer: (reference: string): SecretReadResult => readValue(`value-of:${reference}`),
    /** Waited on before answering (a provider that hangs, or dies). */
    gate: Effect.void as Effect.Effect<void>,
    providers: {
      [FAKE_PROVIDER_ID]: { kind: FAKE_PROVIDER_KIND, label: FAKE_PROVIDER_LABEL, config: {} },
    } as ServerSettings["secretProviders"],
    batches: [] as Array<ReadonlyArray<string>>,
  };
  const driver = defineSecretProviderDriver({
    kind: FAKE_PROVIDER_KIND,
    definition: defineSecretProvider({
      kind: FAKE_PROVIDER_KIND,
      label: "Fake",
      configSchema: Schema.Struct({}),
      isReference: (reference) => reference.startsWith("kv/"),
      referencePlaceholder: "kv/path#key",
      invalidReferenceMessage: "Use kv/path#key.",
    }),
    read: (_config, references) =>
      Effect.sync(() => state.batches.push(references)).pipe(
        Effect.andThen(Effect.suspend(() => state.gate)),
        Effect.andThen(Effect.sync(() => references.map((reference) => state.answer(reference)))),
      ),
    test: () => Effect.succeed({ ok: true }),
  });
  const options: Parameters<typeof ProviderReads.make>[0] = {
    drivers: [driver],
    secretProviders: Effect.sync(() => state.providers),
  };
  return { state, driver, options };
};

export type FakeSecretProvider = ReturnType<typeof makeFakeSecretProvider>;
