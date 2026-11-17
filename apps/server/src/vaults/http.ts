/**
 * The master key over HTTP: its status, download and saved-confirmation, the Owner alone
 * (`masterKey.backup`); the download needs a strong factor. No door answers a Secret's value
 * (owned-resources 01). See docs/internals/secrets.md.
 */
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  type EnvironmentInternalError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import {
  annotateEnvironmentRequest,
  failAccountChange,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as MasterKeyBackup from "../auth/MasterKeyBackup.ts";
import type * as MasterKeyFile from "../auth/MasterKeyFile.ts";
import * as UserDirectory from "../auth/UserDirectory.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";

const OWNER_ONLY = "Only the Owner backs up the master key.";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "vaults",
  Effect.fnUntraced(function* (handlers) {
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    const users = yield* UserDirectory.UserDirectory;
    const backup = yield* MasterKeyBackup.MasterKeyBackup;

    const failKey = (error: MasterKeyFile.MasterKeyError) =>
      failEnvironmentInternal("master_key_failed", error);
    /** A wrong proof is the Owner's to correct; anything else is the Hub's. */
    const failConfirm = (
      error: MasterKeyFile.MasterKeyError,
    ): Effect.Effect<never, EnvironmentHttpConflictError | EnvironmentInternalError> =>
      error.reason === "proof"
        ? Effect.fail(new EnvironmentHttpConflictError({ message: error.message }))
        : failKey(error);

    /** A signed-in User whom AccessPolicy lets back up the master key: the Owner. */
    const requireOwner = Effect.fn("environment.vaults.requireOwner")(function* (
      scope: AuthEnvironmentScope,
    ) {
      const principal = yield* requireEnvironmentScope(scope);
      if (principal.userId === undefined) {
        return yield* new EnvironmentHttpForbiddenError({ message: OWNER_ONLY });
      }
      const policy = yield* spaces
        .principalOf(principal.userId)
        .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
      const decision = AccessPolicy.decide(policy, "masterKey.backup", AccessPolicy.installation);
      if (!AccessPolicy.isAllowed(decision)) {
        return yield* new EnvironmentHttpForbiddenError({ message: OWNER_ONLY });
      }
      return { userId: principal.userId, sessionId: principal.sessionId };
    });

    return handlers
      .handle(
        "masterKeyStatus",
        Effect.fn("environment.vaults.masterKeyStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireOwner(AuthAccessReadScope);
          return yield* backup.status.pipe(Effect.catch(failKey));
        }),
      )
      .handle(
        "masterKeyBackup",
        Effect.fn("environment.vaults.masterKeyBackup")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // Who may comes before the factor, so no one else's proof is ever checked.
          const owner = yield* requireOwner(AuthAccessWriteScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          yield* failAccountChange(
            users.confirmStrongFactor(
              { ...owner, origin: request.headers.origin ?? "" },
              args.payload.reauth,
            ),
          );
          const exported = yield* backup
            .export({ actor: AuditLog.userActor(owner.userId), via: "settings" })
            .pipe(Effect.catch(failKey));
          return { key: Redacted.value(exported.key), keyId: exported.keyId };
        }),
      )
      .handle(
        "masterKeyBackupConfirm",
        Effect.fn("environment.vaults.masterKeyBackupConfirm")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireOwner(AuthAccessWriteScope);
          return yield* backup
            .confirm({
              keyId: args.payload.keyId,
              proof: Redacted.make(args.payload.proof),
              at: DateTime.formatIso(yield* DateTime.now),
            })
            .pipe(Effect.catch(failConfirm));
        }),
      );
  }),
);
