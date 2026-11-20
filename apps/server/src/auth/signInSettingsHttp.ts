/**
 * The Owner's sign-in settings over HTTP (Keycloak sign-in spec, ticket 01): read, change and
 * «Check». Anyone but the Owner gets the same 403, whatever their session's scopes; a session of
 * the Owner's also needs the access scope. No door answers the client secret.
 */
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AccessPolicy from "./AccessPolicy.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "./http.ts";
import * as KeycloakLogins from "./KeycloakLogins.ts";
import * as SignInSettings from "./SignInSettings.ts";

const OWNER_ONLY = "Only the Owner manages the sign-in settings.";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "signInSettings",
  Effect.fnUntraced(function* (handlers) {
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    const settings = yield* SignInSettings.SignInSettings;
    // Ticket 07: Keycloak's re-checks for the Owner's warnings; absent where a test serves no realm.
    const keycloakLogins = yield* Effect.serviceOption(KeycloakLogins.KeycloakLogins);
    const withStatus = <A extends object>(view: A) =>
      Option.isNone(keycloakLogins)
        ? Effect.succeed(view)
        : Effect.map(keycloakLogins.value.status, (keycloakStatus) => ({
            ...view,
            keycloakStatus,
          }));

    const forbidden = () => Effect.fail(new EnvironmentHttpForbiddenError({ message: OWNER_ONLY }));
    const failStorage = (error: SignInSettings.SignInSettingsStorageError) =>
      failEnvironmentInternal("sign_in_settings_failed", error);

    /**
     * The Owner, asked before the scope: a User who is not the Owner learns nothing from which of
     * their scopes is missing.
     */
    const requireOwner = Effect.fn("environment.signInSettings.requireOwner")(function* (
      scope: AuthEnvironmentScope,
    ) {
      const session = yield* EnvironmentAuthenticatedPrincipal;
      if (session.userId === undefined) return yield* forbidden();
      const principal = yield* spaces
        .principalOf(session.userId)
        .pipe(Effect.catch((cause) => failEnvironmentInternal("sign_in_settings_failed", cause)));
      const decision = AccessPolicy.decide(
        principal,
        "signInSettings.manage",
        AccessPolicy.installation,
      );
      if (!AccessPolicy.isAllowed(decision)) return yield* forbidden();
      yield* requireEnvironmentScope(scope);
      return session.userId;
    });

    return handlers
      .handle(
        "get",
        Effect.fn("environment.signInSettings.get")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const owner = yield* requireOwner(AuthAccessReadScope);
          return yield* settings.read(owner).pipe(
            Effect.catchTags({
              SignInSettingsDeniedError: forbidden,
              SignInSettingsStorageError: failStorage,
            }),
            Effect.flatMap(withStatus),
          );
        }),
      )
      .handle(
        "update",
        Effect.fn("environment.signInSettings.update")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const owner = yield* requireOwner(AuthAccessWriteScope);
          return yield* settings.update(owner, args.payload).pipe(
            Effect.catchTags({
              SignInSettingsDeniedError: forbidden,
              SignInSettingsInvalidError: (error) =>
                Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
              SignInSettingsStorageError: failStorage,
              SignInSecretNotStoredError: (error) =>
                failEnvironmentInternal("sign_in_secret_not_stored", error),
              // Ticket 06: the change would end sign-ins; the Owner confirms how many first.
              SignInSettingsConfirmError: (error) =>
                Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
            }),
            Effect.flatMap(withStatus),
          );
        }),
      )
      .handle(
        "check",
        Effect.fn("environment.signInSettings.check")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const owner = yield* requireOwner(AuthAccessWriteScope);
          return yield* settings.check(owner).pipe(
            Effect.catchTags({
              SignInSettingsDeniedError: forbidden,
              SignInSettingsStorageError: failStorage,
            }),
          );
        }),
      );
  }),
);
