/**
 * Grants: an owner lends one resource to a Space with limits, the Space decides, and either side
 * ends it. One row per loan (`grants`, migration 135), kept as history. Each change is a row of
 * `TRANSITIONS`, decided by AccessPolicy `grant.*` and audited in its transaction. Machines, AI
 * accounts and named Vault groups are lent. See docs/internals/grants.md.
 */
import {
  type Grant,
  type GrantClaimOfferInput,
  type GrantCreatedOffer,
  type GrantCreateOfferInput,
  type GrantEndReason,
  GrantError,
  type GrantErrorReason,
  type GrantDismissMigrationReviewInput,
  type GrantGiveInput,
  GrantId,
  GRANT_OFFER_DAYS,
  GRANT_OPEN_OFFERS_PER_RESOURCE,
  type GrantOfferPreview,
  type GrantReadOfferInput,
  type GrantLimits,
  GrantLimits as GrantLimitsSchema,
  type GrantList,
  type GrantListReceivedInput,
  type GrantMigrationReviews,
  type GrantRefInput,
  type GrantResourceKind,
  type GrantSetLimitsInput,
  type GrantState,
  type GrantTargets,
  type GrantTargetsInput,
  type GrantVaultUsage,
  type GrantVaultUsageInput,
  GRANT_VAULT_USAGE_ROWS,
  type AiAccountId,
  type AiAccountProvider,
  type AiAccountType,
  EnvironmentId,
  SandboxHostReport,
  SpaceId,
  type UserId,
  VaultEntryId,
  VaultGroupId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as AiAccountChanges from "../ai/AiAccountChanges.ts";
import * as GrantCaps from "../ai/GrantCaps.ts";
import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import { makeSignInThrottle } from "../auth/signInThrottle.ts";
import * as PublicHubUrl from "../environment/PublicHubUrl.ts";
import * as EnvironmentRegistry from "../environments/EnvironmentRegistry.ts";
import { invalidLimitsReason } from "../sandboxes/sandboxLimits.ts";
import { LentSandboxDisk } from "../sandboxes/sandboxSpace.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as VaultGrantUsage from "../vaults/VaultGrantUsage.ts";
import * as VaultReachLoss from "../vaults/VaultReachLoss.ts";
import * as SpaceToolRows from "../spaceTools/spaceToolRows.ts";
import { KEEP_NAMES_SQL } from "./GrantEnding.ts";

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

/**
 * Making a machine Grant active needs a strong factor: it opens the lender's machine. So does
 * giving a Vault group, active or not: its Secrets reach the borrower's agents (Grants ticket 07).
 */
export interface FactorProof {
  readonly strongFactor: boolean;
}

/** Accepting (or giving active) a Vault group's loan may also make it a default of the Space. */
export interface DefaultChoice {
  readonly useAsDefault?: boolean | undefined;
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
    readonly accept: (
      input: GrantRefInput & DefaultChoice,
      proof: FactorProof,
    ) => Effect.Effect<Grant, GrantError>;
    readonly reject: (input: GrantRefInput) => Effect.Effect<Grant, GrantError>;
    readonly cancel: (input: GrantRefInput) => Effect.Effect<Grant, GrantError>;
    /** Revoked by the lender, or returned by the destination: whichever side the caller is. */
    readonly end: (input: GrantRefInput) => Effect.Effect<Grant, GrantError>;
    readonly setLimits: (input: GrantSetLimitsInput) => Effect.Effect<Grant, GrantError>;
    /**
     * Grants ticket 06: a lending link for a Space the lender does not name (`grant.offer`).
     * Works once, for seven days; only its token's hash is kept, and the token is answered once.
     */
    readonly createOffer: (
      input: GrantCreateOfferInput,
    ) => Effect.Effect<GrantCreatedOffer, GrantError>;
    /** What a signed-in holder of a link sees; a dead or unknown one is `invalid`, nothing more. */
    readonly readOffer: (
      input: GrantReadOfferInput,
    ) => Effect.Effect<GrantOfferPreview, GrantError>;
    /**
     * Refuses as `claimOffer` would and says whether applying it needs a strong factor (a
     * machine's: it becomes active), before the door asks for one.
     */
    readonly prepareClaim: (
      input: GrantClaimOfferInput,
    ) => Effect.Effect<{ readonly needsStrongFactor: boolean }, GrantError>;
    /**
     * Applying a link to a Space where the caller decides: the loan starts active there, as
     * accepting it would (a machine's with the decider's strong factor, its Sandbox opened).
     */
    readonly claimOffer: (
      input: GrantClaimOfferInput,
      proof?: FactorProof,
    ) => Effect.Effect<Grant, GrantError>;
    /**
     * Grants ticket 15: a lent Vault group's use, by day, User and name (names and counts only).
     * For its lender (`grant.viewGiven`) and whoever runs the borrowing Space (`grant.return`: its
     * Admins, a Personal space's User), also once the loan ended. Anyone else: not found.
     */
    readonly vaultUsage: (
      input: GrantVaultUsageInput,
    ) => Effect.Effect<GrantVaultUsage, GrantError>;
    /**
     * Grants ticket 02, the Owner only: what an allowance «to a User» reached that its Grant does
     * not. Lending there (`give`) or dismissing removes a row; a row grants nothing.
     */
    readonly migrationReviews: Effect.Effect<GrantMigrationReviews, GrantError>;
    readonly dismissMigrationReview: (
      input: GrantDismissMigrationReviewInput,
    ) => Effect.Effect<GrantMigrationReviews, GrantError>;
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
  readonly createdBy: string | null;
  readonly decidedAt: string | null;
  readonly endedAt: string | null;
  /** A lending link's (Grants ticket 06): made by one, and when it stops working. */
  readonly isOffer: number;
  readonly offerExpiresAt: string | null;
  readonly resourceName: string | null;
  readonly lenderName: string | null;
  /** The destination's name as last kept (Grants ticket 11): shown once its Space is gone. */
  readonly targetName: string | null;
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
  /** A Space MCP's Vault names, which the lender's lent groups must hold. */
  readonly references?: ReadonlyArray<string>;
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
  limits.kind === "vault-group" || limits.kind === "space-mcp" || limits.kind === "space-skill"
    ? {}
    : limits.kind === "environment"
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

/**
 * A lending link has no destination until it is applied: only its lender's side acts on it, and
 * the policy reads no destination for those actions.
 */
const LENDER_SIDE: ReadonlySet<AccessPolicy.Action> = new Set([
  "grant.offer",
  "grant.cancel",
  "grant.revoke",
  "grant.setLimits",
  "grant.viewGiven",
]);

/** Answered alike for a link used, cancelled, expired or never made. */
const DEAD_LINK =
  "This lending link no longer works: it was used, cancelled or expired, or it is wrong. Ask for a new one.";

/** A link's state as its lender sees it; nothing for a loan that never was one. */
const offerOf = (row: GrantRow, nowIso: string) => {
  if (row.isOffer !== 1 || row.offerExpiresAt === null) return {};
  const status =
    row.state === "offered"
      ? row.offerExpiresAt > nowIso
        ? "open"
        : "expired"
      : row.state === "cancelled" && row.targetId === null
        ? "cancelled"
        : "used";
  return { offer: { expiresAt: row.offerExpiresAt, status } as const };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const random = yield* SecureRandom.SecureRandom;
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  // Who may use an AI account changed: live processes are checked again (`AiSessionReach`).
  const accountChanges = yield* Effect.serviceOption(AiAccountChanges.AiAccountChanges);
  // How much of a lent AI account's caps is used, where the Hub runs the gateway.
  const caps = yield* Effect.serviceOption(GrantCaps.GrantCaps);
  // Lending links (ticket 06): their tokens' hashes, the Hub's public address for their URL, and
  // a lock on whoever keeps trying links that do not work.
  const digest = yield* Digest.Digest;
  const publicHubUrl = yield* PublicHubUrl.PublicHubUrl;
  const linkThrottle = makeSignInThrottle();

  /** An active AI account Grant's caps now; nothing when it has none or the Hub cannot tell. */
  const capsOf = Effect.fn("Grants.capsOf")(function* (row: GrantRow, limits: GrantLimits) {
    if (
      Option.isNone(caps) ||
      row.state !== "active" ||
      limits.kind !== "ai-account" ||
      (limits.tokens === null && limits.requests === null)
    ) {
      return {};
    }
    const state = yield* caps.value.check(row.grantId, limits).pipe(Effect.option);
    if (Option.isNone(state)) return {};
    return { caps: { tokens: state.value.tokens, requests: state.value.requests } };
  });

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
      g.created_by AS "createdBy", g.decided_at AS "decidedAt", g.ended_at AS "endedAt",
      (g.offer_token_hash IS NOT NULL) AS "isOffer", g.offer_expires_at AS "offerExpiresAt",
      COALESCE(CASE g.resource_kind
        WHEN 'environment' THEN (SELECT name FROM environments WHERE environment_id = g.resource_id)
        WHEN 'ai-account' THEN (SELECT name FROM ai_accounts WHERE account_id = g.resource_id)
        WHEN 'vault-group' THEN (SELECT name FROM vault_groups WHERE group_id = g.resource_id)
        WHEN 'space-mcp' THEN (SELECT name FROM space_mcps WHERE mcp_id = g.resource_id)
        WHEN 'space-skill' THEN (SELECT name FROM space_skills WHERE skill_id = g.resource_id)
        ELSE NULL END, g.resource_name) AS "resourceName",
      CASE g.resource_kind
        WHEN 'ai-account' THEN (SELECT provider FROM ai_accounts WHERE account_id = g.resource_id)
        ELSE NULL END AS "aiProvider",
      CASE g.resource_kind
        WHEN 'ai-account' THEN (SELECT type FROM ai_accounts WHERE account_id = g.resource_id)
        ELSE NULL END AS "aiType",
      COALESCE(CASE g.lender_kind
        WHEN 'user' THEN (SELECT display_name FROM users WHERE user_id = g.lender_id)
        ELSE (SELECT name FROM spaces WHERE space_id = g.lender_id) END,
        g.lender_name) AS "lenderName",
      g.target_name AS "targetName",
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

  /**
   * The Grant as the policy reads it for `who`: to its destination; a link with none yet, on its
   * lender's side only (the destination stands in, unread). Undefined: its Space is gone.
   */
  const policyResourceOf = (row: GrantRow, known: KnownSpaces, who: Caller) => {
    const target = row.targetId === null ? undefined : known.get(row.targetId as SpaceId);
    // A link with no destination yet, or a loan whose Space is gone (Grants ticket 11): its
    // lender's side alone, which still sees it.
    return target === undefined
      ? { resource: resourceOf(row, principalSpace(who), known), lenderSideOnly: true }
      : { resource: resourceOf(row, target.resource, known), lenderSideOnly: false };
  };

  const mayOn =
    (who: Caller, found: ReturnType<typeof policyResourceOf>) => (action: AccessPolicy.Action) =>
      found !== undefined &&
      (!found.lenderSideOnly || LENDER_SIDE.has(action)) &&
      AccessPolicy.isAllowed(AccessPolicy.decide(who.principal, action, found.resource));
  /**
   * Grants ticket 07: the Secrets of a lent group its borrower's agents could read: those it held
   * while active, whose value was not replaced since the loan ended (all of them while active).
   * Names only; a Secret that is replaced, deleted or becomes a Variable leaves the list.
   */
  const toRotateOf = Effect.fn("Grants.toRotateOf")(function* (row: GrantRow) {
    if (row.state !== "active" && row.state !== "ended") return [];
    // After the loan's end, by the audit's order: a Secret added or replaced since was never read.
    const rows = yield* sql<{ readonly entryId: string; readonly name: string }>`
      SELECT e.entry_id AS "entryId", e.name AS name FROM vault_entries e
      WHERE e.group_id = ${row.resourceId} AND e.kind = 'own' AND e.class = 'secret'
        AND NOT EXISTS (SELECT 1 FROM audit_log a
          WHERE a.action = 'secret.edit' AND a.target_kind = 'secret'
            AND a.target_id = e.entry_id
            AND json_extract(a.detail_json, '$.op') IN ('add', 'replace')
            AND a.audit_id > (SELECT MAX(x.audit_id) FROM audit_log x
              WHERE x.action = 'grant.end' AND x.target_kind = 'grant'
                AND x.target_id = ${row.grantId}))
      ORDER BY e.name
    `.pipe(Effect.catch(storage("read the Secrets to rotate")));
    return rows.map((entry) => ({ entryId: VaultEntryId.make(entry.entryId), name: entry.name }));
  });

  const summaryOf = Effect.fn("Grants.summaryOf")(function* (
    row: GrantRow,
    known: Effect.Success<ReturnType<typeof targetsOf>>,
    owners: ReadonlyMap<string, string>,
    who: Caller,
    nowIso: string,
  ) {
    const limits = yield* decodeLimits(row.limitsJson).pipe(
      Effect.catch(storage("read the loan's limits")),
    );
    const target = row.targetId === null ? undefined : known.get(row.targetId as SpaceId);
    const can = mayOn(who, policyResourceOf(row, known, who));
    const offer = offerOf(row, nowIso);
    // An expired link is history: nothing to cancel.
    const cancellable = offer.offer === undefined || offer.offer.status !== "expired";
    return {
      id: GrantId.make(row.grantId),
      resource: { kind: row.resourceKind, id: row.resourceId, name: row.resourceName },
      lender: { kind: row.lenderKind, id: row.lenderId, name: row.lenderName },
      target:
        target !== undefined
          ? {
              spaceId: target.resource.id,
              kind: target.resource.kind,
              name: target.name,
              ...ownerNameOf(owners, target.resource.id),
            }
          : // Its Space is gone (Grants ticket 11): by the name it had.
            row.targetId !== null && row.targetName !== null
            ? {
                spaceId: SpaceId.make(row.targetId),
                kind: row.targetId.startsWith("personal:") ? "personal" : "organization",
                name: row.targetName,
                ...ownerNameOf(owners, row.targetId),
              }
            : null,
      state: row.state,
      endReason: row.endReason,
      limits,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      endedAt: row.endedAt,
      ...(row.resourceKind === "environment" ? { machine: machineOf(row) } : {}),
      ...(row.resourceKind === "vault-group" && can("grant.viewGiven")
        ? { vaultGroup: { toRotate: yield* toRotateOf(row) } }
        : {}),
      ...(row.aiProvider !== null && row.aiType !== null
        ? {
            aiAccount: {
              provider: row.aiProvider,
              type: row.aiType,
              ...(yield* capsOf(row, limits)),
            },
          }
        : {}),
      ...offer,
      can: {
        cancel: mayTransition("cancel", row.state) && cancellable && can("grant.cancel"),
        revoke: mayTransition("end", row.state) && can("grant.revoke"),
        decide: mayTransition("accept", row.state) && can("grant.decide"),
        return: mayTransition("end", row.state) && can("grant.return"),
        setLimits:
          row.resourceKind !== "vault-group" &&
          mayTransition("setLimits", row.state) &&
          can("grant.setLimits"),
      },
    } satisfies Grant;
  });

  const summaries = Effect.fn("Grants.summaries")(function* (
    rows: ReadonlyArray<GrantRow>,
    who: Caller,
  ) {
    const known = yield* targetsOf(rows);
    const owners = yield* personalOwnersOf(rows);
    const nowIso = yield* now;
    const grants: Array<Grant> = [];
    for (const row of rows) grants.push(yield* summaryOf(row, known, owners, who, nowIso));
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
  /**
   * Grants ticket 13: someone else's resource answers as a missing one, before anything about it
   * (whether it can be lent, its machine's report): only its lender's side hears why not.
   */
  const lenderSideOr = (
    who: Caller | undefined,
    lender: AccessPolicy.GrantLender,
    missing: string,
  ) => {
    if (who === undefined) return Effect.void;
    const decision = AccessPolicy.decide(who.principal, "grant.viewGiven", {
      kind: "grant",
      lender,
      target: principalSpace(who),
    });
    // Not theirs at all: missing. A Member of the owning Organization sees it already, and is
    // told no by the policy further on.
    return decision._tag === "Deny" && decision.reason === "not-yours"
      ? fail("not-found", missing)
      : Effect.void;
  };

  const lendableEnvironment = Effect.fn("Grants.lendableEnvironment")(function* (
    environmentId: string,
    who?: Caller,
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
    // Someone's personal machine is lent by that User, and nobody else (the Owner included).
    if (who !== undefined && row.ownerUserId !== null && row.ownerUserId !== who.userId) {
      return yield* fail("not-found", "That machine does not exist.");
    }
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
  const lendableAiAccount = Effect.fn("Grants.lendableAiAccount")(function* (
    accountId: string,
    who?: Caller,
  ) {
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
    const lender: AccessPolicy.GrantLender =
      row.ownerKind === "user"
        ? { kind: "user", userId: row.ownerId as UserId }
        : {
            kind: "organization",
            space:
              (yield* targetsOf([{ targetId: row.ownerId }])).get(row.ownerId as SpaceId)
                ?.resource ?? null,
          };
    yield* lenderSideOr(who, lender, "That AI account does not exist.");
    if (row.type === "direct") {
      return yield* fail(
        "not-lendable",
        "A direct AI account cannot be lent: its credential would leave the Hub. Lend an API key or a subscription.",
      );
    }
    return {
      kind: "ai-account",
      resourceId: accountId,
      name: row.name,
      lenderKind: row.ownerKind,
      lenderId: row.ownerId,
      lender,
    } satisfies Lendable;
  });

  /**
   * Grants ticket 07: the Vault group to lend: a named one, not archived. A `default` is its
   * owner's Space's fixed default and is never lent.
   */
  const lendableVaultGroup = Effect.fn("Grants.lendableVaultGroup")(function* (
    groupId: string,
    who?: Caller,
  ) {
    const [row] = yield* sql<{
      readonly name: string;
      readonly isDefault: number;
      readonly archivedAt: string | null;
      readonly ownerKind: "user" | "organization";
      readonly ownerId: string;
    }>`
      SELECT name, is_default AS "isDefault", archived_at AS "archivedAt",
        owner_kind AS "ownerKind", owner_id AS "ownerId"
      FROM vault_groups WHERE group_id = ${groupId}
    `.pipe(Effect.catch(storage("read the Vault group")));
    if (row === undefined) return yield* fail("not-found", "That Vault group does not exist.");
    const lender: AccessPolicy.GrantLender =
      row.ownerKind === "user"
        ? { kind: "user", userId: row.ownerId as UserId }
        : {
            kind: "organization",
            space:
              (yield* targetsOf([{ targetId: row.ownerId }])).get(row.ownerId as SpaceId)
                ?.resource ?? null,
          };
    yield* lenderSideOr(who, lender, "That Vault group does not exist.");
    if (row.isDefault === 1) {
      return yield* fail(
        "not-lendable",
        "A `default` group serves its own Space only: put what you lend in a named group.",
      );
    }
    if (row.archivedAt !== null) {
      return yield* fail("not-lendable", "This group is archived: restore it to lend it.");
    }
    return {
      kind: "vault-group",
      resourceId: groupId,
      name: row.name,
      lenderKind: row.ownerKind,
      lenderId: row.ownerId,
      lender,
    } satisfies Lendable;
  });

  /**
   * A Space's own MCP server or Skill, lent by its Space's owner: an Organization (its Admins) or
   * a Personal space's User. One lent to a Space is never lent on from there: it is not its own.
   */
  const lendableSpaceTool = Effect.fn("Grants.lendableSpaceTool")(function* (
    kind: "space-mcp" | "space-skill",
    toolId: string,
    who?: Caller,
  ) {
    const missing =
      kind === "space-mcp" ? "That MCP server does not exist." : "That Skill does not exist.";
    const row = yield* SpaceToolRows.toolForGrant(sql, kind, toolId).pipe(
      Effect.catch(storage("read what is lent")),
    );
    if (row === undefined) return yield* fail("not-found", missing);
    const space = (yield* targetsOf([{ targetId: row.spaceId }])).get(
      row.spaceId as SpaceId,
    )?.resource;
    if (space === undefined) return yield* fail("not-found", missing);
    const ownerUserId = space.kind === "personal" ? space.personalOwnerUserId : null;
    if (space.kind === "personal" && (ownerUserId === null || ownerUserId === undefined)) {
      return yield* fail("not-found", missing);
    }
    const lender =
      ownerUserId === null || ownerUserId === undefined
        ? ({ kind: "organization", space } as const)
        : ({ kind: "user", userId: ownerUserId } as const);
    yield* lenderSideOr(who, lender, missing);
    return {
      kind,
      resourceId: toolId,
      name: row.name,
      lenderKind: lender.kind,
      lenderId: lender.kind === "user" ? lender.userId : row.spaceId,
      lender,
      references: row.references,
    } satisfies Lendable;
  });

  /** The resource as `who` (its lender's side) may lend it; anyone else is told it is missing. */
  const lendable = (resource: GrantGiveInput["resource"], who: Caller) =>
    resource.kind === "environment"
      ? lendableEnvironment(resource.environmentId, who)
      : resource.kind === "ai-account"
        ? lendableAiAccount(resource.aiAccountId, who)
        : resource.kind === "vault-group"
          ? lendableVaultGroup(resource.vaultGroupId, who)
          : resource.kind === "space-mcp"
            ? lendableSpaceTool("space-mcp", resource.spaceMcpId, who)
            : lendableSpaceTool("space-skill", resource.spaceSkillId, who);

  /**
   * Decision 1 (option A): an MCP server's Vault references reach a borrower only through the
   * lender's own Vault groups, lent to that Space and active, never through the borrower's.
   */
  const mcpReferencesLent = Effect.fn("Grants.mcpReferencesLent")(function* (
    item: { readonly lenderKind: string; readonly lenderId: string },
    references: ReadonlyArray<string>,
    spaceId: string,
  ) {
    if (references.length === 0) return;
    const lent = yield* sql<{ readonly name: string }>`
      SELECT DISTINCT e.name FROM grants g
      JOIN vault_groups v ON v.group_id = g.resource_id
      JOIN vault_entries e ON e.group_id = v.group_id
      WHERE g.resource_kind = 'vault-group' AND g.state = 'active' AND g.target_kind = 'space'
        AND g.target_id = ${spaceId} AND v.owner_kind = ${item.lenderKind}
        AND v.owner_id = ${item.lenderId} AND v.archived_at IS NULL
    `.pipe(Effect.catch(storage("read the Vault groups lent there")));
    const names = new Set(lent.map((row) => row.name));
    const missing = references.filter((name) => !names.has(name));
    if (missing.length > 0) {
      return yield* fail(
        "not-lendable",
        `This MCP server needs ${missing.join(", ")}: first lend the Vault groups that hold them to this Space.`,
      );
    }
  });

  /** Whether giving it needs a strong factor: an active machine's, any Vault group's. */
  const giveNeedsFactor = (kind: GrantResourceKind, startsActive: boolean) =>
    kind === "vault-group" || (startsActive && kind === "environment");

  /**
   * Grants ticket 07, in the transaction that makes a Vault group's loan active: rows naming it
   * in the Space from before go, and it becomes the Space's last default when asked (audited).
   */
  const vaultGroupActive = Effect.fn("Grants.vaultGroupActive")(function* (input: {
    readonly vaultId: string;
    readonly vaultName: string | null;
    readonly spaceId: string;
    readonly useAsDefault: boolean;
    readonly by: UserId;
    readonly via: "grant.give" | "grant.accept";
  }) {
    yield* VaultReachLoss.clearForGrant(sql, input.vaultId, input.spaceId);
    if (!input.useAsDefault) return;
    const [last] = yield* sql<{ readonly position: number | null }>`
      SELECT MAX(position) AS position FROM space_default_vaults WHERE space_id = ${input.spaceId}
    `;
    const position = (last?.position ?? -1) + 1;
    yield* sql`
      INSERT INTO space_default_vaults (space_id, group_id, position)
      VALUES (${input.spaceId}, ${input.vaultId}, ${position})
    `;
    yield* audit.record({
      actor: AuditLog.userActor(input.by),
      action: "vault.choose",
      spaceId: SpaceId.make(input.spaceId),
      target: {
        kind: "vault",
        id: input.vaultId,
        ...(input.vaultName === null ? {} : { name: input.vaultName }),
      },
      detail: { scope: "space", choice: "default", position, via: input.via },
    });
  });

  /**
   * A machine that said it cannot host a Sandbox is refused with why; one that never said (an
   * older one) is lent, and the lists say it cannot host one yet. Giving, making a link, applying.
   */
  const hostReady = Effect.fn("Grants.hostReady")(function* (environmentId: string) {
    const host = yield* registry
      .sandboxHostOf(EnvironmentId.make(environmentId))
      .pipe(Effect.catch(storage("read the machine")));
    if (Option.isSome(host) && !host.value.ready) {
      return yield* fail(
        "host-not-ready",
        `This machine cannot run a Sandbox for another Space now: ${host.value.reason ?? "it did not say why."}`,
      );
    }
  });

  const checkGive = Effect.fn("Grants.checkGive")(function* (input: GrantGiveInput, who: Caller) {
    if (input.planId !== undefined) {
      return yield* fail(
        "plan-target-unavailable",
        "Lending to a Plan is not available yet: lend to a Space.",
      );
    }
    const item = yield* lendable(input.resource, who);
    const problem = limitsProblem(item.kind, input.limits);
    if (problem !== undefined) return yield* fail("invalid-limits", problem);
    if (input.resource.kind === "environment") yield* hostReady(input.resource.environmentId);
    const known = yield* targetsOf([{ targetId: input.spaceId }]);
    const target = known.get(input.spaceId);
    if (target === undefined) return yield* fail("not-found", "That Space does not exist.");
    if (item.kind === "space-mcp")
      yield* mcpReferencesLent(item, item.references ?? [], input.spaceId);
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
    row: Pick<
      GrantRow,
      "grantId" | "resourceKind" | "resourceId" | "lenderKind" | "lenderId" | "targetId"
    >,
    resourceName: string | null,
  ) => ({
    // Under the Space it was lent to; a link not applied yet, under its lending Organization.
    spaceId: (row.targetId ??
      (row.lenderKind === "organization" ? row.lenderId : null)) as SpaceId | null,
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
    if (row === undefined) return yield* fail("not-found", NOT_FOUND);
    const known = yield* targetsOf([row]);
    const found = policyResourceOf(row, known, who);
    if (found === undefined) return yield* fail("not-found", NOT_FOUND);
    const resource = found.resource;
    const can = mayOn(who, found);
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
      UPDATE grants SET ${set}, ${sql.literal(KEEP_NAMES_SQL)}
      WHERE grant_id = ${grantId} AND state = ${from}
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
      | AuditLog.AuditActorMissingError
      | Schema.SchemaError
      | EnvironmentRegistry.EnvironmentStorageError
    >,
  ) =>
    sql.withTransaction(effect).pipe(
      Effect.catchTags({
        SqlError: storage(what),
        AuditLogWriteError: storage(what),
        AuditActorMissingError: storage(what),
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
    // Lending links too, which have no destination until applied.
    const seen = rows.filter((row) =>
      mayOn(who, policyResourceOf(row, known, who))("grant.viewGiven"),
    );
    return yield* summaries(seen, who);
  });

  const vaultUsage = Effect.fn("Grants.vaultUsage")(function* (input: GrantVaultUsageInput) {
    const who = yield* caller;
    const row = yield* rowOf(input.grantId);
    // Only a Vault group's loan has one; any other answers as a loan the caller does not see.
    if (row === undefined || row.resourceKind !== "vault-group") {
      return yield* fail("not-found", NOT_FOUND);
    }
    const known = yield* targetsOf([row]);
    const can = mayOn(who, policyResourceOf(row, known, who));
    if (!can("grant.viewGiven") && !can("grant.return")) {
      return yield* fail("not-found", NOT_FOUND);
    }
    return yield* VaultGrantUsage.read(sql, row.grantId, GRANT_VAULT_USAGE_ROWS).pipe(
      Effect.catch(storage("read the loan's use")),
    );
  });

  const listReceived = Effect.fn("Grants.listReceived")(function* (input: GrantListReceivedInput) {
    const who = yield* caller;
    const rows = yield* selectGrants(sql`
      g.target_kind = 'space' AND g.state IN ('pending', 'active', 'ended')
      AND (${input.spaceId ?? null} IS NULL OR g.target_id = ${input.spaceId ?? null})
      AND g.target_id IN (
        SELECT space_id FROM space_memberships WHERE user_id = ${who.userId}
        UNION SELECT space_id FROM spaces WHERE personal_owner_user_id = ${who.userId}
      )
    `).pipe(Effect.catch(storage("read your Space's loans")));
    const { grants } = yield* summaries(rows, who);
    const known = yield* targetsOf(rows);
    // Waiting ones only for whoever decides; active ones for whoever works there; ended ones, the
    // history, for whoever runs the Space (Grants ticket 13: not its Members).
    return {
      grants: grants.filter((grant, index) => {
        const row = rows[index];
        const target = row?.targetId == null ? undefined : known.get(row.targetId as SpaceId);
        if (row === undefined || target === undefined) return false;
        const action =
          grant.state === "pending"
            ? "grant.decide"
            : grant.state === "ended"
              ? "grant.return"
              : "grant.viewReceived";
        return AccessPolicy.isAllowed(
          AccessPolicy.decide(who.principal, action, resourceOf(row, target.resource, known)),
        );
      }),
    };
  });

  const targets = Effect.fn("Grants.targets")(function* (input: GrantTargetsInput) {
    const who = yield* caller;
    const item = yield* lendable(input.resource, who);
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
    return { needsStrongFactor: giveNeedsFactor(checked.item.kind, checked.startsActive) };
  });

  const give = Effect.fn("Grants.give")(function* (input: GrantGiveInput, proof: FactorProof) {
    const who = yield* caller;
    const grantId = yield* newId;
    yield* inTransaction(
      "lend it",
      Effect.gen(function* () {
        // Checked again in the transaction: a membership or the machine may have changed.
        const { item, startsActive } = yield* checkGive(input, who);
        if (giveNeedsFactor(item.kind, startsActive) && !proof.strongFactor) {
          return yield* fail(
            "strong-factor-required",
            item.kind === "vault-group"
              ? "Lending a Vault group needs a passkey or authenticator code: its Secrets reach the borrower's agents."
              : "Lending a machine where you also accept it needs a passkey or authenticator code.",
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
              : item.kind === "ai-account"
                ? "This AI account is already lent to that Space."
                : "This Vault group is already lent to that Space.",
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
        // Lent to an Organization a migrated allowance reached: that review is settled.
        if (item.kind === "ai-account") {
          yield* sql`
            DELETE FROM ai_account_grant_reviews
            WHERE account_id = ${item.resourceId} AND space_id = ${input.spaceId}
          `;
        }
        if (item.kind === "vault-group") {
          yield* sql`
            DELETE FROM vault_group_grant_reviews
            WHERE group_id = ${item.resourceId} AND space_id = ${input.spaceId}
          `;
        }
        if (startsActive && input.resource.kind === "environment") {
          yield* registry.openLentSandbox({
            grantId,
            hostEnvironmentId: input.resource.environmentId,
            spaceId: input.spaceId,
          });
        }
        if (startsActive && item.kind === "vault-group") {
          yield* vaultGroupActive({
            vaultId: item.resourceId,
            vaultName: item.name,
            spaceId: input.spaceId,
            useAsDefault: input.useAsDefault === true,
            by: who.userId,
            via: "grant.give",
          });
        }
        const record = auditOf(
          {
            grantId,
            resourceKind: item.kind,
            resourceId: item.resourceId,
            lenderKind: item.lenderKind,
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
    return { needsStrongFactor: decidingNeedsFactor(row.resourceKind) };
  });

  /**
   * Deciding for the destination makes the loan active there: a machine's needs the decider's
   * strong factor, whether they accept it or apply its link (Grants ticket 15).
   */
  const decidingNeedsFactor = (kind: GrantResourceKind) => kind === "environment";
  const requireDecidersFactor = (kind: GrantResourceKind, proof: FactorProof) =>
    decidingNeedsFactor(kind) && !proof.strongFactor
      ? fail("strong-factor-required", "Accepting a machine needs a passkey or authenticator code.")
      : Effect.void;

  /**
   * In the transaction that made the loan active in `spaceId` (accepting it or applying its
   * link): a machine runs a Sandbox for the Space, an Environment of its own; a Vault group's
   * rows from before go, and it may become the Space's last default. A failure undoes it all.
   */
  const madeActive = Effect.fn("Grants.madeActive")(function* (
    row: GrantRow,
    spaceId: string,
    by: UserId,
    choice: DefaultChoice,
  ) {
    if (row.resourceKind === "environment") {
      yield* registry.openLentSandbox({
        grantId: row.grantId,
        hostEnvironmentId: EnvironmentId.make(row.resourceId),
        spaceId: SpaceId.make(spaceId),
      });
    }
    if (row.resourceKind === "vault-group") {
      yield* vaultGroupActive({
        vaultId: row.resourceId,
        vaultName: row.resourceName,
        spaceId,
        useAsDefault: choice.useAsDefault === true,
        by,
        via: "grant.accept",
      });
    }
  });

  /** A decision by the destination: accept or reject. */
  const decideOn = Effect.fn("Grants.decideOn")(function* (
    op: "accept" | "reject",
    input: GrantRefInput & DefaultChoice,
    proof: FactorProof,
  ) {
    const who = yield* caller;
    yield* inTransaction(
      op === "accept" ? "accept the loan" : "reject the loan",
      Effect.gen(function* () {
        const { row, resource } = yield* visibleRow(input.grantId, who);
        if (!mayTransition(op, row.state)) return yield* illegal(op, row.state);
        yield* denied(AccessPolicy.decide(who.principal, "grant.decide", resource));
        if (op === "accept") yield* requireDecidersFactor(row.resourceKind, proof);
        const at = yield* now;
        const to = TRANSITIONS[op].to ?? row.state;
        yield* move(
          row.grantId,
          row.state,
          sql`state = ${to}, decided_at = ${at}, decided_by = ${who.userId}`,
        );
        if (op === "accept" && row.targetId !== null) {
          yield* madeActive(row, row.targetId, who.userId, input);
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
  const accept = Effect.fn("Grants.accept")(function* (
    input: GrantRefInput & DefaultChoice,
    proof: FactorProof,
  ) {
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
        if (row.state === "offered" && row.offerExpiresAt !== null && row.offerExpiresAt <= at) {
          return yield* fail("illegal-transition", "This lending link expired already.");
        }
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
    // An AI account's: a session holding a direct credential through it closes (the gateway
    // refuses the next request of any other anyway).
    if (Option.isSome(accountChanges)) yield* accountChanges.value.changed;
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
    // A Vault group's: the Space's default of it and its Projects' choices go with the loan.
    if (row.resourceKind === "vault-group" && row.targetId !== null) {
      yield* VaultReachLoss.forgetLentReach(sql, actorOf, {
        vaultId: row.resourceId,
        spaceId: row.targetId,
      });
    }
    return closed;
  });

  const setLimits = Effect.fn("Grants.setLimits")(function* (input: GrantSetLimitsInput) {
    const who = yield* caller;
    if (input.limits.kind === "vault-group") {
      return yield* fail("invalid-limits", "A Vault group's loan has no limits to change.");
    }
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

  // Grants ticket 06: lending links.

  /** The lender's side of a link, which names no destination (see `policyResourceOf`). */
  const offerResource = (lender: AccessPolicy.GrantLender, who: Caller) =>
    ({ kind: "grant", lender, target: principalSpace(who) }) satisfies AccessPolicy.GrantResource;

  // SHA-256 of 32 random bytes: looking the hash up leaks nothing about the token through timing.
  const hashToken = (token: string) =>
    digest.digestHex(Digest.sha256, new TextEncoder().encode(token));

  const createOffer = Effect.fn("Grants.createOffer")(function* (input: GrantCreateOfferInput) {
    const who = yield* caller;
    // A Vault group's loan needs its lender's strong factor at giving (Grants ticket 07), which a
    // link skips. A machine's is asked of whoever applies its link (Grants ticket 15).
    if (input.resource.kind === "vault-group") {
      return yield* fail(
        "not-lendable",
        "A Vault group is not lent by link: lend it to a Space you work in.",
      );
    }
    const grantId = yield* newId;
    const token = Buffer.from(yield* random.randomBytes(32)).toString("base64url");
    const tokenHash = yield* hashToken(token);
    yield* inTransaction(
      "make the lending link",
      Effect.gen(function* () {
        const item = yield* lendable(input.resource, who);
        yield* denied(
          AccessPolicy.decide(who.principal, "grant.offer", offerResource(item.lender, who)),
        );
        const problem = limitsProblem(item.kind, input.limits);
        if (problem !== undefined) return yield* fail("invalid-limits", problem);
        if (item.kind === "environment") yield* hostReady(item.resourceId);
        // Its Vault groups go to a Space first, with their own warning: no link skips that.
        if (item.kind === "space-mcp" && (item.references ?? []).length > 0) {
          return yield* fail(
            "not-lendable",
            "An MCP server that uses Vault entries is not lent by link: lend it to a Space you work in, after its Vault groups.",
          );
        }
        const current = yield* DateTime.now;
        const at = DateTime.formatIso(current);
        const open = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM grants
          WHERE resource_kind = ${item.kind} AND resource_id = ${item.resourceId}
            AND state = 'offered' AND offer_expires_at > ${at}
        `;
        if ((open[0]?.n ?? 0) >= GRANT_OPEN_OFFERS_PER_RESOURCE) {
          return yield* fail(
            "too-many-offers",
            `This ${item.kind === "environment" ? "machine" : "AI account"} has ${GRANT_OPEN_OFFERS_PER_RESOURCE} open lending links already. Cancel one or wait until one is used or expires.`,
          );
        }
        const expiresAt = DateTime.formatIso(
          DateTime.add(current, {
            milliseconds: Duration.toMillis(Duration.days(GRANT_OFFER_DAYS)),
          }),
        );
        const limitsJson = yield* encodeLimits(input.limits);
        yield* sql`
          INSERT INTO grants (
            grant_id, resource_kind, resource_id, lender_kind, lender_id, target_kind, target_id,
            state, limits_json, offer_token_hash, offer_expires_at, created_at, created_by
          ) VALUES (
            ${grantId}, ${item.kind}, ${item.resourceId}, ${item.lenderKind}, ${item.lenderId},
            'space', NULL, 'offered', ${limitsJson}, ${tokenHash}, ${expiresAt}, ${at},
            ${who.userId}
          )
        `;
        const record = auditOf(
          {
            grantId,
            resourceKind: item.kind,
            resourceId: item.resourceId,
            lenderKind: item.lenderKind,
            lenderId: item.lenderId,
            targetId: null,
          },
          item.name,
        );
        yield* audit.record({
          actor: AuditLog.userActor(who.userId),
          action: "grant.offer",
          spaceId: record.spaceId,
          target: record.target,
          detail: {
            resourceKind: item.kind,
            resourceId: item.resourceId,
            resourceName: item.name,
            lenderId: item.lenderId,
            expiresAt,
            ...limitsDetail(input.limits),
          },
        });
      }),
    );
    const grant = yield* reread(grantId, who);
    // In the fragment: browsers never send it, so no request, log or Referer carries it.
    const path = `/grants/offer#token=${token}`;
    const origin = yield* publicHubUrl.publicHubOrigin;
    return {
      grant,
      path,
      url: Option.match(origin, {
        onNone: () => null,
        onSome: (base) => new URL(path, base).href,
      }),
    } satisfies GrantCreatedOffer;
  });

  const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

  /**
   * The open link behind a token, with what it lends as it is now; none when it is unknown,
   * used, cancelled or expired, or its lender could no longer lend it. An unknown token counts
   * against the caller; applying a dead link counts against it; reading one, against nobody.
   */
  const liveOffer = Effect.fn("Grants.liveOffer")(function* (
    token: string,
    who: Caller,
    mode: "read" | "claim",
  ) {
    const tokenHash = yield* hashToken(token);
    const userKey = `grant-offer-user:${who.userId}`;
    const linkKey = `grant-offer:${tokenHash}`;
    const nowMs = yield* nowMillis;
    const lockedUntil = linkThrottle.lockedUntil([userKey, linkKey], nowMs);
    if (lockedUntil !== undefined) {
      return yield* fail(
        "throttled",
        `Too many lending links that did not work. Try again in ${Math.ceil((lockedUntil - nowMs) / 1000)} seconds.`,
      );
    }
    const [row] = yield* selectGrants(sql`g.offer_token_hash = ${tokenHash}`).pipe(
      Effect.catch(storage("read the lending link")),
    );
    if (row === undefined) {
      linkThrottle.recordFailure([userKey], nowMs);
      return Option.none();
    }
    const at = yield* now;
    const dead = () => {
      if (mode === "claim") linkThrottle.recordFailure([linkKey], nowMs);
      return Option.none();
    };
    if (row.state !== "offered" || row.offerExpiresAt === null || row.offerExpiresAt <= at) {
      return dead();
    }
    // What it lends must still be the lender's and lendable, by the same rules as giving it.
    const lendableNow: Effect.Effect<Lendable, GrantError> =
      row.resourceKind === "environment"
        ? lendableEnvironment(row.resourceId)
        : row.resourceKind === "ai-account"
          ? lendableAiAccount(row.resourceId)
          : lendableVaultGroup(row.resourceId);
    const item = yield* Effect.option(lendableNow);
    if (
      Option.isNone(item) ||
      item.value.lenderKind !== row.lenderKind ||
      item.value.lenderId !== row.lenderId
    ) {
      return dead();
    }
    // Whoever made it must still be able to lend it: an Admin who no longer runs the
    // Organization, or a User turned off, leaves a dead link.
    if (row.createdBy === null) return dead();
    const maker = yield* spaces.principalOf(row.createdBy as UserId).pipe(Effect.option);
    if (
      Option.isNone(maker) ||
      !AccessPolicy.isAllowed(
        AccessPolicy.decide(
          maker.value,
          "grant.offer",
          offerResource(item.value.lender, {
            userId: row.createdBy as UserId,
            principal: maker.value,
          }),
        ),
      )
    ) {
      return dead();
    }
    return Option.some({ row, item: item.value });
  });

  /** Whether `target` is the lender's own Space (what it owns already serves it there). */
  const isLendersOwn = (row: GrantRow, target: AccessPolicy.SpaceResource) =>
    row.lenderKind === "user"
      ? target.kind === "personal" && target.personalOwnerUserId === row.lenderId
      : target.id === row.lenderId;

  const readOffer = Effect.fn("Grants.readOffer")(function* (input: GrantReadOfferInput) {
    const who = yield* caller;
    const found = yield* liveOffer(input.token, who, "read");
    if (Option.isNone(found)) return { status: "invalid" } satisfies GrantOfferPreview;
    const { row, item } = found.value;
    const limits = yield* decodeLimits(row.limitsJson).pipe(
      Effect.catch(storage("read the loan's limits")),
    );
    // The Spaces the reader decides in: their Personal space and the Organizations they run.
    const ids = yield* sql<{ readonly spaceId: string }>`
      SELECT s.space_id AS "spaceId" FROM spaces s
      WHERE s.archived_at IS NULL AND s.frozen_at IS NULL AND (
        (s.kind = 'personal' AND s.personal_owner_user_id = ${who.userId})
        OR (s.kind = 'organization' AND EXISTS (
          SELECT 1 FROM space_memberships m
          WHERE m.space_id = s.space_id AND m.user_id = ${who.userId} AND m.role = 'admin'))
      )
      ORDER BY s.kind, s.name
    `.pipe(Effect.catch(storage("read your Spaces")));
    const rows = ids.map((entry) => ({ targetId: entry.spaceId }));
    const known = yield* targetsOf(rows);
    const owners = yield* personalOwnersOf(rows);
    const lentTo = yield* sql<{ readonly targetId: string }>`
      SELECT target_id AS "targetId" FROM grants
      WHERE resource_kind = ${row.resourceKind} AND resource_id = ${row.resourceId}
        AND target_kind = 'space' AND state IN ('pending', 'active')
    `.pipe(Effect.catch(storage("read the loan")));
    const taken = new Set(lentTo.map((entry) => entry.targetId));
    return {
      status: "valid",
      resource: {
        kind: row.resourceKind,
        name: item.name,
        ...(row.aiProvider !== null && row.aiType !== null
          ? { aiAccount: { provider: row.aiProvider, type: row.aiType } }
          : {}),
      },
      lender: { kind: row.lenderKind, name: row.lenderName },
      limits,
      expiresAt: row.offerExpiresAt ?? "",
      spaces: ids.flatMap((entry) => {
        const target = known.get(entry.spaceId as SpaceId);
        if (target === undefined || isLendersOwn(row, target.resource)) return [];
        const decides = AccessPolicy.isAllowed(
          AccessPolicy.decide(who.principal, "grant.decide", {
            kind: "grant",
            lender: item.lender,
            target: target.resource,
          }),
        );
        if (!decides) return [];
        return [
          {
            spaceId: target.resource.id,
            kind: target.resource.kind,
            name: target.name,
            ...ownerNameOf(owners, target.resource.id),
            alreadyGranted: taken.has(target.resource.id),
          },
        ];
      }),
    } satisfies GrantOfferPreview;
  });

  const NOT_YOUR_SPACE = "You can apply a lending link only to a Space where you decide on loans.";

  /** Everything applying a link checks, but the move itself: the destination's rule, as accepting. */
  const checkClaim = Effect.fn("Grants.checkClaim")(function* (
    input: GrantClaimOfferInput,
    who: Caller,
  ) {
    const found = yield* liveOffer(input.token, who, "claim");
    if (Option.isNone(found)) return yield* fail("not-found", DEAD_LINK);
    const { row, item } = found.value;
    // A Space that does not exist answers like one the caller does not decide in.
    const known = yield* targetsOf([{ targetId: input.spaceId }]);
    const target = known.get(input.spaceId);
    if (target === undefined) return yield* fail("not-allowed", NOT_YOUR_SPACE);
    if (isLendersOwn(row, target.resource)) {
      return yield* fail("not-allowed", DENIED["wrong-resource"] ?? NOT_YOUR_SPACE);
    }
    // Applying it is accepting it: the destination's rule, as for any loan.
    const decision = AccessPolicy.decide(who.principal, "grant.decide", {
      kind: "grant",
      lender: item.lender,
      target: target.resource,
    });
    if (decision._tag === "Deny") {
      return yield* fail(
        "not-allowed",
        decision.reason === "space-archived" || decision.reason === "space-frozen"
          ? (DENIED[decision.reason] ?? NOT_YOUR_SPACE)
          : NOT_YOUR_SPACE,
      );
    }
    const live = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM grants
      WHERE resource_kind = ${row.resourceKind} AND resource_id = ${row.resourceId}
        AND target_kind = 'space' AND target_id = ${input.spaceId}
        AND state IN ('pending', 'active')
    `.pipe(Effect.catch(storage("read the loan")));
    if ((live[0]?.n ?? 0) > 0) {
      return yield* fail(
        "already-granted",
        row.resourceKind === "environment"
          ? "This machine is already lent to that Space."
          : "This AI account is already lent to that Space.",
      );
    }
    if (row.resourceKind === "environment") yield* hostReady(row.resourceId);
    return { row, item };
  });

  const prepareClaim = Effect.fn("Grants.prepareClaim")(function* (input: GrantClaimOfferInput) {
    const who = yield* caller;
    const { row } = yield* checkClaim(input, who);
    return { needsStrongFactor: decidingNeedsFactor(row.resourceKind) };
  });

  const claimOffer = Effect.fn("Grants.claimOffer")(function* (
    input: GrantClaimOfferInput,
    proof: FactorProof = { strongFactor: false },
  ) {
    const who = yield* caller;
    const grantId = yield* inTransaction(
      "apply the lending link",
      Effect.gen(function* () {
        const { row, item } = yield* checkClaim(input, who);
        // As accepting: a machine's needs the decider's strong factor, after the rules above.
        yield* requireDecidersFactor(row.resourceKind, proof);
        const at = yield* now;
        // Only while still open: two people applying it at once, one gets it.
        const moved = yield* sql<{ readonly grantId: string }>`
          UPDATE grants SET state = 'active', target_kind = 'space', target_id = ${input.spaceId},
            decided_at = ${at}, decided_by = ${who.userId}
          WHERE grant_id = ${row.grantId} AND state = 'offered' AND offer_expires_at > ${at}
          RETURNING grant_id AS "grantId"
        `;
        if (moved.length === 0) return yield* fail("not-found", DEAD_LINK);
        // Lent to an Organization a migrated allowance reached: that review is settled.
        if (row.resourceKind === "ai-account") {
          yield* sql`
            DELETE FROM ai_account_grant_reviews
            WHERE account_id = ${row.resourceId} AND space_id = ${input.spaceId}
          `;
        }
        // As accepting it: a machine's Sandbox opens in this transaction.
        yield* madeActive(row, input.spaceId, who.userId, {});
        const record = auditOf({ ...row, targetId: input.spaceId }, item.name);
        yield* audit.record({
          actor: AuditLog.userActor(who.userId),
          action: "grant.accept",
          spaceId: record.spaceId,
          target: record.target,
          detail: { ...record.common, via: "link" },
        });
        return GrantId.make(row.grantId);
      }),
    );
    // Who may use the account changed: live processes are checked again.
    if (Option.isSome(accountChanges)) yield* accountChanges.value.changed;
    return yield* reread(grantId, who);
  });

  const ownerOnly = Effect.gen(function* () {
    const who = yield* caller;
    if (!who.principal.isOwner) {
      return yield* fail("not-allowed", "Only the Owner reviews the loans the upgrade narrowed.");
    }
    return who;
  });

  const migrationReviews = Effect.gen(function* () {
    const who = yield* ownerOnly;
    const rows = yield* sql<{
      readonly aiAccountId: string;
      readonly aiAccountName: string;
      readonly provider: AiAccountProvider;
      readonly lenderKind: "user" | "organization";
      readonly lenderId: string;
      readonly userId: string;
      readonly userName: string;
      readonly spaceId: string;
      readonly spaceName: string;
      readonly usedRecently: number;
    }>`
      SELECT r.account_id AS "aiAccountId", a.name AS "aiAccountName", a.provider AS "provider",
        a.owner_kind AS "lenderKind", a.owner_id AS "lenderId", r.user_id AS "userId",
        u.display_name AS "userName", r.space_id AS "spaceId", s.name AS "spaceName",
        r.used_recently AS "usedRecently"
      FROM ai_account_grant_reviews r
      JOIN ai_accounts a ON a.account_id = r.account_id AND a.deleted_at IS NULL
      JOIN users u ON u.user_id = r.user_id
      JOIN spaces s ON s.space_id = r.space_id
      ORDER BY a.name, u.display_name, s.name
    `.pipe(Effect.catch(storage("read the loans to review")));
    // Grants ticket 07: the Owner's named Vault groups an allowance «to a User» reached there.
    const groupRows = yield* sql<{
      readonly vaultGroupId: string;
      readonly vaultGroupName: string;
      readonly lenderKind: "user" | "organization";
      readonly lenderId: string;
      readonly userId: string;
      readonly userName: string;
      readonly spaceId: string;
    }>`
      SELECT r.group_id AS "vaultGroupId", v.name AS "vaultGroupName",
        v.owner_kind AS "lenderKind", v.owner_id AS "lenderId", r.user_id AS "userId",
        u.display_name AS "userName", r.space_id AS "spaceId"
      FROM vault_group_grant_reviews r
      JOIN vault_groups v ON v.group_id = r.group_id
      JOIN users u ON u.user_id = r.user_id
      JOIN spaces s ON s.space_id = r.space_id
      ORDER BY v.name, u.display_name, s.name
    `.pipe(Effect.catch(storage("read the loans to review")));
    const known = yield* targetsOf([
      ...rows.map((row) => ({ targetId: row.spaceId })),
      ...groupRows.map((row) => ({ targetId: row.spaceId })),
    ]);
    const startsActive = (
      row: { readonly lenderKind: "user" | "organization"; readonly lenderId: string },
      target: AccessPolicy.SpaceResource,
    ) =>
      AccessPolicy.isAllowed(
        AccessPolicy.decide(who.principal, "grant.decide", {
          kind: "grant",
          lender: lenderOf(row, known),
          target,
        }),
      );
    return {
      vaultGroups: groupRows.flatMap((row) => {
        const target = known.get(row.spaceId as SpaceId);
        if (target === undefined) return [];
        return [
          {
            vaultGroupId: VaultGroupId.make(row.vaultGroupId),
            vaultGroupName: row.vaultGroupName,
            userId: row.userId as UserId,
            userName: row.userName,
            spaceId: target.resource.id,
            spaceName: target.name,
            startsActive: startsActive(row, target.resource),
          },
        ];
      }),
      reviews: rows.flatMap((row) => {
        const target = known.get(row.spaceId as SpaceId);
        if (target === undefined) return [];
        return [
          {
            aiAccountId: row.aiAccountId as AiAccountId,
            aiAccountName: row.aiAccountName,
            provider: row.provider,
            userId: row.userId as UserId,
            userName: row.userName,
            spaceId: target.resource.id,
            spaceName: target.name,
            usedRecently: row.usedRecently === 1,
            startsActive: startsActive(row, target.resource),
          },
        ];
      }),
    } satisfies GrantMigrationReviews;
  });

  const dismissMigrationReview = Effect.fn("Grants.dismissMigrationReview")(function* (
    input: GrantDismissMigrationReviewInput,
  ) {
    yield* ownerOnly;
    yield* (
      "vaultGroupId" in input
        ? sql`
          DELETE FROM vault_group_grant_reviews
          WHERE group_id = ${input.vaultGroupId} AND user_id = ${input.userId}
            AND space_id = ${input.spaceId}
        `
        : sql`
          DELETE FROM ai_account_grant_reviews
          WHERE account_id = ${input.aiAccountId} AND user_id = ${input.userId}
            AND space_id = ${input.spaceId}
        `
    ).pipe(Effect.catch(storage("dismiss it")));
    return yield* migrationReviews;
  });

  return Grants.of({
    migrationReviews,
    dismissMigrationReview,
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
    createOffer,
    readOffer,
    prepareClaim,
    claimOffer,
    vaultUsage,
  });
});

export const layer = Layer.effect(Grants, make);
