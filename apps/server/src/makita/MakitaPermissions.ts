/**
 * «May use Makita» (Makita ticket 02): the Owner gives it per User and Space, to an Admin or
 * Member of an Organization or to a User in their own Personal space, and takes it back. A row
 * takes effect only while its User is still there (AccessPolicy `makita.use`). The only writer of
 * `makita_permissions`; removals call `forgetUserWithin` inside their own transaction.
 */
import {
  type MakitaPermission,
  type MakitaPermissionCandidate,
  type MakitaPermissionInput,
  type MakitaPermissionState,
  type MakitaPermissionsListResult,
  MakitaError,
  type MakitaSpaceRole,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { forgetIdentityWithin } from "./GitHubIdentities.ts";
import { pauseCreatorConfigsWithin } from "./makitaRows.ts";

const NOT_YOURS =
  "Makita is set up by a person in Platform settings or Space settings, not by an agent.";
const OWNER_ONLY = "Only the Owner decides who may use Makita.";

/**
 * A User removed from the Hub (inside `InstallationUserService`'s transaction): every row of
 * theirs goes, each audited (`user-removed`), and their configurations pause (`creator-left`).
 */
export const forgetUserWithin = Effect.fn("MakitaPermissions.forgetUserWithin")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  userId: UserId,
) {
  const gone = yield* sql<{ readonly spaceId: string }>`
    DELETE FROM makita_permissions WHERE user_id = ${userId} RETURNING space_id AS "spaceId"
  `;
  const write = AuditLog.write(sql);
  for (const row of gone) {
    yield* write({
      actor,
      action: "makita.permission.revoke",
      spaceId: SpaceId.make(row.spaceId),
      target: { kind: "user", id: userId },
      detail: { space: row.spaceId, reason: "user-removed" },
    });
  }
  yield* pauseCreatorConfigsWithin(sql, {
    actor,
    pausedBy: actor.source === "user" ? actor.userId : null,
    creator: userId,
    spaceId: null,
    reason: "creator-left",
  });
  // Ticket 08: their linked GitHub account goes with them.
  yield* forgetIdentityWithin(sql, actor, userId);
});

