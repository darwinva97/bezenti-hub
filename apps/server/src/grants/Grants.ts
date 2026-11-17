/**
 * Grants: an owner lends one resource to a Space with limits, the Space decides, and either side
 * ends it. One row per loan (`grants`, migration 135), kept as history. Each change is a row of
 * `TRANSITIONS`, decided by AccessPolicy `grant.*` and audited in its transaction. Personal
 * machines and AI accounts (for the gateway) are lent today. See docs/internals/grants.md.
 */
import {
  type Grant,
  type GrantEndReason,
  GrantError,
  type GrantErrorReason,
  type GrantGiveInput,
  GrantId,
  type GrantLimits,
  GrantLimits as GrantLimitsSchema,
  type GrantList,
  type GrantListReceivedInput,
  type GrantRefInput,
  type GrantResourceKind,
  type GrantSetLimitsInput,
  type GrantState,
  type GrantTargets,
  type GrantTargetsInput,
  type AiAccountProvider,
  type AiAccountType,
  EnvironmentId,
  SandboxHostReport,
  SpaceId,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as EnvironmentRegistry from "../environments/EnvironmentRegistry.ts";
import { invalidLimitsReason } from "../sandboxes/sandboxLimits.ts";
import { LentSandboxDisk } from "../sandboxes/sandboxSpace.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";

/** What a change does to a Grant. */
export type GrantOp = "accept" | "reject" | "cancel" | "end" | "setLimits";

/** The state each change starts from and leads to; every other change is refused. */
const TRANSITIONS: Readonly<
  Record<GrantOp, { readonly from: ReadonlyArray<GrantState>; readonly to: GrantState | null }>
> = {
  accept: { from: ["pending"], to: "active" },
  reject: { from: ["pending"], to: "rejected" },
  cancel: { from: ["offered", "pending"], to: "cancelled" },
  end: { from: ["active"], to: "ended" },
  // The state stays.
  setLimits: { from: ["pending", "active"], to: null },
};

/** Whether `op` may run on a Grant in `state`. */
export const mayTransition = (op: GrantOp, state: GrantState) =>
  TRANSITIONS[op].from.includes(state);

/** Making a machine Grant active needs a strong factor: it opens the lender's machine. */
export interface FactorProof {
  readonly strongFactor: boolean;
}

export class Grants extends Context.Service<
  Grants,
  {
    readonly listGiven: Effect.Effect<GrantList, GrantError>;
    readonly listReceived: (input: GrantListReceivedInput) => Effect.Effect<GrantList, GrantError>;
    readonly targets: (input: GrantTargetsInput) => Effect.Effect<GrantTargets, GrantError>;
    /**
     * Refuses as `give` would and says whether it would start active (and so needs a strong
     * factor), before the door asks for one.
     */
    readonly prepareGive: (
      input: GrantGiveInput,
    ) => Effect.Effect<{ readonly needsStrongFactor: boolean }, GrantError>;
    readonly give: (input: GrantGiveInput, proof: FactorProof) => Effect.Effect<Grant, GrantError>;
    /** As `prepareGive`, for accepting. */
    readonly prepareAccept: (
      input: GrantRefInput,
    ) => Effect.Effect<{ readonly needsStrongFactor: boolean }, GrantError>;
    readonly accept: (input: GrantRefInput, proof: FactorProof) => Effect.Effect<Grant, GrantError>;
    readonly reject: (input: GrantRefInput) => Effect.Effect<Grant, GrantError>;
    readonly cancel: (input: GrantRefInput) => Effect.Effect<Grant, GrantError>;
    /** Revoked by the lender, or returned by the destination: whichever side the caller is. */
    readonly end: (input: GrantRefInput) => Effect.Effect<Grant, GrantError>;
    readonly setLimits: (input: GrantSetLimitsInput) => Effect.Effect<Grant, GrantError>;
  }
>()("t3/grants/Grants") {}

interface GrantRow {
  readonly grantId: string;
  readonly resourceKind: GrantResourceKind;
  readonly resourceId: string;
  readonly lenderKind: "user" | "organization";
  readonly lenderId: string;
  readonly targetKind: "space" | "plan";
  readonly targetId: string | null;
  readonly state: GrantState;
  readonly endReason: GrantEndReason | null;
  readonly limitsJson: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly endedAt: string | null;
  readonly resourceName: string | null;
  readonly lenderName: string | null;
  /** A machine's: what it last said of hosting Sandboxes. */
  readonly hostJson: string | null;
  /** An active machine Grant's Sandbox on the Hub, and what its host last said of it. */
  readonly lentEnvironmentId: string | null;
  readonly lentDiskJson: string | null;
  /** A lent AI account's provider and type. */
  readonly aiProvider: AiAccountProvider | null;
  readonly aiType: AiAccountType | null;
}

/** What is lent, as read when lending it: its owner is the lender. */
interface Lendable {
  readonly kind: GrantResourceKind;
  readonly resourceId: string;
  readonly name: string;
  readonly lenderKind: "user" | "organization";
  readonly lenderId: string;
  readonly lender: AccessPolicy.GrantLender;
}

const fail = (reason: GrantErrorReason, message: string) =>
  Effect.fail(new GrantError({ reason, message }));

const NOT_FOUND = "That loan does not exist.";
/** A Personal space's owner name, when known; nothing for an Organization. */
const ownerNameOf = (owners: ReadonlyMap<string, string>, spaceId: string) => {
  const name = owners.get(spaceId);
  return name === undefined ? {} : { ownerDisplayName: name };
};
const decodeLimits = Schema.decodeUnknownEffect(Schema.fromJsonString(GrantLimitsSchema));
const encodeLimits = Schema.encodeEffect(Schema.fromJsonString(GrantLimitsSchema));

/** Overcommitting is allowed and the machine caps CPU and memory: only the floors apply here. */
const UNBOUNDED_HOST = {
  cpus: Number.POSITIVE_INFINITY,
  memoryBytes: Number.POSITIVE_INFINITY,
  diskBytes: null,
};

/** Why these limits do not fit a loan of `kind`; undefined when they do. */
const limitsProblem = (kind: GrantResourceKind, limits: GrantLimits) => {
  if (limits.kind !== kind) return "These limits are for another kind of resource.";
  // An AI account's caps are whole positive amounts by their schema; none is a choice too.
  if (limits.kind !== "environment") return undefined;
  return invalidLimitsReason(
    {
      cpus: limits.cpus,
      memoryBytes: limits.memoryBytes,
      pids: limits.pids,
      diskBytes: limits.diskBytes,
    },
    UNBOUNDED_HOST,
  );
};

const decodeHost = Schema.decodeUnknownOption(Schema.fromJsonString(SandboxHostReport));
const decodeDisk = Schema.decodeUnknownOption(Schema.fromJsonString(LentSandboxDisk));

/** A machine Grant's host and Sandbox, as their last reports say. */
const machineOf = (row: GrantRow) => {
  const disk =
    row.lentDiskJson === null ? undefined : Option.getOrUndefined(decodeDisk(row.lentDiskJson));
  return {
    host: row.hostJson === null ? null : Option.getOrNull(decodeHost(row.hostJson)),
    lentEnvironmentId:
      row.lentEnvironmentId === null ? null : EnvironmentId.make(row.lentEnvironmentId),
    sandboxState: disk?.state ?? null,
    sandboxMessage: disk?.message ?? null,
    diskUsedBytes: disk?.usedBytes ?? null,
    diskMeasureFailures: disk?.failures ?? 0,
  };
};

const limitsDetail = (limits: GrantLimits) =>
  limits.kind === "environment"
    ? {
        cpus: limits.cpus,
        memoryBytes: limits.memoryBytes,
        pids: limits.pids,
        diskBytes: limits.diskBytes,
      }
    : {
        tokensAmount: limits.tokens?.amount ?? null,
        tokensPeriod: limits.tokens?.period ?? null,
        requestsAmount: limits.requests?.amount ?? null,
        requestsPeriod: limits.requests?.period ?? null,
      };

const DENIED: Partial<Record<AccessPolicy.DenyReason, string>> = {
  "not-yours": "Only the owner of what is lent lends it (an Organization's, its Admins).",
  "not-a-member": "You can lend only to Spaces you work in or to people you share a Space with.",
  "role-not-allowed": "Only an Admin of this Organization decides on its loans.",
  "not-your-personal-space": "Only the owner of this Personal space decides on its loans.",
  "space-archived": "This Space is archived.",
  "space-frozen": "This Space is frozen.",
  "user-inactive": "Your account is turned off.",
  "wrong-resource": "What you own already serves you in your own Space.",
};

/**
 * A stand-in destination for asking only whether someone is on a resource's lending side (the
 * policy reads the destination only to give).
 */
const principalSpace = (who: { readonly userId: UserId }): AccessPolicy.SpaceResource => ({
  id: SpaceId.make(`personal:${who.userId}`),
  kind: "personal",
  personalOwnerUserId: who.userId,
  archived: false,
  frozen: false,
});

const denied = (decision: AccessPolicy.Decision) =>
  decision._tag === "Deny"
    ? fail("not-allowed", DENIED[decision.reason] ?? "You may not do that with this loan.")
    : Effect.void;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const random = yield* SecureRandom.SecureRandom;
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;

  const storage =
    (what: string) =>
    (cause: unknown): Effect.Effect<never, GrantError> =>
      Effect.logWarning(`Grants: could not ${what}`, { cause }).pipe(
        Effect.andThen(fail("storage", `The Hub could not ${what}. Try again.`)),
      );

  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const newId = random
    .randomBytes(16)
    .pipe(Effect.map((bytes) => GrantId.make(`grant-${Buffer.from(bytes).toString("hex")}`)));

  const actor = spaces.actingUser.pipe(
    Effect.catch(storage("read who you are")),
    Effect.flatMap(
      Option.match({
        onNone: () => fail("not-allowed", "Sign in to lend or borrow."),
        onSome: Effect.succeed,
      }),
    ),
  );

  const caller = Effect.gen(function* () {
    const userId = yield* actor;
    const principal = yield* spaces
      .principalOf(userId)
      .pipe(Effect.catch(storage("check what you may do")));
    return { userId, principal };
  });
  type Caller = Effect.Success<typeof caller>;

  type Fragment = Parameters<typeof sql.and>[0][number];

  const selectGrants = (where: Fragment) => sql<GrantRow>`
    SELECT g.grant_id AS "grantId", g.resource_kind AS "resourceKind",
      g.resource_id AS "resourceId", g.lender_kind AS "lenderKind", g.lender_id AS "lenderId",
      g.target_kind AS "targetKind", g.target_id AS "targetId", g.state AS state,
      g.end_reason AS "endReason", g.limits_json AS "limitsJson", g.created_at AS "createdAt",
      g.decided_at AS "decidedAt", g.ended_at AS "endedAt",
      CASE g.resource_kind
        WHEN 'environment' THEN (SELECT name FROM environments WHERE environment_id = g.resource_id)
        WHEN 'ai-account' THEN (SELECT name FROM ai_accounts WHERE account_id = g.resource_id)
        ELSE NULL END AS "resourceName",
      CASE g.resource_kind
        WHEN 'ai-account' THEN (SELECT provider FROM ai_accounts WHERE account_id = g.resource_id)
        ELSE NULL END AS "aiProvider",
      CASE g.resource_kind
        WHEN 'ai-account' THEN (SELECT type FROM ai_accounts WHERE account_id = g.resource_id)
        ELSE NULL END AS "aiType",
      CASE g.lender_kind
        WHEN 'user' THEN (SELECT display_name FROM users WHERE user_id = g.lender_id)
        ELSE (SELECT name FROM spaces WHERE space_id = g.lender_id) END AS "lenderName",
      CASE g.resource_kind
        WHEN 'environment' THEN
          (SELECT sandbox_host_json FROM environments WHERE environment_id = g.resource_id)
        ELSE NULL END AS "hostJson",
      (SELECT e.environment_id FROM environments e
        WHERE e.grant_id = g.grant_id AND e.revoked_at IS NULL) AS "lentEnvironmentId",
      (SELECT e.last_disk_json FROM environments e WHERE e.grant_id = g.grant_id) AS "lentDiskJson"
    FROM grants g WHERE ${where}
    ORDER BY g.created_at DESC, g.grant_id
  `;

  const rowOf = (grantId: GrantId) =>
    selectGrants(sql`g.grant_id = ${grantId}`).pipe(
      Effect.map((rows) => rows[0]),
      Effect.catch(storage("read the loan")),
    );

  /** The Spaces these loans name: their destinations and their lending Organizations. */
  const targetsOf = Effect.fn("Grants.targetsOf")(function* (
    rows: ReadonlyArray<{
      readonly targetId: string | null;
      readonly lenderKind?: "user" | "organization";
      readonly lenderId?: string;
    }>,
  ) {
    const ids = [
      ...new Set(
        rows.flatMap((row) => [
          ...(row.targetId === null ? [] : [row.targetId]),
          ...(row.lenderKind === "organization" && row.lenderId !== undefined
            ? [row.lenderId]
            : []),
        ]),
      ),
    ];
    return yield* spaces
      .spacesById(ids.map((id) => SpaceId.make(id)))
      .pipe(Effect.catch(storage("read the loans' Spaces")));
  });

  /**
   * Whose each Personal space is, by display name: every Personal space is called «Personal», so
   * the lists name its owner instead. Only for Spaces the caller already reaches.
   */
  const personalOwnersOf = Effect.fn("Grants.personalOwnersOf")(function* (
    rows: ReadonlyArray<{ readonly targetId: string | null }>,
  ) {
    const ids = [...new Set(rows.flatMap((row) => (row.targetId === null ? [] : [row.targetId])))];
    if (ids.length === 0) return new Map<string, string>();
    const owners = yield* sql<{ readonly spaceId: string; readonly name: string }>`
      SELECT s.space_id AS "spaceId", u.display_name AS "name" FROM spaces s
      JOIN users u ON u.user_id = s.personal_owner_user_id
      WHERE s.kind = 'personal' AND ${sql.in("s.space_id", ids)}
    `.pipe(Effect.catch(storage("read whose Personal spaces they are")));
    return new Map(owners.map((owner) => [owner.spaceId, owner.name]));
  });

  type KnownSpaces = Effect.Success<ReturnType<typeof targetsOf>>;

  /** The lender as the policy reads it; an Organization's Space from `known` (null: gone). */
  const lenderOf = (
    row: Pick<GrantRow, "lenderKind" | "lenderId">,
    known: KnownSpaces,
  ): AccessPolicy.GrantLender =>
    row.lenderKind === "user"
      ? { kind: "user", userId: row.lenderId as UserId }
      : { kind: "organization", space: known.get(row.lenderId as SpaceId)?.resource ?? null };

  const resourceOf = (row: GrantRow, target: AccessPolicy.SpaceResource, known: KnownSpaces) =>
    ({
      kind: "grant",
      lender: lenderOf(row, known),
      target,
    }) satisfies AccessPolicy.GrantResource;

  const summaryOf = Effect.fn("Grants.summaryOf")(function* (
    row: GrantRow,
    known: Effect.Success<ReturnType<typeof targetsOf>>,
    owners: ReadonlyMap<string, string>,
    who: Caller,
  ) {
    const limits = yield* decodeLimits(row.limitsJson).pipe(
      Effect.catch(storage("read the loan's limits")),
    );
    const target = row.targetId === null ? undefined : known.get(row.targetId as SpaceId);
    const can = (action: AccessPolicy.Action) =>
      target !== undefined &&
      AccessPolicy.isAllowed(
        AccessPolicy.decide(who.principal, action, resourceOf(row, target.resource, known)),
      );
    return {
      id: GrantId.make(row.grantId),
      resource: { kind: row.resourceKind, id: row.resourceId, name: row.resourceName },
      lender: { kind: row.lenderKind, id: row.lenderId, name: row.lenderName },
      target:
        target === undefined
          ? null
          : {
              spaceId: target.resource.id,
              kind: target.resource.kind,
              name: target.name,
              ...ownerNameOf(owners, target.resource.id),
            },
      state: row.state,
      endReason: row.endReason,
      limits,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      endedAt: row.endedAt,
      ...(row.resourceKind === "environment" ? { machine: machineOf(row) } : {}),
      ...(row.aiProvider !== null && row.aiType !== null
        ? { aiAccount: { provider: row.aiProvider, type: row.aiType } }
        : {}),
      can: {
        cancel: mayTransition("cancel", row.state) && can("grant.cancel"),
        revoke: mayTransition("end", row.state) && can("grant.revoke"),
        decide: mayTransition("accept", row.state) && can("grant.decide"),
        return: mayTransition("end", row.state) && can("grant.return"),
        setLimits: mayTransition("setLimits", row.state) && can("grant.setLimits"),
      },
    } satisfies Grant;
  });

  const summaries = Effect.fn("Grants.summaries")(function* (
    rows: ReadonlyArray<GrantRow>,
    who: Caller,
  ) {
    const known = yield* targetsOf(rows);
    const owners = yield* personalOwnersOf(rows);
    const grants: Array<Grant> = [];
    for (const row of rows) grants.push(yield* summaryOf(row, known, owners, who));
    return { grants };
  });

  /**
   * Whether the lender may name `spaceId`: an Organization they are in (any, for the Owner), their
   * own Personal space (the policy refuses it for what they own themselves), or the Personal space
   * of an active User they share a Space with (any, for the Owner).
   */
  const knownTargets = (who: Caller, spaceId?: SpaceId) => sql<{ readonly spaceId: string }>`
    SELECT s.space_id AS "spaceId" FROM spaces s
    WHERE s.archived_at IS NULL AND s.frozen_at IS NULL
      AND (${spaceId ?? null} IS NULL OR s.space_id = ${spaceId ?? null})
      AND (
        (s.kind = 'organization' AND (${who.principal.isOwner ? 1 : 0} = 1 OR EXISTS (
          SELECT 1 FROM space_memberships m
          WHERE m.space_id = s.space_id AND m.user_id = ${who.userId})))
        OR (s.kind = 'personal' AND s.personal_owner_user_id = ${who.userId})
        OR (s.kind = 'personal' AND s.personal_owner_user_id <> ${who.userId}
          AND EXISTS (SELECT 1 FROM users u WHERE u.user_id = s.personal_owner_user_id
            AND u.removed_at IS NULL AND u.disabled_at IS NULL)
          AND (${who.principal.isOwner ? 1 : 0} = 1 OR EXISTS (
            SELECT 1 FROM space_memberships mine
            JOIN space_memberships theirs ON theirs.space_id = mine.space_id
            WHERE mine.user_id = ${who.userId}
              AND theirs.user_id = s.personal_owner_user_id)))
      )
    ORDER BY s.kind, s.name
  `;

  /** The machine to lend: a personal one, not removed; its owner is the lender. */
  const lendableEnvironment = Effect.fn("Grants.lendableEnvironment")(function* (
    environmentId: string,
  ) {
    const [row] = yield* sql<{
      readonly kind: string;
      readonly mode: string;
      readonly ownerUserId: string | null;
      readonly name: string;
    }>`
      SELECT kind, mode, owner_user_id AS "ownerUserId", name FROM environments
      WHERE environment_id = ${environmentId} AND revoked_at IS NULL
    `.pipe(Effect.catch(storage("read the machine")));
    if (row === undefined) return yield* fail("not-found", "That machine does not exist.");
    if (row.kind !== "external" || row.mode !== "personal" || row.ownerUserId === null) {
      return yield* fail(
        "not-lendable",
        "Only a personal machine joined with `t3 join` can be lent; a Sandbox or a dedicated machine cannot.",
      );
    }
    return {
      kind: "environment",
      resourceId: environmentId,
      name: row.name,
      lenderKind: "user",
      lenderId: row.ownerUserId,
      lender: { kind: "user", userId: row.ownerUserId as UserId },
    } satisfies Lendable;
  });

  /**
   * The AI account to lend: a live one its owner signs in or keys for the gateway. A direct one is
   * never lent: its credential goes to the agent and its use is not counted.
   */
  const lendableAiAccount = Effect.fn("Grants.lendableAiAccount")(function* (accountId: string) {
    const [row] = yield* sql<{
      readonly name: string;
      readonly type: AiAccountType;
      readonly ownerKind: "user" | "organization";
      readonly ownerId: string;
    }>`
      SELECT name, type, owner_kind AS "ownerKind", owner_id AS "ownerId" FROM ai_accounts
      WHERE account_id = ${accountId} AND deleted_at IS NULL
    `.pipe(Effect.catch(storage("read the AI account")));
    if (row === undefined) return yield* fail("not-found", "That AI account does not exist.");
    if (row.type === "direct") {
      return yield* fail(
        "not-lendable",
        "A direct AI account cannot be lent: its credential would leave the Hub. Lend an API key or a subscription.",
      );
    }
    const lender: AccessPolicy.GrantLender =
      row.ownerKind === "user"
        ? { kind: "user", userId: row.ownerId as UserId }
        : {
            kind: "organization",
            space:
              (yield* targetsOf([{ targetId: row.ownerId }])).get(row.ownerId as SpaceId)
                ?.resource ?? null,
          };
    return {
      kind: "ai-account",
      resourceId: accountId,
      name: row.name,
      lenderKind: row.ownerKind,
      lenderId: row.ownerId,
      lender,
    } satisfies Lendable;
  });

  const lendable = (resource: GrantGiveInput["resource"]) =>
    resource.kind === "environment"
      ? lendableEnvironment(resource.environmentId)
      : lendableAiAccount(resource.aiAccountId);

  const checkGive = Effect.fn("Grants.checkGive")(function* (input: GrantGiveInput, who: Caller) {
    if (input.planId !== undefined) {
      return yield* fail(
        "plan-target-unavailable",
        "Lending to a Plan is not available yet: lend to a Space.",
      );
    }
    const item = yield* lendable(input.resource);
    const problem = limitsProblem(item.kind, input.limits);
    if (problem !== undefined) return yield* fail("invalid-limits", problem);
    if (input.resource.kind === "environment") {
      // A machine that said it cannot host a Sandbox is refused with why; one that never said
      // (an older one) is lent, and the lists say it cannot host one yet.
      const host = yield* registry
        .sandboxHostOf(input.resource.environmentId)
        .pipe(Effect.catch(storage("read the machine")));
      if (Option.isSome(host) && !host.value.ready) {
        return yield* fail(
          "host-not-ready",
          `This machine cannot run a Sandbox for another Space now: ${host.value.reason ?? "it did not say why."}`,
        );
      }
    }
    const known = yield* targetsOf([{ targetId: input.spaceId }]);
    const target = known.get(input.spaceId);
    if (target === undefined) return yield* fail("not-found", "That Space does not exist.");
    const named = yield* knownTargets(who, input.spaceId).pipe(
      Effect.catch(storage("check the Space")),
    );
    const resource: AccessPolicy.GrantResource = {
      kind: "grant",
      lender: item.lender,
      target: target.resource,
      targetKnown: named.length > 0,
    };
    yield* denied(AccessPolicy.decide(who.principal, "grant.give", resource));
    const startsActive = AccessPolicy.isAllowed(
      AccessPolicy.decide(who.principal, "grant.decide", resource),
    );
    return { item, target, startsActive };
  });

  const auditOf = (
    row: Pick<GrantRow, "grantId" | "resourceKind" | "resourceId" | "lenderId" | "targetId">,
    resourceName: string | null,
  ) => ({
    spaceId: row.targetId as SpaceId | null,
    target: {
      kind: "grant" as const,
      id: row.grantId,
      ...(resourceName === null ? {} : { name: resourceName }),
    },
    common: {
      resourceKind: row.resourceKind,
      resourceId: row.resourceId,
      resourceName,
      lenderId: row.lenderId,
      targetSpaceId: row.targetId,
    },
  });

  const reread = Effect.fn("Grants.reread")(function* (grantId: GrantId, who: Caller) {
    const row = yield* rowOf(grantId);
    if (row === undefined) return yield* fail("not-found", NOT_FOUND);
    const { grants } = yield* summaries([row], who);
    const grant = grants[0];
    if (grant === undefined) return yield* fail("not-found", NOT_FOUND);
    return grant;
  });

  /** The Grant, once the caller sees it from either side; otherwise it does not exist for them. */
  const visibleRow = Effect.fn("Grants.visibleRow")(function* (grantId: GrantId, who: Caller) {
    const row = yield* rowOf(grantId);
    if (row === undefined || row.targetId === null) return yield* fail("not-found", NOT_FOUND);
    const known = yield* targetsOf([row]);
    const target = known.get(row.targetId as SpaceId);
    if (target === undefined) return yield* fail("not-found", NOT_FOUND);
    const resource = resourceOf(row, target.resource, known);
    const can = (action: AccessPolicy.Action) =>
      AccessPolicy.isAllowed(AccessPolicy.decide(who.principal, action, resource));
    if (
      !can("grant.viewGiven") &&
      !can("grant.decide") &&
      !can("grant.return") &&
      !(row.state === "active" && can("grant.viewReceived"))
    ) {
      return yield* fail("not-found", NOT_FOUND);
    }
    return { row, resource, can };
  });

  const illegal = (op: GrantOp, state: GrantState) =>
    fail("illegal-transition", `A ${state} loan cannot be ${PAST[op]}.`);
  const PAST: Record<GrantOp, string> = {
    accept: "accepted",
    reject: "rejected",
    cancel: "cancelled",
    end: "ended",
    setLimits: "changed",
  };

  /** Moves the Grant from `from` to `to` only if nobody moved it first. */
  const move = (grantId: string, from: GrantState, set: Fragment) =>
    sql<{ readonly grantId: string }>`
      UPDATE grants SET ${set} WHERE grant_id = ${grantId} AND state = ${from}
      RETURNING grant_id AS "grantId"
    `.pipe(
      Effect.flatMap((rows) =>
        rows.length === 0
          ? fail("illegal-transition", "This loan changed meanwhile. Reload and try again.")
          : Effect.void,
      ),
    );

  const inTransaction = <A>(
    what: string,
    effect: Effect.Effect<
      A,
      | GrantError
      | SqlError
      | AuditLog.AuditLogWriteError
      | Schema.SchemaError
      | EnvironmentRegistry.EnvironmentStorageError
    >,
  ) =>
    sql.withTransaction(effect).pipe(
      Effect.catchTags({
        SqlError: storage(what),
        AuditLogWriteError: storage(what),
        SchemaError: storage(what),
        EnvironmentStorageError: storage(what),
      }),
    );

  const listGiven = Effect.gen(function* () {
    const who = yield* caller;
    // Theirs, and their Organizations' when they run them (the policy decides each one).
    const rows = yield* selectGrants(sql`
      (g.lender_kind = 'user' AND g.lender_id = ${who.userId})
      OR (g.lender_kind = 'organization' AND g.lender_id IN (
        SELECT space_id FROM space_memberships WHERE user_id = ${who.userId} AND role = 'admin'
      ))
    `).pipe(Effect.catch(storage("read your loans")));
    const known = yield* targetsOf(rows);
    const seen = rows.filter((row) => {
      const target = row.targetId === null ? undefined : known.get(row.targetId as SpaceId);
      return (
        target !== undefined &&
        AccessPolicy.isAllowed(
          AccessPolicy.decide(
            who.principal,
            "grant.viewGiven",
            resourceOf(row, target.resource, known),
          ),
        )
      );
    });
    return yield* summaries(seen, who);
  });

  const listReceived = Effect.fn("Grants.listReceived")(function* (input: GrantListReceivedInput) {
    const who = yield* caller;
    const rows = yield* selectGrants(sql`
      g.target_kind = 'space' AND g.state IN ('pending', 'active')
      AND (${input.spaceId ?? null} IS NULL OR g.target_id = ${input.spaceId ?? null})
      AND g.target_id IN (
        SELECT space_id FROM space_memberships WHERE user_id = ${who.userId}
        UNION SELECT space_id FROM spaces WHERE personal_owner_user_id = ${who.userId}
      )
    `).pipe(Effect.catch(storage("read your Space's loans")));
    const { grants } = yield* summaries(rows, who);
    const known = yield* targetsOf(rows);
    // Waiting ones only for whoever decides; active ones for whoever works there.
    return {
      grants: grants.filter((grant, index) => {
        const row = rows[index];
        const target = row?.targetId == null ? undefined : known.get(row.targetId as SpaceId);
        if (row === undefined || target === undefined) return false;
        const action = grant.state === "pending" ? "grant.decide" : "grant.viewReceived";
        return AccessPolicy.isAllowed(
          AccessPolicy.decide(who.principal, action, resourceOf(row, target.resource, known)),
        );
      }),
    };
  });

  const targets = Effect.fn("Grants.targets")(function* (input: GrantTargetsInput) {
    const who = yield* caller;
    const item = yield* lendable(input.resource);
    const ids = yield* knownTargets(who).pipe(Effect.catch(storage("read the Spaces")));
    const known = yield* targetsOf(ids.map((row) => ({ targetId: row.spaceId })));
    const owners = yield* personalOwnersOf(ids.map((row) => ({ targetId: row.spaceId })));
    const lends = (target: AccessPolicy.SpaceResource) =>
      AccessPolicy.decide(who.principal, "grant.viewGiven", {
        kind: "grant",
        lender: item.lender,
        target,
      });
    // Only the lender's side asks which Spaces it may lend to.
    if (item.lender === null || !AccessPolicy.isAllowed(lends(principalSpace(who)))) {
      return yield* fail("not-allowed", DENIED["not-yours"] ?? "");
    }
    const host =
      input.resource.kind === "environment"
        ? yield* registry
            .sandboxHostOf(input.resource.environmentId)
            .pipe(Effect.catch(storage("read the machine")))
        : Option.none<SandboxHostReport>();
    return {
      host: Option.getOrNull(host),
      targets: ids.flatMap((row) => {
        const target = known.get(row.spaceId as SpaceId);
        if (target === undefined) return [];
        const resource: AccessPolicy.GrantResource = {
          kind: "grant",
          lender: item.lender,
          target: target.resource,
          targetKnown: true,
        };
        if (!AccessPolicy.isAllowed(AccessPolicy.decide(who.principal, "grant.give", resource))) {
          return [];
        }
        return [
          {
            spaceId: target.resource.id,
            kind: target.resource.kind,
            name: target.name,
            ...ownerNameOf(owners, target.resource.id),
            startsActive: AccessPolicy.isAllowed(
              AccessPolicy.decide(who.principal, "grant.decide", resource),
            ),
          },
        ];
      }),
    };
  });

  const prepareGive = Effect.fn("Grants.prepareGive")(function* (input: GrantGiveInput) {
    const who = yield* caller;
    const checked = yield* checkGive(input, who);
    return { needsStrongFactor: checked.startsActive && checked.item.kind === "environment" };
  });

  const give = Effect.fn("Grants.give")(function* (input: GrantGiveInput, proof: FactorProof) {
    const who = yield* caller;
    const grantId = yield* newId;
    yield* inTransaction(
      "lend it",
      Effect.gen(function* () {
        // Checked again in the transaction: a membership or the machine may have changed.
        const { item, startsActive } = yield* checkGive(input, who);
        if (startsActive && item.kind === "environment" && !proof.strongFactor) {
          return yield* fail(
            "strong-factor-required",
            "Lending a machine where you also accept it needs a passkey or authenticator code.",
          );
        }
        const at = yield* now;
        const state: GrantState = startsActive ? "active" : "pending";
        const limitsJson = yield* encodeLimits(input.limits);
        const live = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM grants
          WHERE resource_kind = ${item.kind} AND resource_id = ${item.resourceId}
            AND target_kind = 'space' AND target_id = ${input.spaceId}
            AND state IN ('pending', 'active')
        `;
        if ((live[0]?.n ?? 0) > 0) {
          return yield* fail(
            "already-granted",
            item.kind === "environment"
              ? "This machine is already lent to that Space."
              : "This AI account is already lent to that Space.",
          );
        }
        yield* sql`
          INSERT INTO grants (
            grant_id, resource_kind, resource_id, lender_kind, lender_id, target_kind, target_id,
            state, limits_json, created_at, created_by, decided_at, decided_by
          ) VALUES (
            ${grantId}, ${item.kind}, ${item.resourceId}, ${item.lenderKind},
            ${item.lenderId}, 'space', ${input.spaceId}, ${state}, ${limitsJson}, ${at},
            ${who.userId}, ${startsActive ? at : null}, ${startsActive ? who.userId : null}
          )
        `;
        if (startsActive && input.resource.kind === "environment") {
          yield* registry.openLentSandbox({
            grantId,
            hostEnvironmentId: input.resource.environmentId,
            spaceId: input.spaceId,
          });
        }
        const record = auditOf(
          {
            grantId,
            resourceKind: item.kind,
            resourceId: item.resourceId,
            lenderId: item.lenderId,
            targetId: input.spaceId,
          },
          item.name,
        );
        yield* audit.record({
          actor: AuditLog.userActor(who.userId),
          action: "grant.give",
          spaceId: record.spaceId,
          target: record.target,
          detail: { ...record.common, state, ...limitsDetail(input.limits) },
        });
      }),
    );
    return yield* reread(grantId, who);
  });

  const prepareAccept = Effect.fn("Grants.prepareAccept")(function* (input: GrantRefInput) {
    const who = yield* caller;
    const { row, can } = yield* visibleRow(input.grantId, who);
    if (!mayTransition("accept", row.state)) return yield* illegal("accept", row.state);
    if (!can("grant.decide")) return yield* fail("not-allowed", DENIED["role-not-allowed"] ?? "");
    return { needsStrongFactor: row.resourceKind === "environment" };
  });

  /** A decision by the destination: accept or reject. */
  const decideOn = Effect.fn("Grants.decideOn")(function* (
    op: "accept" | "reject",
    input: GrantRefInput,
    proof: FactorProof,
  ) {
    const who = yield* caller;
    yield* inTransaction(
      op === "accept" ? "accept the loan" : "reject the loan",
      Effect.gen(function* () {
        const { row, resource } = yield* visibleRow(input.grantId, who);
        if (!mayTransition(op, row.state)) return yield* illegal(op, row.state);
        yield* denied(AccessPolicy.decide(who.principal, "grant.decide", resource));
        if (op === "accept" && row.resourceKind === "environment" && !proof.strongFactor) {
          return yield* fail(
            "strong-factor-required",
            "Accepting a machine needs a passkey or authenticator code.",
          );
        }
        const at = yield* now;
        const to = TRANSITIONS[op].to ?? row.state;
        yield* move(
          row.grantId,
          row.state,
          sql`state = ${to}, decided_at = ${at}, decided_by = ${who.userId}`,
        );
        // An accepted machine runs a Sandbox for the Space, an Environment of its own.
        if (op === "accept" && row.resourceKind === "environment" && row.targetId !== null) {
          yield* registry.openLentSandbox({
            grantId: row.grantId,
            hostEnvironmentId: EnvironmentId.make(row.resourceId),
            spaceId: SpaceId.make(row.targetId),
          });
        }
        const record = auditOf(row, row.resourceName);
        yield* audit.record({
          actor: AuditLog.userActor(who.userId),
          action: op === "accept" ? "grant.accept" : "grant.reject",
          spaceId: record.spaceId,
          target: record.target,
          detail: record.common,
        });
      }),
    );
    return yield* reread(input.grantId, who);
  });
  const accept = Effect.fn("Grants.accept")(function* (input: GrantRefInput, proof: FactorProof) {
    return yield* decideOn("accept", input, proof);
  });
  const reject = Effect.fn("Grants.reject")(function* (input: GrantRefInput) {
    return yield* decideOn("reject", input, { strongFactor: false });
  });

  const cancel = Effect.fn("Grants.cancel")(function* (input: GrantRefInput) {
    const who = yield* caller;
    yield* inTransaction(
      "cancel the loan",
      Effect.gen(function* () {
        const { row, resource } = yield* visibleRow(input.grantId, who);
        if (!mayTransition("cancel", row.state)) return yield* illegal("cancel", row.state);
        yield* denied(AccessPolicy.decide(who.principal, "grant.cancel", resource));
        const at = yield* now;
        yield* move(
          row.grantId,
          row.state,
          sql`state = 'cancelled', decided_at = ${at}, decided_by = ${who.userId}`,
        );
        const record = auditOf(row, row.resourceName);
        yield* audit.record({
          actor: AuditLog.userActor(who.userId),
          action: "grant.cancel",
          spaceId: record.spaceId,
          target: record.target,
          detail: record.common,
        });
      }),
    );
    return yield* reread(input.grantId, who);
  });

  const end = Effect.fn("Grants.end")(function* (input: GrantRefInput) {
    const who = yield* caller;
    const closed = yield* inTransaction(
      "end the loan",
      Effect.gen(function* () {
        const { row, can } = yield* visibleRow(input.grantId, who);
        if (!mayTransition("end", row.state)) return yield* illegal("end", row.state);
        // The lender revokes; the destination returns. A lender who also decides there revokes.
        const side = can("grant.revoke") ? "lender" : can("grant.return") ? "target" : undefined;
        if (side === undefined) {
          return yield* fail(
            "not-allowed",
            "Only the lender or an Admin of the Space ends a loan.",
          );
        }
        const reason: GrantEndReason = side === "lender" ? "revoked" : "returned";
        return yield* endRow(row, reason, side, AuditLog.userActor(who.userId), who.userId);
      }),
    );
    // After the commit: a machine's Sandbox stops its turns, is cut off and its Threads need an
    // environment.
    if (Option.isSome(closed)) {
      yield* registry.lentSandboxEnding({ grantId: input.grantId, environmentId: closed.value });
    }
    return yield* reread(input.grantId, who);
  });

  /** In the caller's transaction: the Grant ends, its kind loses what it reached, audited. */
  const endRow = Effect.fn("Grants.endRow")(function* (
    row: GrantRow,
    reason: GrantEndReason,
    side: "lender" | "target" | "system",
    actorOf: AuditLog.AuditActor,
    by: UserId | null,
  ) {
    const at = yield* now;
    yield* move(
      row.grantId,
      row.state,
      sql`state = 'ended', end_reason = ${reason}, ended_at = ${at}, ended_by = ${by}`,
    );
    // From the commit on no new turn starts on a machine's Sandbox; after it, its running turns
    // get their time to stop before it is closed (`lentSandboxEnding`).
    const closed =
      row.resourceKind === "environment" && row.lentEnvironmentId !== null
        ? Option.some(EnvironmentId.make(row.lentEnvironmentId))
        : Option.none<EnvironmentId>();
    const record = auditOf(row, row.resourceName);
    yield* audit.record({
      actor: actorOf,
      action: "grant.end",
      spaceId: record.spaceId,
      target: record.target,
      detail: { ...record.common, reason, side },
    });
    return closed;
  });

  const setLimits = Effect.fn("Grants.setLimits")(function* (input: GrantSetLimitsInput) {
    const who = yield* caller;
    const problem = limitsProblem(input.limits.kind, input.limits);
    if (problem !== undefined) return yield* fail("invalid-limits", problem);
    yield* inTransaction(
      "change the loan's limits",
      Effect.gen(function* () {
        const { row, resource } = yield* visibleRow(input.grantId, who);
        if (!mayTransition("setLimits", row.state)) return yield* illegal("setLimits", row.state);
        yield* denied(AccessPolicy.decide(who.principal, "grant.setLimits", resource));
        const mismatch = limitsProblem(row.resourceKind, input.limits);
        if (mismatch !== undefined) return yield* fail("invalid-limits", mismatch);
        const limitsJson = yield* encodeLimits(input.limits);
        yield* move(row.grantId, row.state, sql`limits_json = ${limitsJson}`);
        const record = auditOf(row, row.resourceName);
        yield* audit.record({
          actor: AuditLog.userActor(who.userId),
          action: "grant.limits.change",
          spaceId: record.spaceId,
          target: record.target,
          detail: {
            resourceKind: row.resourceKind,
            resourceId: row.resourceId,
            ...limitsDetail(input.limits),
          },
        });
      }),
    );
    return yield* reread(input.grantId, who);
  });

  return Grants.of({
    listGiven,
    listReceived,
    targets,
    prepareGive,
    give,
    prepareAccept,
    accept,
    reject,
    cancel,
    end,
    setLimits,
  });
});

export const layer = Layer.effect(Grants, make);
