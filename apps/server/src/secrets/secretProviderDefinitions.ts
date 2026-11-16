import { builtInSecretProviderDefinitions } from "@t3tools/secret-provider-definitions/registry";
import type { SecretProviderDefinition } from "@t3tools/secret-provider-core/shared/definition";
import * as OnePasswordDriver from "@t3tools/secret-provider-onepassword/server/driver";

/** In the shared registry's order. */
export const BUILT_IN_SECRET_PROVIDER_DRIVER_LIST = [OnePasswordDriver.driver] as const;

export const secretProviderDefinitions = builtInSecretProviderDefinitions;

// A kind only tests register: credential fields are exercised before a built-in driver has any.
const registeredForTests = new Map<string, SecretProviderDefinition>();

/** The definition the server checks and seals a provider of this kind with. */
export const secretProviderDefinitionFor = (kind: string): SecretProviderDefinition | undefined =>
  secretProviderDefinitions.find(kind) ?? registeredForTests.get(kind);

/** Tests only: a kind with credential fields (no built-in driver has one before OpenBao). */
export const registerSecretProviderDefinitionForTests = (definition: SecretProviderDefinition) => {
  registeredForTests.set(definition.kind, definition);
};