export class MakitaPermissions extends Context.Service<
  MakitaPermissions,
  {
    readonly list: (input: {
      readonly actorUserId: UserId;
    }) => Effect.Effect<MakitaPermissionsListResult, MakitaError>;
    readonly grant: (
      input: MakitaPermissionInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaPermissionsListResult, MakitaError>;
    readonly revoke: (
      input: MakitaPermissionInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaPermissionsListResult, MakitaError>;
    /** The same, for a person's own WS session only (never an agent, the shell or one Space). */
    readonly listForSession: Effect.Effect<MakitaPermissionsListResult, MakitaError>;
    readonly grantForSession: (
      input: MakitaPermissionInput,
    ) => Effect.Effect<MakitaPermissionsListResult, MakitaError>;
    readonly revokeForSession: (
      input: MakitaPermissionInput,
    ) => Effect.Effect<MakitaPermissionsListResult, MakitaError>;
  }
>()("t3/makita/MakitaPermissions") {}

const fail = (reason: MakitaError["reason"], message: string) =>
  Effect.fail(new MakitaError({ reason, message }));

interface PermissionRow {
  readonly userId: string;
  readonly userName: string | null;
  readonly inactive: number | null;
  readonly spaceId: string;
  readonly spaceName: string | null;
  readonly spaceKind: "organization" | "personal" | null;
  readonly archived: number | null;
  readonly frozen: number | null;
  readonly deleting: number | null;
  readonly personalOwner: string | null;
  readonly role: "admin" | "member" | "guest" | null;
  readonly grantedBy: string;
  readonly grantedByName: string | null;
  readonly grantedAt: string;
}

const roleOf = (row: PermissionRow): MakitaSpaceRole | null =>
  row.spaceKind === "personal" ? (row.personalOwner === row.userId ? "personal" : null) : row.role;

const stateOf = (row: PermissionRow): MakitaPermissionState => {
  if (row.spaceKind === null || row.deleting === 1) return "space-gone";
  if (row.inactive !== 0) return "user-inactive";
  const role = roleOf(row);
  if (role === null) return "not-a-member";
  if (role === "guest") return "guest";
  if (row.archived === 1) return "space-archived";
  if (row.frozen === 1) return "space-frozen";
  return "ok";
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`MakitaPermissions: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );

  const ownerOnly = Effect.fn("MakitaPermissions.ownerOnly")(function* (actorUserId: UserId) {
    const principal = yield* spaces
      .principalOf(actorUserId)
      .pipe(Effect.catch(storage("read who you are")));
    const decision = AccessPolicy.decide(
      principal,
      "makita.manageAccount",
      AccessPolicy.installation,
    );
    if (decision._tag === "Deny") return yield* fail("forbidden", OWNER_ONLY);
  });

  const readPermissions = sql<PermissionRow>`
    SELECT p.user_id AS "userId", u.display_name AS "userName",
      CASE WHEN u.user_id IS NULL THEN 1
        ELSE (u.disabled_at IS NOT NULL OR u.removed_at IS NOT NULL) END AS inactive,
      p.space_id AS "spaceId", s.name AS "spaceName", s.kind AS "spaceKind",
      s.archived_at IS NOT NULL AS archived, s.frozen_at IS NOT NULL AS frozen,
      s.deleting_at IS NOT NULL AS deleting, s.personal_owner_user_id AS "personalOwner",
      m.role, p.granted_by AS "grantedBy", g.display_name AS "grantedByName",
      p.granted_at AS "grantedAt"
    FROM makita_permissions p
    LEFT JOIN users u ON u.user_id = p.user_id
    LEFT JOIN spaces s ON s.space_id = p.space_id
    LEFT JOIN space_memberships m ON m.space_id = p.space_id AND m.user_id = p.user_id
    LEFT JOIN users g ON g.user_id = p.granted_by
    ORDER BY s.name, u.display_name, p.user_id
  `;

  /** Every active User but the Owner, with the open Spaces where they may receive it. */
  const readCandidates = Effect.gen(function* () {
    const users = yield* sql<{ readonly userId: string; readonly name: string }>`
      SELECT user_id AS "userId", display_name AS name FROM users
      WHERE is_owner = 0 AND disabled_at IS NULL AND removed_at IS NULL
      ORDER BY display_name, user_id
    `;
    const organizations = yield* sql<{
      readonly userId: string;
      readonly spaceId: string;
      readonly name: string;
      readonly role: "admin" | "member";
    }>`
      SELECT m.user_id AS "userId", m.space_id AS "spaceId", s.name, m.role
      FROM space_memberships m JOIN spaces s ON s.space_id = m.space_id
      WHERE s.kind = 'organization' AND s.archived_at IS NULL AND s.frozen_at IS NULL
        AND s.deleting_at IS NULL AND m.role IN ('admin', 'member')
      ORDER BY s.name
    `;
    const personal = yield* sql<{
      readonly userId: string;
      readonly spaceId: string;
      readonly name: string;
    }>`
      SELECT personal_owner_user_id AS "userId", space_id AS "spaceId", name FROM spaces
      WHERE kind = 'personal' AND archived_at IS NULL AND frozen_at IS NULL
        AND deleting_at IS NULL
    `;
    const granted = new Set(
      (yield* sql<{ readonly key: string }>`
        SELECT user_id || ' ' || space_id AS key FROM makita_permissions
      `).map((row) => row.key),
    );
    return users.flatMap((user): ReadonlyArray<MakitaPermissionCandidate> => {
      const open = [
        ...personal
          .filter((space) => space.userId === user.userId)
          .map((space) => ({
            spaceId: SpaceId.make(space.spaceId),
            name: space.name,
            kind: "personal" as const,
            role: "personal" as const,
          })),
        ...organizations
          .filter((space) => space.userId === user.userId)
          .map((space) => ({
            spaceId: SpaceId.make(space.spaceId),
            name: space.name,
            kind: "organization" as const,
            role: space.role,
          })),
      ].filter((space) => !granted.has(`${user.userId} ${space.spaceId}`));
      return open.length === 0
        ? []
        : [{ userId: UserId.make(user.userId), name: user.name, spaces: open }];
    });
  });

  const answer = Effect.gen(function* () {
    const rows = yield* readPermissions;
    const permissions = rows.map((row): MakitaPermission => ({
      userId: UserId.make(row.userId),
      userName: row.userName,
      spaceId: SpaceId.make(row.spaceId),
      spaceName: row.spaceName,
      spaceKind: row.spaceKind,
      role: roleOf(row),
      grantedBy: UserId.make(row.grantedBy),
      grantedByName: row.grantedByName,
      grantedAt: row.grantedAt,
      state: stateOf(row),
    }));
    return {
      permissions,
      candidates: yield* readCandidates,
    } satisfies MakitaPermissionsListResult;
  }).pipe(Effect.catch(storage("read who may use Makita")));

  const list = Effect.fn("MakitaPermissions.list")(function* (input: {
    readonly actorUserId: UserId;
  }) {
    yield* ownerOnly(input.actorUserId);
    return yield* answer;
  });

  /**
   * Gives it: the target and the Space are read in the write transaction (a Role changed or a
   * Space archived commits before, and is refused here, or after).
   */
  const grant = Effect.fn("MakitaPermissions.grant")(function* (
    input: MakitaPermissionInput & { readonly actorUserId: UserId },
  ) {
    yield* ownerOnly(input.actorUserId);
    const at = DateTime.formatIso(yield* DateTime.now);
    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const users = yield* sql<{
            readonly name: string;
            readonly isOwner: number;
            readonly active: number;
          }>`
            SELECT display_name AS name, is_owner AS "isOwner",
              disabled_at IS NULL AND removed_at IS NULL AS active
            FROM users WHERE user_id = ${input.userId}
          `;
          const user = users[0];
          if (user === undefined) return { _tag: "refused", message: "No such User." } as const;
          if (user.isOwner === 1) {
            return { _tag: "refused", message: "The Owner may use Makita everywhere." } as const;
          }
          if (user.active !== 1) {
            return {
              _tag: "refused",
              message: "This User is disabled or removed: they cannot use Makita.",
            } as const;
          }
          const space = (yield* spaces.spacesById([input.spaceId])).get(input.spaceId);
          if (space === undefined) return { _tag: "refused", message: "No such Space." } as const;
          if (space.resource.archived || space.resource.frozen) {
            return {
              _tag: "refused",
              message: "This Space is archived: nothing new is given in it.",
            } as const;
          }
          let role: MakitaSpaceRole;
          if (space.resource.kind === "personal") {
            if (space.resource.personalOwnerUserId !== input.userId) {
              return {
                _tag: "refused",
                message: "In a Personal space, only its own User may use Makita.",
              } as const;
            }
            role = "personal";
          } else {
            const memberships = yield* sql<{ readonly role: "admin" | "member" | "guest" }>`
              SELECT role FROM space_memberships
              WHERE space_id = ${input.spaceId} AND user_id = ${input.userId}
            `;
            const membership = memberships[0];
            if (membership === undefined) {
              return {
                _tag: "refused",
                message: "This User is not in this Organization.",
              } as const;
            }
            if (membership.role === "guest") {
              return {
                _tag: "refused",
                message: "Guests cannot use Makita: make them a Member first.",
              } as const;
            }
            role = membership.role;
          }
          const inserted = yield* sql<{ readonly userId: string }>`
            INSERT INTO makita_permissions (user_id, space_id, granted_by, granted_at)
            VALUES (${input.userId}, ${input.spaceId}, ${input.actorUserId}, ${at})
            ON CONFLICT (user_id, space_id) DO NOTHING
            RETURNING user_id AS "userId"
          `;
          if (inserted.length === 0) return { _tag: "unchanged" } as const;
          yield* audit.record({
            actor: AuditLog.userActor(input.actorUserId),
            action: "makita.permission.grant",
            spaceId: input.spaceId,
            target: { kind: "user", id: input.userId, name: user.name },
            detail: { space: input.spaceId, role },
          });
          return { _tag: "granted" } as const;
        }),
      )
      .pipe(Effect.catch(storage("give the permission")));
    if (outcome._tag === "refused") return yield* fail("invalid", outcome.message);
    return yield* answer;
  });

  /** Takes it back; idempotent, audited when a row goes. */
  const revoke = Effect.fn("MakitaPermissions.revoke")(function* (
    input: MakitaPermissionInput & { readonly actorUserId: UserId },
  ) {
    yield* ownerOnly(input.actorUserId);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const gone = yield* sql<{ readonly userId: string }>`
            DELETE FROM makita_permissions
            WHERE user_id = ${input.userId} AND space_id = ${input.spaceId}
            RETURNING user_id AS "userId"
          `;
          if (gone.length === 0) return;
          const names = yield* sql<{ readonly name: string }>`
            SELECT display_name AS name FROM users WHERE user_id = ${input.userId}
          `;
          yield* audit.record({
            actor: AuditLog.userActor(input.actorUserId),
            action: "makita.permission.revoke",
            spaceId: input.spaceId,
            target: {
              kind: "user",
              id: input.userId,
              ...(names[0] === undefined ? {} : { name: names[0].name }),
            },
            detail: { space: input.spaceId, reason: "revoked" },
          });
          // Their configurations of this Space stop with it (Makita ticket 03).
          yield* pauseCreatorConfigsWithin(sql, {
            actor: AuditLog.userActor(input.actorUserId),
            pausedBy: input.actorUserId,
            creator: input.userId,
            spaceId: input.spaceId,
            reason: "permission-revoked",
          });
        }),
      )
      .pipe(Effect.catch(storage("take the permission back")));
    return yield* answer;
  });

  /** The person behind a WS session: never an agent, the Hub's shell or a one-Space session. */
  const sessionUser = Effect.gen(function* () {
    const actor = yield* CommandActor.resolve;
    if (actor._tag !== "User" || actor.via !== undefined || actor.spaceLimit !== undefined) {
      return yield* fail("forbidden", NOT_YOURS);
    }
    return actor.userId;
  });

  return MakitaPermissions.of({
    list,
    grant,
    revoke,
    listForSession: Effect.gen(function* () {
      return yield* list({ actorUserId: yield* sessionUser });
    }),
    grantForSession: Effect.fn("MakitaPermissions.grantAsSession")(function* (
      input: MakitaPermissionInput,
    ) {
      return yield* grant({ ...input, actorUserId: yield* sessionUser });
    }),
    revokeForSession: Effect.fn("MakitaPermissions.revokeAsSession")(function* (
      input: MakitaPermissionInput,
    ) {
      return yield* revoke({ ...input, actorUserId: yield* sessionUser });
    }),
  });
});

export const layer = Layer.effect(MakitaPermissions, make);
