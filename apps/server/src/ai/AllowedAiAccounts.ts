/**
 * The one rule of which AI accounts a User may use in a Space: the Space owner's enabled accounts,
 * then those lent to the Space by an active Grant (grants tickets 01–02; the Owner's allowances
 * became Grants); none unless the User may work there (`aiAccount.use`). Never cached; the
 * gateway, picker, default, failover and move plan ask here.
 */
import {
  type AiAccountId,
  AiAccountGrantLimits,
  type AiAccountProvider,
  type AiAccountType,
  type GrantId,
  type ResourceOwner,
  type SpaceId,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";

/**
 * An AI account a User may use in a Space, in the rule's order: the Space owner's first, by their
 * priority, then those lent to it (oldest Grant first, then the lender's priority). Callers keep
 * this order.
 */
export interface AllowedAiAccount {
  readonly id: AiAccountId;
  readonly name: string;
  readonly type: AiAccountType;
  readonly provider: AiAccountProvider;
  /** Among its owner's accounts only. */
  readonly priority: number;
  readonly owner: ResourceOwner;
  /** Why it is usable here: the Space's own, or lent to it by a Grant (with its caps). */
  readonly via: AllowedVia;
}

export type AllowedVia =
  | { readonly kind: "own" }
  | {
      readonly kind: "grant";
      readonly grantId: GrantId;
      /** The lending User's display name, or the lending Organization's name. */
      readonly lenderName: string;
      readonly limits: AiAccountGrantLimits;
    };

const OWN: AllowedVia = { kind: "own" };
const decodeCaps = Schema.decodeUnknownOption(Schema.fromJsonString(AiAccountGrantLimits));

export class AllowedAiAccountsError extends Schema.TaggedError<AllowedAiAccountsError>()(
  "AllowedAiAccountsError",
  { message: Schema.String },
) {}

export class AllowedAiAccounts extends Context.Service<
  AllowedAiAccounts,
  {
    /** `AllowedAiAccounts.for(userId, spaceId)`: empty when the User does not work there. */
    readonly for: (
      userId: UserId,
      spaceId: SpaceId,
    ) => Effect.Effect<ReadonlyArray<AllowedAiAccount>, AllowedAiAccountsError>;
    /**
     * Which of these Spaces the User may work in (AccessPolicy `aiAccount.use`), with their names:
     * the condition of every answer here, for whoever must apply the same rule (gateway keys).
     */
    readonly workingSpaces: (
      userId: UserId,
      spaceIds: ReadonlyArray<SpaceId>,
    ) => Effect.Effect<ReadonlyMap<SpaceId, { readonly name: string }>, AllowedAiAccountsError>;
    /**
     * `for`, saying also whether the User works in the Space at all (the gateway's one check of
     * a request: no access and no allowance are different refusals).
     */
    readonly accessIn: (
      userId: UserId,
      spaceId: SpaceId,
    ) => Effect.Effect<
      { readonly works: boolean; readonly accounts: ReadonlyArray<AllowedAiAccount> },
      AllowedAiAccountsError
    >;
    /** The same rule for several Spaces at once, one answer per Space asked about. */
    readonly forSpaces: (
      userId: UserId,
      spaceIds: ReadonlyArray<SpaceId>,
    ) => Effect.Effect<
      ReadonlyMap<SpaceId, ReadonlyArray<AllowedAiAccount>>,
      AllowedAiAccountsError
    >;
  }
>()("t3/ai/AllowedAiAccounts") {}

interface AccountRow {
  readonly accountId: string;
  readonly name: string;
  readonly type: AiAccountType;
  readonly provider: AiAccountProvider;
  readonly priority: number;
  readonly ownerKind: "user" | "organization";
  readonly ownerId: string;
}

interface LentRow extends AccountRow {
  readonly grantId: string;
  readonly targetId: string;
  readonly lenderName: string | null;
  readonly limitsJson: string;
}

/** Whose a Space's own accounts are: its User's (a Personal space) or its Organization's. */
const ownerOfSpace = (
  resource: AccessPolicy.SpaceResource,
): { readonly kind: "user" | "organization"; readonly id: string } | undefined =>
  resource.kind === "personal"
    ? resource.personalOwnerUserId === null
      ? undefined
      : { kind: "user", id: resource.personalOwnerUserId }
    : { kind: "organization", id: resource.id };

const toAllowed = (row: AccountRow, via: AllowedVia = OWN): AllowedAiAccount => ({
  id: row.accountId as AiAccountId,
  name: row.name,
  type: row.type,
  provider: row.provider,
  priority: row.priority,
  owner:
    row.ownerKind === "user"
      ? { kind: "user", userId: row.ownerId as UserId }
      : { kind: "organization", spaceId: row.ownerId as SpaceId },
  via,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;

  const failed = (what: string) => (cause: unknown) =>
    Effect.logError(`AllowedAiAccounts: could not ${what}`, { cause }).pipe(
      Effect.andThen(Effect.fail(new AllowedAiAccountsError({ message: `Could not ${what}.` }))),
    );

  const workingSpaces = Effect.fn("AllowedAiAccounts.workingSpaces")(function* (
    userId: UserId,
    spaceIds: ReadonlyArray<SpaceId>,
  ) {
    const working = new Map<
      SpaceId,
      { readonly name: string; readonly resource: AccessPolicy.SpaceResource }
    >();
    const asked = [...new Set(spaceIds)];
    if (asked.length === 0) return working;
    const principal = yield* spaces
      .principalOf(userId)
      .pipe(Effect.catch(failed("read who the User is")));
    const known = yield* spaces.spacesById(asked).pipe(Effect.catch(failed("read the Spaces")));
    for (const spaceId of asked) {
      const space = known.get(spaceId);
      if (
        space !== undefined &&
        AccessPolicy.isAllowed(AccessPolicy.decide(principal, "aiAccount.use", space.resource))
      ) {
        working.set(spaceId, { name: space.name, resource: space.resource });
      }
    }
    return working;
  });

  const forSpaces = Effect.fn("AllowedAiAccounts.forSpaces")(function* (
    userId: UserId,
    spaceIds: ReadonlyArray<SpaceId>,
  ) {
    const answer = new Map<SpaceId, ReadonlyArray<AllowedAiAccount>>();
    const asked = [...new Set(spaceIds)];
    for (const spaceId of asked) answer.set(spaceId, []);
    // Only the Spaces the User works in: elsewhere nothing, not even what is allowed to them.
    const working = yield* workingSpaces(userId, asked);
    for (const [spaceId, accounts] of yield* accountsIn(working)) {
      answer.set(spaceId, accounts);
    }
    return answer;
  });

  /**
   * For each of these Spaces (all worked in): its owner's enabled accounts, then those an active
   * Grant lends to it.
   */
  const accountsIn = Effect.fn("AllowedAiAccounts.accountsIn")(function* (
    working: ReadonlyMap<SpaceId, { readonly resource: AccessPolicy.SpaceResource }>,
  ) {
    const answer = new Map<SpaceId, ReadonlyArray<AllowedAiAccount>>();
    if (working.size === 0) return answer;
    const spaceIds = [...working.keys()];
    const owners = spaceIds.flatMap((spaceId) => {
      const owner = ownerOfSpace(working.get(spaceId)!.resource);
      return owner === undefined ? [] : [owner];
    });
    const ownRows =
      owners.length === 0
        ? []
        : yield* sql<AccountRow>`
            SELECT account_id AS "accountId", name AS "name", type AS "type",
              provider AS "provider", priority AS "priority", owner_kind AS "ownerKind",
              owner_id AS "ownerId"
            FROM ai_accounts
            WHERE disabled = 0 AND deleted_at IS NULL AND ${sql.or(
              owners.map((owner) => sql`(owner_kind = ${owner.kind} AND owner_id = ${owner.id})`),
            )}
            ORDER BY priority, account_id
          `.pipe(Effect.catch(failed("read the AI accounts")));
    // Lent by an active Grant whose lender still owns the account and may still lend: a disabled
    // or removed User, an archived, frozen or gone Organization lends nothing meanwhile.
    const lentRows = yield* sql<LentRow>`
      SELECT a.account_id AS "accountId", a.name AS "name", a.type AS "type",
        a.provider AS "provider", a.priority AS "priority", a.owner_kind AS "ownerKind",
        a.owner_id AS "ownerId", g.grant_id AS "grantId", g.target_id AS "targetId",
        g.limits_json AS "limitsJson",
        CASE g.lender_kind
          WHEN 'user' THEN (SELECT display_name FROM users WHERE user_id = g.lender_id)
          ELSE (SELECT name FROM spaces WHERE space_id = g.lender_id) END AS "lenderName"
      FROM grants g
      JOIN ai_accounts a ON a.account_id = g.resource_id
      WHERE g.resource_kind = 'ai-account' AND g.state = 'active' AND g.target_kind = 'space'
        AND ${sql.in("g.target_id", spaceIds)}
        AND a.disabled = 0 AND a.deleted_at IS NULL
        AND a.owner_kind = g.lender_kind AND a.owner_id = g.lender_id
        AND (g.lender_kind <> 'user' OR EXISTS (
          SELECT 1 FROM users u WHERE u.user_id = g.lender_id
            AND u.disabled_at IS NULL AND u.removed_at IS NULL))
        AND (g.lender_kind <> 'organization' OR EXISTS (
          SELECT 1 FROM spaces s WHERE s.space_id = g.lender_id AND s.kind = 'organization'
            AND s.archived_at IS NULL AND s.frozen_at IS NULL))
      ORDER BY g.decided_at, a.priority, a.account_id
    `.pipe(Effect.catch(failed("read the AI accounts lent")));

    for (const [spaceId, { resource }] of working) {
      const owner = ownerOfSpace(resource);
      const seen = new Set<string>();
      const accounts: Array<AllowedAiAccount> = [];
      for (const row of ownRows) {
        if (owner === undefined || row.ownerKind !== owner.kind || row.ownerId !== owner.id) {
          continue;
        }
        seen.add(row.accountId);
        accounts.push(toAllowed(row));
      }
      for (const row of lentRows) {
        if (row.targetId !== spaceId || seen.has(row.accountId)) continue;
        // Caps that cannot be read lend nothing: never an uncapped loan by mistake.
        const limits = decodeCaps(row.limitsJson);
        if (Option.isNone(limits)) continue;
        seen.add(row.accountId);
        accounts.push(
          toAllowed(row, {
            kind: "grant",
            grantId: row.grantId as GrantId,
            lenderName: row.lenderName ?? "",
            limits: limits.value,
          }),
        );
      }

      answer.set(spaceId, accounts);
    }
    return answer;
  });

  const accessIn = Effect.fn("AllowedAiAccounts.accessIn")(function* (
    userId: UserId,
    spaceId: SpaceId,
  ) {
    const working = yield* workingSpaces(userId, [spaceId]);
    const works = working.has(spaceId);
    if (!works) return { works, accounts: [] as ReadonlyArray<AllowedAiAccount> };
    const accounts = (yield* accountsIn(working)).get(spaceId) ?? [];
    return { works, accounts };
  });

  return AllowedAiAccounts.of({
    for: Effect.fn("AllowedAiAccounts.for")(function* (userId: UserId, spaceId: SpaceId) {
      const answer = yield* forSpaces(userId, [spaceId]);
      return answer.get(spaceId) ?? [];
    }),
    forSpaces,
    accessIn,
    workingSpaces,
  });
});

export const layer = Layer.effect(AllowedAiAccounts, make);
