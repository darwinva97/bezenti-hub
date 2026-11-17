/**
 * Owned-resources 03: a Hub at migration 141 with every kind of Vault row that migration 142
 * converts, and what each test Thread's turns receive, as names and value ids (never values).
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as SpaceDirectory from "../../spaces/SpaceDirectory.ts";
import * as EffectiveVaults from "../../vaults/EffectiveVaults.ts";

const AT = "2026-11-01T00:00:00.000Z";

/** The Threads compared, each with whoever starts its turn (its owner). */
const THREADS = [
  ["t-owner-personal", "owner"],
  ["t-acme-grace-web", "grace"],
  ["t-acme-ada", "ada"],
  ["t-globex-gus", "gus"],
  ["t-ana-personal", "ana"],
] as const;

/**
 * The Owner's Main vault (a Secret, a Variable, a file, the originals of the links, a Provider
 * entry, a template and an identity entry); «Tools», the Owner's, allowed to Acme and to Grace;
 * «Default», the Owner's, allowed to Globex; two Vaults of Acme with defaults, a Project's
 * choices, a live link to a Secret and one to a Variable, a broken link and a copy; Globex's.
 */
export const seedBefore142 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO users (user_id, display_name, is_owner, created_at) VALUES
      ('owner', 'Owner', 1, ${AT}), ('ada', 'Ada', 0, ${AT}), ('grace', 'Grace', 0, ${AT}),
      ('gus', 'Gus', 0, ${AT}), ('ana', 'Ana', 0, ${AT})
  `;
  yield* sql`
    INSERT OR IGNORE INTO spaces (space_id, kind, name, personal_owner_user_id, created_at) VALUES
      ('org-acme', 'organization', 'Acme', NULL, ${AT}),
      ('org-globex', 'organization', 'Globex', NULL, ${AT}),
      ('personal:owner', 'personal', 'Owner', 'owner', ${AT}),
      ('personal:ada', 'personal', 'Ada', 'ada', ${AT}),
      ('personal:grace', 'personal', 'Grace', 'grace', ${AT}),
      ('personal:gus', 'personal', 'Gus', 'gus', ${AT}),
      ('personal:ana', 'personal', 'Ana', 'ana', ${AT})
  `;
  yield* sql`
    INSERT INTO space_memberships (space_id, user_id, role, created_at) VALUES
      ('org-acme', 'ada', 'admin', ${AT}), ('org-acme', 'grace', 'member', ${AT}),
      ('org-globex', 'gus', 'admin', ${AT})
  `;
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at,
      updated_at, space_id, owner_user_id)
    VALUES ('acme-web', 'acme-web', '/w/acme-web', '[]', ${AT}, ${AT}, 'org-acme', 'ada')
  `;
  const thread = (id: string, owner: string, spaceId: string, projectId: string) => sql`
    INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
      default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json,
      space_id, owner_user_id)
    VALUES (${id}, ${projectId}, ${id}, 'codex', 'full-access', 'default', ${AT}, ${AT}, '{}',
      ${spaceId}, ${owner})
  `;
  yield* thread("t-owner-personal", "owner", "personal:owner", "project:none");
  yield* thread("t-acme-grace-web", "grace", "org-acme", "acme-web");
  yield* thread("t-acme-ada", "ada", "org-acme", "project:none");
  yield* thread("t-globex-gus", "gus", "org-globex", "project:none");
  yield* thread("t-ana-personal", "ana", "personal:ana", "project:none");

  const vault = (id: string, name: string, spaceId: string | null, isMain = 0, position = 0) => sql`
    INSERT INTO vaults (vault_id, name, space_id, is_main, position, created_at, updated_at)
    VALUES (${id}, ${name}, ${spaceId}, ${isMain}, ${position}, ${AT}, ${AT})
  `;
  yield* vault("vault-main", "Main vault", null, 1);
  yield* vault("vault-tools", "Tools", null, 0, 1);
  yield* vault("vault-old-default", "Default", null, 0, 2);
  yield* vault("vault-acme-a", "Acme A", "org-acme");
  yield* vault("vault-acme-b", "Acme B", "org-acme");
  yield* vault("vault-globex", "Globex keys", "org-globex");

  const own = (
    id: string,
    vaultId: string,
    name: string,
    entryClass: "secret" | "variable",
    delivery: "env" | "file" | "none" = "env",
  ) => sql`
    INSERT INTO vault_entries (entry_id, vault_id, name, kind, value_id, class, revealable,
      delivery, created_at, updated_at)
    VALUES (${id}, ${vaultId}, ${name}, 'own', ${`value-${id}`}, ${entryClass}, 0, ${delivery},
      ${AT}, ${AT})
  `;
  yield* own("m-secret", "vault-main", "M_SECRET", "secret");
  yield* own("m-var", "vault-main", "M_VAR", "variable");
  yield* own("m-file", "vault-main", "M_FILE", "secret", "file");
  yield* own("m-gh", "vault-main", "GH_TOKEN", "secret");
  yield* own("m-region", "vault-main", "REGION", "variable");
  yield* sql`
    INSERT INTO vault_entries (entry_id, vault_id, name, kind, class, revealable, provider_id,
      provider_reference, delivery, created_at, updated_at)
    VALUES ('m-prov', 'vault-main', 'M_PROV', 'provider', 'secret', 0, 'op', 'op://hub/kube/token',
      'env', ${AT}, ${AT})
  `;
  yield* sql`
    INSERT INTO vault_entries (entry_id, vault_id, name, kind, class, revealable, template_text,
      delivery, created_at, updated_at)
    VALUES ('m-tpl', 'vault-main', 'M_TPL', 'template', 'secret', 0,
      'url={{ M_VAR }}&key={{ M_SECRET }}&ca={{ M_FILE | path }}', 'file', ${AT}, ${AT})
  `;
  yield* sql`
    INSERT INTO vault_entries (entry_id, vault_id, name, kind, class, revealable,
      identity_audience, identity_ttl_seconds, delivery, created_at, updated_at)
    VALUES ('m-id', 'vault-main', 'M_ID', 'identity', 'secret', 0, 'kubernetes', 600, 'file',
      ${AT}, ${AT})
  `;
  yield* own("t-key", "vault-tools", "T_KEY", "secret");
  yield* own("t-shared", "vault-tools", "SHARED", "secret");
  yield* own("d-key", "vault-old-default", "D_KEY", "secret");
  yield* own("a-key", "vault-acme-a", "A_KEY", "secret");
  yield* own("a-shared", "vault-acme-a", "SHARED", "secret");
  yield* own("b-shared", "vault-acme-b", "SHARED", "secret");
  yield* own("b-file", "vault-acme-b", "B_FILE", "secret", "file");
  yield* own("g-key", "vault-globex", "G_KEY", "secret");
  const link = (id: string, vaultId: string, name: string, original: string, delivery = "env") =>
    sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, linked_entry_id, class,
        revealable, delivery, created_at, updated_at)
      VALUES (${id}, ${vaultId}, ${name}, 'link', ${original}, NULL, NULL, ${delivery}, ${AT},
        ${AT})
    `;
  yield* link("a-gh-link", "vault-acme-a", "GH_LINK", "m-gh");
  yield* link("a-region-link", "vault-acme-a", "REGION_LINK", "m-region", "file");
  yield* link("a-broken-link", "vault-acme-a", "BROKEN_LINK", "m-gone");
  yield* sql`
    INSERT INTO vault_entries (entry_id, vault_id, name, kind, value_id, class, revealable,
      created_at, updated_at)
    VALUES ('a-gh-copy', 'vault-acme-a', 'GH_COPY', 'copy', 'value-a-gh-copy', 'secret', 0,
      ${AT}, ${AT})
  `;
  // A Provider entry of Acme's through a scope allowed to its Vault.
  yield* sql`
    INSERT INTO secret_provider_scopes (scope_id, provider_id, label, allowed_paths_json,
      created_at, updated_at)
    VALUES ('scope-acme', 'op', 'Acme', '["op://acme/"]', ${AT}, ${AT})
  `;
  yield* sql`
    INSERT INTO vault_provider_scopes (vault_id, scope_id, created_at)
    VALUES ('vault-acme-a', 'scope-acme', ${AT})
  `;
  yield* sql`
    INSERT INTO vault_entries (entry_id, vault_id, name, kind, class, revealable, provider_id,
      provider_reference, provider_scope_id, delivery, created_at, updated_at)
    VALUES ('a-prov', 'vault-acme-a', 'A_PROV', 'provider', 'secret', 0, 'op',
      'op://acme/db/password', 'scope-acme', 'env', ${AT}, ${AT})
  `;

  yield* sql`
    INSERT INTO vault_allowances (vault_id, subject_kind, subject_id, created_at) VALUES
      ('vault-tools', 'space', 'org-acme', ${AT}), ('vault-tools', 'user', 'grace', ${AT}),
      ('vault-old-default', 'space', 'org-globex', ${AT})
  `;
  yield* sql`
    INSERT INTO space_default_vaults (space_id, vault_id, position) VALUES
      ('org-acme', 'vault-acme-a', 0), ('org-acme', 'vault-tools', 1),
      ('org-globex', 'vault-globex', 0), ('org-globex', 'vault-old-default', 1)
  `;
  yield* sql`
    INSERT INTO project_vault_choices (project_id, vault_id, choice) VALUES
      ('acme-web', 'vault-acme-b', 'add'), ('acme-web', 'vault-tools', 'remove')
  `;
});

/** EffectiveVaults over the database the test holds, as the Hub builds it. */
const layerEffective = (sql: SqlClient.SqlClient) =>
  EffectiveVaults.layer.pipe(
    Layer.provide(SpaceDirectory.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "vault-groups-142-" })),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
  );

/**
 * What each Thread's turn receives: per variable its name, the Vault (group) id that wins it,
 * where from, class, delivery, value id or where its value comes from, and whom it beat. Names
 * of Vaults are left out (the Main vault is now called `default`).
 */
export const effectiveSets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const effective = yield* EffectiveVaults.EffectiveVaults.pipe(
    Effect.provide(layerEffective(sql)),
  );
  const sets: Record<string, unknown> = {};
  for (const [threadId, owner] of THREADS) {
    const set = yield* effective.forThread({
      threadId: ThreadId.make(threadId),
      actingUserId: UserId.make(owner),
    });
    sets[threadId] = {
      vaults: set.vaults.map((vault) => `${vault.vaultId}:${vault.source}`),
      variables: set.variables.map((variable) => ({
        name: variable.name,
        vaultId: variable.vaultId,
        source: variable.source,
        class: variable.class,
        delivery: variable.delivery,
        unmasked: variable.unmasked,
        valueId: variable.valueId,
        provider: variable.provider,
        identity: variable.identity ?? null,
        template:
          variable.template === null
            ? null
            : {
                text: variable.template.text,
                inputs: variable.template.inputs.map((input) => ({
                  name: input.name,
                  valueId: input.valueId,
                  class: input.class,
                  file: input.file,
                })),
              },
        shadowed: variable.shadowed.map((lost) => `${lost.vaultId}:${lost.source}`),
      })),
    };
  }
  return sets;
}).pipe(Effect.scoped);
