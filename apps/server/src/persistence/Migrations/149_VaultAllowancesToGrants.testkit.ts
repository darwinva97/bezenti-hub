/**
 * Grants ticket 07: a Hub at migration 148 with every kind of Vault allowance that migration 149
 * converts, and what each User's turns receive in each Space (EffectiveVaults): the groups, and
 * which group wins each name.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, SpaceId, ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as SpaceDirectory from "../../spaces/SpaceDirectory.ts";
import * as EffectiveVaults from "../../vaults/EffectiveVaults.ts";

const AT = "2026-11-01T00:00:00.000Z";

const USERS = ["owner", "ana", "bob", "dan"] as const;
/** Each Space, with the Projects asked about there (none: Threads without one). */
const PLACES: ReadonlyArray<readonly [string, string | null]> = [
  ["personal:owner", null],
  ["personal:ana", null],
  ["personal:bob", null],
  ["personal:dan", null],
  ["org-acme", null],
  ["org-acme", "p-acme"],
  ["org-globex", null],
  ["org-initech", null],
];

/**
 * Every kind of allowance: on the Owner's named groups to Spaces (open, archived, the Owner's own,
 * gone) and to Users (Ana, Bob, the Owner, removed, unknown); on an archived group; on a
 * `default` and on Ana's group (both ignored). Ana works in Acme and (Guest) Globex, Bob runs Acme
 * and works in Initech (archived), Dan is disabled.
 */
export const seedBefore149 = Effect.gen(function* () {
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
  const group = (
    id: string,
    owner: readonly [string, string],
    options: { readonly isDefault?: boolean; readonly archived?: boolean } = {},
  ) => sql`
    INSERT INTO vault_groups (group_id, owner_kind, owner_id, name, is_default, archived_at,
      created_at, updated_at)
    VALUES (${id}, ${owner[0]}, ${owner[1]}, ${options.isDefault === true ? "default" : id},
      ${options.isDefault === true ? 1 : 0}, ${options.archived === true ? AT : null}, ${AT}, ${AT})
  `;
  yield* group("owner-default", ["user", "owner"], { isDefault: true });
  yield* group("ana-default", ["user", "ana"], { isDefault: true });
  yield* group("bob-default", ["user", "bob"], { isDefault: true });
  yield* group("acme-default", ["organization", "org-acme"], { isDefault: true });
  yield* group("globex-default", ["organization", "org-globex"], { isDefault: true });
  yield* group("o-shared", ["user", "owner"]);
  yield* group("o-user", ["user", "owner"]);
  yield* group("o-multi", ["user", "owner"]);
  yield* group("o-archived", ["user", "owner"], { archived: true });
  yield* group("ana-keys", ["user", "ana"]);
  yield* group("acme-keys", ["organization", "org-acme"]);
  // Each group holds a name of its own and some shared ones, so precedence shows.
  const entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["owner-default", ["OWNER_DEFAULT", "SHARED_NAME"]],
    ["ana-default", ["ANA_DEFAULT", "USER_NAME"]],
    ["bob-default", ["BOB_DEFAULT"]],
    ["acme-default", ["ACME_DEFAULT", "SHARED_NAME"]],
    ["globex-default", ["GLOBEX_DEFAULT"]],
    ["o-shared", ["O_SHARED", "SHARED_NAME"]],
    ["o-user", ["O_USER", "USER_NAME", "SHARED_NAME"]],
    ["o-multi", ["O_MULTI", "SHARED_NAME"]],
    ["o-archived", ["O_ARCHIVED"]],
    ["ana-keys", ["ANA_KEYS"]],
    ["acme-keys", ["ACME_KEYS", "SHARED_NAME"]],
  ];
  for (const [groupId, names] of entries) {
    for (const name of names) {
      yield* sql`
        INSERT INTO vault_entries (entry_id, group_id, name, kind, value_id, class, created_at,
          updated_at)
        VALUES (${`${groupId}-${name}`}, ${groupId}, ${name}, 'own', ${`value-${groupId}-${name}`},
          'secret', ${AT}, ${AT})
      `;
    }
  }
  const allow = (groupId: string, kind: "space" | "user", subject: string) => sql`
    INSERT INTO vault_allowances (group_id, subject_kind, subject_id, created_at)
    VALUES (${groupId}, ${kind}, ${subject}, ${AT})
  `;
  yield* allow("o-shared", "space", "org-acme");
  yield* allow("o-shared", "space", "org-initech");
  yield* allow("o-shared", "space", "personal:owner");
  yield* allow("o-shared", "space", "org-gone");
  yield* allow("o-user", "user", "ana");
  yield* allow("o-user", "user", "bob");
  yield* allow("o-user", "user", "owner");
  yield* allow("o-user", "user", "cara");
  yield* allow("o-user", "user", "ghost");
  yield* allow("o-multi", "space", "org-acme");
  yield* allow("o-multi", "user", "ana");
  yield* allow("o-multi", "space", "personal:ana");
  yield* allow("o-archived", "space", "org-acme");
  yield* allow("ana-keys", "space", "org-globex");
  yield* allow("owner-default", "space", "org-globex");
  // Acme's chosen defaults and a Project there that adds and removes.
  yield* sql`
    INSERT INTO space_default_vaults (space_id, group_id, position) VALUES
      ('org-acme', 'o-multi', 0), ('org-acme', 'o-shared', 1), ('personal:ana', 'o-multi', 0)
  `;
  yield* sql`
    INSERT INTO project_vault_choices (project_id, group_id, choice) VALUES
      ('p-acme', 'acme-keys', 'add'), ('p-acme', 'o-multi', 'remove')
  `;
});

const layerEffective = (sql: SqlClient.SqlClient) =>
  EffectiveVaults.layer.pipe(
    Layer.provide(SpaceDirectory.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "vault-grants-149-" })),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
  );

/** What one User's turns receive in one place: the groups, and which group wins each name. */
export interface Received {
  readonly vaults: ReadonlyArray<string>;
  /** Each group's side: `user` (allowed to the User), `project` or `space`. */
  readonly sources: Readonly<Record<string, string>>;
  readonly winners: Readonly<Record<string, string>>;
}

/** `user|space|project` → what that User's turns receive there, or a refusal's reason. */
export const effectiveSets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const effective = yield* EffectiveVaults.EffectiveVaults.pipe(
    Effect.provide(layerEffective(sql)),
  );
  const sets: Record<string, Received | string> = {};
  for (const user of USERS) {
    for (const [space, project] of PLACES) {
      const key = `${user}|${space}|${project ?? "-"}`;
      sets[key] = yield* effective
        .forPlacement({
          threadId: ThreadId.make(`t-${key}`),
          spaceId: SpaceId.make(space),
          projectId: project === null ? null : ProjectId.make(project),
          actingUserId: UserId.make(user),
        })
        .pipe(
          Effect.map((set): Received => ({
            vaults: set.vaults.map((vault) => vault.vaultId),
            sources: Object.fromEntries(set.vaults.map((vault) => [vault.vaultId, vault.source])),
            winners: Object.fromEntries(
              set.variables.map((variable) => [variable.name, variable.vaultId]),
            ),
          })),
          Effect.catchTags({ VaultError: (error) => Effect.succeed(error.reason) }),
        );
    }
  }
  return sets;
}).pipe(Effect.scoped);
