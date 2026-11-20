/**
 * Keycloak groups to Memberships (ticket 05), as every Keycloak path applies them: the callback at
 * each sign-in and the re-check at each refresh (ticket 07), with the same plan (`planGroupSync`)
 * and the same writes (`MembershipService.applyGroupSync`, in the caller's transaction). Making
 * someone an Admin there ends their weak Keycloak sign-ins (`onPromotedToAdmin`), whichever path.
 */
import type { UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as MembershipService from "../spaces/MembershipService.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as GroupSync from "./GroupSync.ts";
import type * as KeycloakClient from "./KeycloakClient.ts";
import * as SignInSettings from "./SignInSettings.ts";

/** A read or write of the group sync failed; `step` says which, never a value. */
export class KeycloakGroupsError extends Schema.TaggedError<KeycloakGroupsError>()(
  "KeycloakGroupsError",
  { step: Schema.String, cause: Schema.Defect() },
) {}

export class KeycloakGroups extends Context.Service<
  KeycloakGroups,
  {
    /**
     * What the token's groups change for a User, read inside the caller's transaction.
     * `undefined` is a new identity, with no Memberships yet. The Owner belongs to no
     * Organization, so no group puts them in one.
     */
    readonly plan: (
      user: { readonly id: UserId; readonly isOwner: boolean } | undefined,
      claims: KeycloakClient.IdTokenClaims,
      groupsClaim: string,
    ) => Effect.Effect<ReadonlyArray<GroupSync.GroupChange>, KeycloakGroupsError>;
    /** Applies a plan in the caller's transaction; `afterCommit` once it commits. */
    readonly apply: (
      userId: UserId,
      changes: ReadonlyArray<GroupSync.GroupChange>,
    ) => Effect.Effect<{ readonly afterCommit: Effect.Effect<void> }, KeycloakGroupsError>;
  }
>()("t3/auth/KeycloakGroups") {}

const make = Effect.gen(function* () {
  const settings = yield* SignInSettings.SignInSettings;
  const spaceDirectory = yield* SpaceDirectory.SpaceDirectory;
  const memberships = yield* MembershipService.MembershipService;

  const failed = (step: string) => (cause: unknown) => new KeycloakGroupsError({ step, cause });

  const plan: KeycloakGroups["Service"]["plan"] = Effect.fn("KeycloakGroups.plan")(
    function* (user, claims, groupsClaim) {
      if (user?.isOwner === true) return [];
      const mappings = yield* settings.groupMappings.pipe(Effect.mapError(failed("mappings")));
      const current =
        user === undefined
          ? []
          : yield* spaceDirectory
              .groupMembershipsOf(user.id)
              .pipe(Effect.mapError(failed("group memberships")));
      return GroupSync.planGroupSync({
        memberships: current,
        // Only the groups some mapping names: a long list never pushes a mapped one out.
        groups: GroupSync.groupsOf(
          claims,
          groupsClaim,
          new Set(mappings.map((mapping) => mapping.group)),
        ),
        mappings,
      });
    },
  );

  const apply: KeycloakGroups["Service"]["apply"] = (userId, changes) =>
    changes.length === 0
      ? Effect.succeed({ afterCommit: Effect.void })
      : memberships
          .applyGroupSync({ userId, changes })
          .pipe(Effect.mapError(failed("apply groups")));

  return KeycloakGroups.of({ plan, apply });
});

export const layer = Layer.effect(KeycloakGroups, make);
