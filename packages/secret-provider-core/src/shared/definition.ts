import type { SecretProviderKind } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

/** What clients and the server both need to know about one kind of secret provider. */
export interface SecretProviderDefinition<Config = unknown> {
  readonly kind: SecretProviderKind;
  readonly label: string;
  readonly configSchema: Schema.Codec<Config, unknown>;
  /** Whether `reference` is syntax this kind can read. */
  readonly isReference: (reference: string) => boolean;
  readonly referencePlaceholder: string;
  readonly invalidReferenceMessage: string;
  /**
   * Config fields holding a credential (`SettingsSecretValue`: a literal or a reference to another
   * provider). The server seals a literal in its store and never sends it to a client.
   */
  readonly credentialFields?: ReadonlyArray<string>;
}

export const defineSecretProvider = <Config>(
  definition: SecretProviderDefinition<Config>,
): SecretProviderDefinition<Config> => definition;

export interface SecretProviderDefinitionRegistry {
  readonly definitions: ReadonlyArray<SecretProviderDefinition>;
  readonly find: (kind: string) => SecretProviderDefinition | undefined;
}

export function makeSecretProviderDefinitionRegistry(
  definitions: ReadonlyArray<SecretProviderDefinition>,
): SecretProviderDefinitionRegistry {
  const byKind = new Map<string, SecretProviderDefinition>();
  for (const definition of definitions) {
    if (byKind.has(definition.kind)) {
      throw new Error(`Secret provider '${definition.kind}' is defined more than once.`);
    }
    byKind.set(definition.kind, definition);
  }
  return { definitions, find: (kind) => byKind.get(kind) };
}
