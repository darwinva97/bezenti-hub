import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
// Captured from EffectiveVaults before owned-resources 03, on the same Hub (the testkit's).
import GOLDEN from "./142_VaultGroups.golden.json" with { type: "json" };
import { effectiveSets, seedBefore142 } from "./142_VaultGroups.testkit.ts";

/** Grace's Thread in acme-web, whose Project removes vault-tools. */
const GRACE_WEB = "t-acme-grace-web";

const rows = (list: ReadonlyArray<Record<string, unknown>>) =>
  list.map((row) => Object.values(row).join("|"));

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("makes a Vault per owner of groups, converting links and copies", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 141 });
    yield* seedBefore142;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 142 }), [[142, "VaultGroups"]]);

    assert.deepEqual(
      rows(
        yield* sql`
        SELECT group_id, owner_kind, owner_id, name, is_default FROM vault_groups
        WHERE group_id NOT LIKE 'vault-default-%' ORDER BY group_id
      `,
      ),
      [
        "vault-acme-a|organization|org-acme|Acme A|0",
        "vault-acme-b|organization|org-acme|Acme B|0",
        "vault-globex|organization|org-globex|Globex keys|0",
        "vault-main|user|owner|default|1",
        "vault-old-default|user|owner|default (old)|0",
        "vault-tools|user|owner|Tools|0",
      ],
    );
    // Each Organization gets an empty `default`; the Owner's is the Main vault.
    assert.deepEqual(
      rows(
        yield* sql`
        SELECT owner_id, name, (SELECT COUNT(*) FROM vault_entries e WHERE e.group_id = g.group_id)
        FROM vault_groups g WHERE g.group_id LIKE 'vault-default-%' ORDER BY owner_id
      `,
      ),
      ["org-acme|default|0", "org-globex|default|0"],
    );
    // Links and copies are own Secrets now; a live link holds its original's value id (until the
    // Hub's start gives it its own copy) and class; the broken one is gone.
    assert.deepEqual(
      rows(
        yield* sql`
        SELECT entry_id, kind, class, delivery, value_id FROM vault_entries
        WHERE group_id = 'vault-acme-a' ORDER BY entry_id
      `,
      ),
      [
        "a-gh-copy|own|secret|env|value-a-gh-copy",
        "a-gh-link|own|secret|env|value-m-gh",
        "a-key|own|secret|env|value-a-key",
        "a-prov|provider|secret|env|",
        "a-region-link|own|variable|file|value-m-region",
        "a-shared|own|secret|env|value-a-shared",
      ],
    );
    assert.deepEqual(
      rows(yield* sql`SELECT kind, COUNT(*) FROM vault_entries GROUP BY kind ORDER BY kind`),
      ["identity|1", "own|16", "provider|2", "template|1"],
    );
    // Every row that named a Vault names its group, unchanged.
    assert.deepEqual(
      rows(
        yield* sql`
        SELECT group_id, subject_kind, subject_id FROM vault_allowances ORDER BY 1, 2, 3
      `,
      ),
      [
        "vault-old-default|space|org-globex",
        "vault-tools|space|org-acme",
        "vault-tools|user|grace",
      ],
    );
    assert.deepEqual(
      rows(yield* sql`SELECT space_id, group_id, position FROM space_default_vaults ORDER BY 1, 3`),
      [
        "org-acme|vault-acme-a|0",
        "org-acme|vault-tools|1",
        "org-globex|vault-globex|0",
        "org-globex|vault-old-default|1",
      ],
    );
    assert.deepEqual(
      rows(yield* sql`SELECT project_id, group_id, choice FROM project_vault_choices ORDER BY 2`),
      ["acme-web|vault-acme-b|add", "acme-web|vault-tools|remove"],
    );
    assert.deepEqual(rows(yield* sql`SELECT group_id, scope_id FROM vault_provider_scopes`), [
      "vault-acme-a|scope-acme",
    ]);
    // The Owner's one-time notice, and the audit: names, never values.
    assert.deepEqual(
      rows(
        yield* sql`
        SELECT entry_id, group_id, name, original_name FROM vault_unlinked_notices ORDER BY 1
      `,
      ),
      ["a-gh-link|vault-acme-a|GH_LINK|GH_TOKEN", "a-region-link|vault-acme-a|REGION_LINK|REGION"],
    );
    assert.deepEqual(
      rows(
        yield* sql`
        SELECT target_id, json_extract(detail_json, '$.op'), json_extract(detail_json, '$.from'),
          actor_source, space_id
        FROM audit_log WHERE action = 'secret.edit' ORDER BY target_id
      `,
      ),
      [
        "a-broken-link|delete|broken-link|system|org-acme",
        "a-gh-copy|unlinked|copy|system|org-acme",
        "a-gh-link|unlinked|link|system|org-acme",
        "a-region-link|unlinked|link|system|org-acme",
      ],
    );
    const tables = rows(yield* sql`SELECT name FROM sqlite_master WHERE name = 'vaults'`);
    assert.deepEqual(tables, []);
  }).pipe(Effect.provide(layer)),
);

it.effect("every Thread receives the same set as before, files and Provider entries included", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 141 });
    yield* seedBefore142;
    yield* runMigrations({ toMigrationInclusive: 142 });
    // Today's EffectiveVaults reads what later tickets added (Keycloak sign-in, Makita) and
    // reaches an Owner's group through Grants (149): it reads the database migrated to today.
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const defaults = new Set(
      (yield* sql<{ readonly groupId: string }>`
        SELECT group_id AS "groupId" FROM vault_groups WHERE group_id LIKE 'vault-default-%'
      `).map((row) => `${row.groupId}:space`),
    );
    const after = (yield* effectiveSets) as Record<
      string,
      { readonly vaults: ReadonlyArray<string>; readonly variables: unknown }
    >;
    // The differences: new, empty `default` groups among those drawn from, and (Grants ticket 07,
    // its own test's PROJECT_REMOVES) acme-web's remove now holds for the group Grace had by
    // allowance, so its Thread loses vault-tools and the names it won.
    const withoutNewDefaults = Object.fromEntries(
      Object.entries(after).map(([threadId, set]) => [
        threadId,
        { vaults: set.vaults.filter((vault) => !defaults.has(vault)), variables: set.variables },
      ]),
    );
    const golden = GOLDEN as Record<string, { readonly vaults: ReadonlyArray<string> }>;
    const { [GRACE_WEB]: graceWeb, ...rest } = withoutNewDefaults;
    const { [GRACE_WEB]: graceWebBefore, ...restBefore } = golden;
    assert.deepStrictEqual(rest, restBefore);
    assert.deepStrictEqual(
      graceWeb?.vaults,
      graceWebBefore?.vaults.filter((vault) => vault !== "vault-tools:user"),
    );
    assert.isTrue(
      after["t-acme-ada"]?.vaults.some((vault) => defaults.has(vault)) === true,
      "Acme's default is a fixed default of Acme",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("a Hub with no Owner yet loses its empty Main vault and keeps the rest", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 141 });
    yield* sql`
      INSERT INTO vaults (vault_id, name, space_id, is_main, created_at, updated_at)
      VALUES ('vault-main', 'Main vault', NULL, 1, '2026-11-01', '2026-11-01')
    `;
    yield* runMigrations({ toMigrationInclusive: 142 });
    assert.deepEqual(rows(yield* sql`SELECT group_id FROM vault_groups`), []);
  }).pipe(Effect.provide(layer)),
);
