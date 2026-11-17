import {
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  type UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  appendCredentialResponseHeaders,
  failEnvironmentInternal,
} from "../auth/http.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as MembershipService from "./MembershipService.ts";
import * as OrganizationLifecycle from "./OrganizationLifecycle.ts";
import * as SpaceDirectory from "./SpaceDirectory.ts";

const requireUser = Effect.gen(function* () {
  const principal = yield* EnvironmentAuthenticatedPrincipal;
  if (principal.userId === undefined) {
    return yield* new EnvironmentHttpForbiddenError({ message: "Sign in with an account first." });
  }
  return principal.userId;
});

const failStorage = (cause: unknown) => failEnvironmentInternal("spaces_failed", cause);

const lifecycleFailures = {
  OrganizationRefusedError: (error: OrganizationLifecycle.OrganizationRefusedError) =>
    Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
  OrganizationStorageError: failStorage,
};

const membershipFailures = {
  MembershipRefusedError: (error: MembershipService.MembershipRefusedError) =>
    Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
  MembershipStorageError: failStorage,
};

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "spaces",
  Effect.fnUntraced(function* (handlers) {
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    const memberships = yield* MembershipService.MembershipService;
    const lifecycle = yield* OrganizationLifecycle.OrganizationLifecycle;
    // Stopping and deleting Threads acts as the Owner who asked.
    const runLifecycle = Effect.fnUntraced(function* (
      change: (actor: UserId) => ReturnType<typeof lifecycle.archive>,
    ) {
      const actor = yield* requireUser;
      return yield* change(actor).pipe(
        CommandActor.actAs(actor),
        Effect.catchTags(lifecycleFailures),
      );
    });
    return handlers
      .handle(
        "list",
        Effect.fn("environment.spaces.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* spaces.view(yield* requireUser).pipe(Effect.catch(failStorage));
        }),
      )
      .handle(
        "createOrganization",
        Effect.fn("environment.spaces.createOrganization")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* spaces.createOrganization(yield* requireUser, args.payload.name).pipe(
            Effect.catchTags({
              SpaceAccessDeniedError: () =>
                Effect.fail(
                  new EnvironmentHttpForbiddenError({
                    message: "Your account can't create Organizations.",
                  }),
                ),
              OrganizationNameTakenError: (error) =>
                Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
              SpaceDirectoryStorageError: failStorage,
            }),
          );
        }),
      )
      .handle(
        "members",
        Effect.fn("environment.spaces.members")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* memberships
            .list(yield* requireUser, args.params.spaceId)
            .pipe(Effect.catchTags(membershipFailures));
        }),
      )
      .handle(
        "changeMemberRole",
        Effect.fn("environment.spaces.changeMemberRole")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* memberships
            .changeRole({
              actor: yield* requireUser,
              spaceId: args.params.spaceId,
              userId: args.payload.userId,
              role: args.payload.role,
            })
            .pipe(Effect.catchTags(membershipFailures));
        }),
      )
      .handle(
        "removeMember",
        Effect.fn("environment.spaces.removeMember")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* memberships
            .remove({
              actor: yield* requireUser,
              spaceId: args.params.spaceId,
              userId: args.payload.userId,
            })
            .pipe(Effect.catchTags(membershipFailures));
        }),
      )
      .handle(
        "issueMemberResetLink",
        Effect.fn("environment.spaces.issueMemberResetLink")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* appendCredentialResponseHeaders;
          return yield* memberships
            .issueResetLink({
              actor: yield* requireUser,
              spaceId: args.params.spaceId,
              userId: args.payload.userId,
            })
            .pipe(Effect.catchTags(membershipFailures));
        }),
      )
      .handle(
        "archiveOrganization",
        Effect.fn("environment.spaces.archiveOrganization")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* runLifecycle((actor) => lifecycle.archive(actor, args.params.spaceId));
        }),
      )
      .handle(
        "restoreOrganization",
        Effect.fn("environment.spaces.restoreOrganization")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* runLifecycle((actor) => lifecycle.restore(actor, args.params.spaceId));
        }),
      )
      .handle(
        "deleteOrganization",
        Effect.fn("environment.spaces.deleteOrganization")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* runLifecycle((actor) => lifecycle.delete(actor, args.params.spaceId));
        }),
      )
      .handle(
        "leave",
        Effect.fn("environment.spaces.leave")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* memberships
            .leave(yield* requireUser, args.params.spaceId)
            .pipe(Effect.catchTags(membershipFailures));
        }),
      );
  }),
);
