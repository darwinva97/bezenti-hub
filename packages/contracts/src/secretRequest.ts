import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import { VaultGroupId } from "./vaults.ts";

/**
 * «Also save to Vault» (spec 5 ticket 06): the answer is also kept as a Vault entry under `name`.
 * Only a Vault of `secrets.vaultTargets` for the Thread is accepted; the Hub decides, never this.
 */
export const SecretRequestSaveToVault = Schema.Struct({
  vaultId: VaultGroupId,
  name: Schema.String.check(Schema.isMaxLength(128)),
});
export type SecretRequestSaveToVault = typeof SecretRequestSaveToVault.Type;

/** Server stores the value under a one-use SecretRef; the thread learns only status. */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("save"),
      secret: TrimmedNonEmptyString,
      saveToVault: Schema.optionalKey(SecretRequestSaveToVault),
    }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

/**
 * `secrets.vaultTargets`: the Vault groups an answer to this Thread's card may also be saved in,
 * each with whose Vault it is part of (owned-resources 03; optional for older Hubs).
 */
export const SecretRequestVaultTargetsInput = Schema.Struct({ threadId: ThreadId });
export type SecretRequestVaultTargetsInput = typeof SecretRequestVaultTargetsInput.Type;
export const SecretRequestVaultTargets = Schema.Struct({
  vaults: Schema.Array(
    Schema.Struct({
      id: VaultGroupId,
      name: Schema.String,
      ownerName: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});
export type SecretRequestVaultTargets = typeof SecretRequestVaultTargets.Type;

/** What the agent reads when its card ends without a secret. */
export const SECRET_REQUEST_UNSAVED_NOTE = {
  declined:
    "The user declined. Don't ask for it in chat or another way; say what's blocked and go on without it.",
  cancelled:
    "The card closed with the run. Ask again with a new clientRequestId only if the secret is still needed.",
  timed_out:
    "No answer in time. Don't ask in chat; ask again with a new clientRequestId only if it is still needed.",
} as const;

const SECRET_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the secret request.",
  not_found: "This secret request no longer exists.",
  already_answered: "This secret request was already answered.",
  agent_stopped: "The agent that asked has stopped, so this secret can't be used.",
  not_permitted: "Only the person who started this Thread can answer its requests.",
  store_failed: "Could not store the secret.",
  record_failed: "Saved the secret, but could not update the request.",
  invalid_ref: "That secretRef is not valid.",
  read_failed: "Could not read the secret.",
  ref_unavailable:
    "That secretRef was already used or does not exist. Ask the user again with request_secret.",
  ref_expired: "That secretRef expired. Ask the user again with request_secret.",
  consume_failed: "Could not use that secretRef. Try again.",
  file_delivery_unavailable:
    'This Hub keeps no secret on its disk and has no folder in memory to hand this one over as a file. Ask again with request_secret and delivery: "secretRef".',
  not_a_file_request:
    'The user did not save this secret for shell use. Ask again with request_secret and delivery: "file".',
  vault_not_permitted: "You can't save secrets in that Vault from this Thread.",
  vault_name_invalid:
    "That name can't be saved here: use A-Z, 0-9 and _, and not a name the Hub reserves or only the Owner sets in Settings → Vaults.",
  vault_name_taken: "That Vault already has a secret with this name.",
  vault_value_short:
    "Values shorter than 6 characters are never hidden in the history: add this one in Settings → Vaults.",
  vault_save_failed: "Could not save the secret in the Vault.",
} as const;

export const SecretRequestFailureReason = Schema.Literals(
  Object.keys(SECRET_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof SECRET_REQUEST_FAILURE_MESSAGES
  >,
);
export type SecretRequestFailureReason = typeof SecretRequestFailureReason.Type;

export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  {
    reason: SecretRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return SECRET_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
