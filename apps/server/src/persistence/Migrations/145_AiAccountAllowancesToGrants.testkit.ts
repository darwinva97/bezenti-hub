// @effect-diagnostics globalDate:off - migration 145 reads SQLite's clock (the real one), so does its seed.
/**
 * Grants ticket 02: a Hub at migration 144 with every kind of AI account allowance that migration
 * 145 converts, and the AI accounts each User may use in each Space (AllowedAiAccounts), in order.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SpaceId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as AllowedAiAccounts from "../../ai/AllowedAiAccounts.ts";
import * as ServerConfig from "../../config.ts";
import * as SpaceDirectory from "../../spaces/SpaceDirectory.ts";

const AT = "2026-11-01T00:00:00.000Z";
/** Within the review window of 90 days, and outside it (the migration reads the clock). */
const RECENT = new Date(Date.now() - 5 * 86_400_000).toISOString();
const LONG_AGO = "2020-01-01T00:00:00.000Z";

const USERS = ["owner", "ana", "bob", "dan"] as const;
const SPACES = [
  "personal:owner",
  "personal:ana",
  "personal:bob",
  "personal:dan",
  "org-acme",
  "org-globex",
  "org-initech",
] as const;

/**
 * Every kind of allowance: to Spaces (open, archived, the Owner's own, gone), to Users (Ana, Bob,
 * the Owner, removed, unknown), on disabled, deleted, direct and others' accounts. Ana works in
 * Acme and (Guest) Globex, Bob runs Acme, Dan is disabled, Initech archived.
 */
export const seedBefore145 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO users (user_id, display_name, is_owner, created_at) VALUES
      ('owner', 'Owner', 1, ${AT}), ('ana', 'Ana', 0, ${AT}), ('bob', 'Bob', 0, ${AT}),
      ('dan', 'Dan', 0, ${AT}), ('cara', 'Cara', 0, ${AT})
  `;
  yield* sql`UPDATE users SET disabled_at = ${AT} WHERE user_id = 'dan'`;
  yield* sql`UPDATE users SET removed_at = ${AT}, disabled_at = ${AT} WHERE user_id = 'cara'`;
  yield* sql`
    INSERT OR IGNORE INTO spaces (space_id, kind, name, personal_owner_user_id, created_at) VALUES
      ('personal:owner', 'personal', 'Personal', 'owner', ${AT}),
      ('personal:ana', 'personal', 'Personal', 'ana', ${AT}),
      ('personal:bob', 'personal', 'Personal', 'bob', ${AT}),
      ('personal:dan', 'personal', 'Personal', 'dan', ${AT}),
      ('personal:cara', 'personal', 'Personal', 'cara', ${AT})
  `;
  yield* sql`
    INSERT INTO spaces (space_id, kind, name, created_at) VALUES
      ('org-acme', 'organization', 'Acme', ${AT}),
      ('org-globex', 'organization', 'Globex', ${AT}),
      ('org-initech', 'organization', 'Initech', ${AT})
  `;
  yield* sql`UPDATE spaces SET archived_at = ${AT} WHERE space_id = 'org-initech'`;
  yield* sql`
    INSERT INTO space_memberships (space_id, user_id, role, created_at) VALUES
      ('org-acme', 'owner', 'admin', ${AT}), ('org-acme', 'bob', 'admin', ${AT}),
      ('org-acme', 'ana', 'member', ${AT}), ('org-globex', 'ana', 'guest', ${AT}),
      ('org-globex', 'dan', 'member', ${AT}), ('org-initech', 'bob', 'member', ${AT})
  `;
  const account = (
    id: string,
    type: string,
    priority: number,
    owner: readonly [string, string] = ["user", "owner"],
  ) => sql`
    INSERT INTO ai_accounts (account_id, name, type, provider, priority, status, created_at,
      updated_at, owner_kind, owner_id)
    VALUES (${id}, ${id}, ${type}, 'claude', ${priority}, 'working', ${AT}, ${AT}, ${owner[0]},
      ${owner[1]})
  `;
  yield* account("o-claude", "api-key", 1);
  yield* account("o-codex", "subscription", 2);
  yield* account("o-direct", "direct", 3);
  yield* account("o-disabled", "api-key", 4);
  yield* account("o-deleted", "api-key", 5);
  yield* account("ana-own", "api-key", 1, ["user", "ana"]);
  yield* account("acme-own", "api-key", 1, ["organization", "org-acme"]);
  yield* sql`UPDATE ai_accounts SET disabled = 1 WHERE account_id = 'o-disabled'`;
  yield* sql`UPDATE ai_accounts SET deleted_at = ${AT} WHERE account_id = 'o-deleted'`;
  const allow = (accountId: string, kind: "space" | "user", subject: string) => sql`
    INSERT INTO ai_account_allowances (account_id, subject_kind, subject_id, created_at)
    VALUES (${accountId}, ${kind}, ${subject}, ${AT})
  `;
  yield* allow("o-claude", "space", "org-acme");
  yield* allow("o-claude", "space", "personal:owner");
  yield* allow("o-claude", "space", "org-gone");
  yield* allow("o-claude", "user", "ana");
  yield* allow("o-claude", "user", "owner");
  yield* allow("o-claude", "user", "cara");
  yield* allow("o-claude", "user", "ghost");
  yield* allow("o-codex", "space", "org-globex");
  yield* allow("o-codex", "space", "org-initech");
  yield* allow("o-codex", "user", "bob");
  yield* allow("o-direct", "space", "org-acme");
  yield* allow("o-direct", "user", "ana");
  yield* allow("o-disabled", "space", "org-globex");
  yield* allow("o-deleted", "space", "org-acme");
  yield* allow("ana-own", "space", "org-globex");
  const used = (accountId: string, userId: string, spaceId: string, at: string) => sql`
    INSERT INTO ai_usage (usage_id, at, day, user_id, space_id, thread_id, key_id, account_id,
      provider, model, shape, status, duration_ms, failovers)
    VALUES (${`u-${accountId}-${userId}-${spaceId}`}, ${at}, ${at.slice(0, 10)}, ${userId},
      ${spaceId}, NULL, 'key', ${accountId}, 'claude', 'm', 'anthropic', 200, 1, 0)
  `;
  yield* used("o-claude", "ana", "org-globex", RECENT);
  yield* used("o-codex", "bob", "org-acme", LONG_AGO);
});

const layerAllowed = (sql: SqlClient.SqlClient) =>
  AllowedAiAccounts.layer.pipe(
    Layer.provide(SpaceDirectory.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ai-grants-145-" })),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
  );

/** `user|space` → the AI accounts that User may use there, in AllowedAiAccounts' order. */
export const usableSets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const allowed = yield* AllowedAiAccounts.AllowedAiAccounts.pipe(
    Effect.provide(layerAllowed(sql)),
  );
  const sets: Record<string, ReadonlyArray<string>> = {};
  for (const user of USERS) {
    for (const space of SPACES) {
      const accounts = yield* allowed.for(UserId.make(user), SpaceId.make(space));
      sets[`${user}|${space}`] = accounts.map((account) => account.id);
    }
  }
  return sets;
}).pipe(Effect.scoped);
