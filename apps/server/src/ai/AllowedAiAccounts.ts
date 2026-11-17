/**
 * The one rule of which AI accounts a User may use in a Space: the Space owner's enabled accounts,
 * then the Owner's own allowed to the Space or the User; none unless the User may work there
 * (`aiAccount.use`). Never cached; the gateway, picker, default, failover and move plan ask here.
 */
import type {
  AiAccountId,
  AiAccountProvider,
  AiAccountType,
  ResourceOwner,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";

/**
 * An AI account a User may use in a Space, in the rule's order: the Space owner's first, by their
 * priority, then the Owner's allowed ones, by the Owner's. Callers keep this order.
 */
export interface AllowedAiAccount {
  readonly id: AiAccountId;
  readonly name: string;
  readonly type: AiAccountType;
  readonly provider: AiAccountProvider;
  /** Among its owner's accounts only. */
  readonly priority: number;
  readonly owner: ResourceOwner;
}

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

interface AllowedRow extends AccountRow {
  readonly subjectKind: "space" | "user";
  readonly subjectId: string;
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

const toAllowed = (row: AccountRow): AllowedAiAccount => ({
  id: row.accountId as AiAccountId,
  name: row.name,
  type: row.type,
  provider: row.provider,
  priority: row.priority,
  owner:
    row.ownerKind === "user"
      ? { kind: "user", userId: row.ownerId as UserId }
      : { kind: "organization", spaceId: row.ownerId as SpaceId },
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
    for (const [spaceId, accounts] of yield* accountsIn(userId, working)) {
      answer.set(spaceId, accounts);
    }
    return answer;
  });

  /**
   * For each of these Spaces (all worked in): its owner's enabled accounts, then the Owner's own
   * allowed to it or to the User. Allowances on anyone else's account are never read.
   */
  const accountsIn = Effect.fn("AllowedAiAccounts.accountsIn")(function* (
    userId: UserId,
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
    const allowedRows = yield* sql<AllowedRow>`
      SELECT a.account_id AS "accountId", a.name AS "name", a.type AS "type",
        a.provider AS "provider", a.priority AS "priority", a.owner_kind AS "ownerKind",
        a.owner_id AS "ownerId", l.subject_kind AS "subjectKind", l.subject_id AS "subjectId"
      FROM ai_accounts a
      JOIN ai_account_allowances l ON l.account_id = a.account_id
      WHERE a.disabled = 0 AND a.deleted_at IS NULL
        AND a.owner_kind = 'user'
        AND a.owner_id = (SELECT user_id FROM users WHERE is_owner = 1)
        AND (
          (l.subject_kind = 'user' AND l.subject_id = ${userId})
          OR (l.subject_kind = 'space' AND ${sql.in("l.subject_id", spaceIds)})
        )
      ORDER BY a.priority, a.account_id
    `.pipe(Effect.catch(failed("read the AI accounts")));
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
      for (const row of allowedRows) {
        const applies =
          row.subjectKind === "user" ? row.subjectId === userId : row.subjectId === spaceId;
        if (!applies || seen.has(row.accountId)) continue;
        seen.add(row.accountId);
        accounts.push(toAllowed(row));
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
    const accounts = (yield* accountsIn(userId, working)).get(spaceId) ?? [];
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
