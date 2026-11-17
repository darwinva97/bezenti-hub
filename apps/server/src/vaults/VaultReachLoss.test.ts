/**
 * Spec 5 ticket 07, «Bajas»: an Organization deleted takes its own Vaults, their values and every
 * row that names it; a User removed from the Installation loses the Vaults allowed to them. What
 * is delivered needs no row to go (EffectiveVaults recomputes it); these keep nothing behind.
 */
import { ProjectId, SpaceId, UserId, type VaultError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { SqlError } from "effect/sql/SqlError";

import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as InstallationUserService from "../spaces/InstallationUserService.ts";
import * as OrganizationLifecycle from "../spaces/OrganizationLifecycle.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { orgOwner, userOwner } from "./VaultGroups.testkit.ts";
import * as Vaults from "./Vaults.ts";

const hub = Effect.gen(function* () {
  const server = yield* serveAuthHttp;
  const { created } = yield* bootstrapOwner(server, yield* makeAuthenticator());
  const owner = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const organization = Effect.fn(function* (name: string) {
    const made = yield* server.request("/api/spaces/organizations", {
      body: { name },
      cookie: owner,
    });
    return SpaceId.make(made.body.id as string);
  });
  const acmeId = yield* organization("Acme");
  const globexId = yield* organization("Globex");
  const vaults = Context.get(server.services, Vaults.Vaults);
  const values = Context.get(server.services, ServerSecretStore.VaultValueStore);
  const asOwner = CommandActor.actAs(ownerId);
  const vault = Effect.fn(function* (
    name: string,
    spaceId: SpaceId | null,
    secrets: ReadonlyArray<readonly [string, string]>,
  ) {
    const made = yield* vaults
      .create({ name, owner: spaceId === null ? userOwner(ownerId) : orgOwner(spaceId) })
      .pipe(asOwner);
    for (const [variable, value] of secrets) {
      yield* vaults
        .putEntry({ vaultId: made.id, name: variable, value: Redacted.make(value) })
        .pipe(asOwner);
    }
    return made.id;
  });
  const project = Effect.fn(function* (id: string, spaceId: SpaceId) {
    const made = yield* server.request("/api/projects/mutate", {
      cookie: owner,
      body: {
        type: "project.create",
        commandId: `create-${id}`,
        projectId: id,
        title: id,
        workspaceRoot: server.newProjectFolder(id),
        spaceId,
      },
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return ProjectId.make(id);
  });
  const count = (query: Effect.Effect<ReadonlyArray<{ readonly n: number }>, SqlError>) =>
    query.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
      Effect.orDie,
    );
  return {
    server,
    owner,
    ownerId,
    acmeId,
    globexId,
    vaults,
    values,
    asOwner,
    vault,
    project,
    count,
  };
});

it.effect("deleting an Organization deletes its Vaults, their values and every row naming it", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const sql = h.server.sql;
    const acmeVault = yield* h.vault("Acme keys", h.acmeId, [
      ["ACME_TOKEN", "acme-token-value-0001"],
      ["ACME_DEPLOY", "acme-deploy-value-0002"],
    ]);
    const globexVault = yield* h.vault("Globex keys", h.globexId, [
      ["GLOBEX_TOKEN", "globex-token-value-0003"],
    ]);
    // One of the Owner's, allowed to both Organizations: it stays, without Acme.
    const shared = yield* h.vault("Shared tools", null, [["SHARED", "shared-value-00004"]]);
    for (const spaceId of [h.acmeId, h.globexId]) {
      yield* h.vaults
        .allow({ vaultId: shared, subject: { kind: "space", spaceId }, allowed: true })
        .pipe(h.asOwner);
    }
    yield* h.vaults
      .setSpaceDefaults({ spaceId: h.acmeId, vaultIds: [acmeVault, shared] })
      .pipe(h.asOwner);
    const web = yield* h.project("acme-web", h.acmeId);
    yield* h.vaults
      .setProjectChoice({ projectId: web, vaultId: acmeVault, choice: "remove" })
      .pipe(h.asOwner);
    const acmeValues = (yield* sql<{ readonly valueId: string }>`
        SELECT value_id AS "valueId" FROM vault_entries WHERE group_id = ${acmeVault}
      `).map((row) => row.valueId);
    assert.lengthOf(acmeValues, 2);

    const lifecycle = Context.get(h.server.services, OrganizationLifecycle.OrganizationLifecycle);
    yield* lifecycle.archive(h.ownerId, h.acmeId);
    yield* lifecycle.delete(h.ownerId, h.acmeId);

    assert.equal(
      yield* h.count(sql`
        SELECT COUNT(*) AS n FROM vault_groups
        WHERE owner_kind = 'organization' AND owner_id = ${h.acmeId}
      `),
      0,
    );
    assert.equal(
      yield* h.count(sql`SELECT COUNT(*) AS n FROM vault_entries WHERE group_id = ${acmeVault}`),
      0,
    );
    assert.equal(
      yield* h.count(sql`
          SELECT COUNT(*) AS n FROM vault_allowances
          WHERE group_id = ${acmeVault} OR (subject_kind = 'space' AND subject_id = ${h.acmeId})
        `),
      0,
    );
    assert.equal(
      yield* h.count(
        sql`SELECT COUNT(*) AS n FROM space_default_vaults WHERE space_id = ${h.acmeId}`,
      ),
      0,
    );
    assert.equal(
      yield* h.count(
        sql`SELECT COUNT(*) AS n FROM project_vault_choices WHERE project_id = ${web}`,
      ),
      0,
    );
    const stored = new Set(yield* h.values.list);
    for (const valueId of acmeValues) {
      assert.isFalse(stored.has(valueId), "no value of Acme's is left in the store");
    }
    // The Owner's Vault and Globex's own stay as they were, Globex's allowance included.
    assert.deepEqual(
      (yield* sql<{ readonly vaultId: string }>`
          SELECT group_id AS "vaultId" FROM vault_groups WHERE group_id IN (${shared}, ${globexVault})
          ORDER BY name
        `).map((row) => row.vaultId),
      [globexVault, shared],
    );
    assert.equal(
      yield* h.count(sql`
          SELECT COUNT(*) AS n FROM vault_allowances
          WHERE group_id = ${shared} AND subject_kind = 'space' AND subject_id = ${h.globexId}
        `),
      1,
    );
    // Recorded without a value.
    const audited = yield* sql<{ readonly targetName: string; readonly detail: string }>`
        SELECT target_name AS "targetName", detail_json AS "detail" FROM audit_log
        WHERE action = 'vault_group.delete' ORDER BY target_name
      `;
    // Its named group; its `default` held nothing, so it goes unrecorded.
    assert.deepEqual(
      audited.map((row) => row.targetName),
      ["Acme keys"],
    );
    assert.notInclude(audited[0]?.detail ?? "", "acme-token-value");
    // The Owner's Vault lost Acme: recorded as taken back from it.
    const takenBack = yield* sql<{ readonly targetId: string; readonly detail: string }>`
        SELECT target_id AS "targetId", detail_json AS "detail" FROM audit_log
        WHERE action = 'vault.allow' ORDER BY audit_id DESC LIMIT 1
      `;
    assert.equal(takenBack[0]?.targetId, shared);
    assert.include(takenBack[0]?.detail ?? "", '"allowed":false');
    assert.include(takenBack[0]?.detail ?? "", '"subjectName":"Acme"');
  }),
);

it.effect("deleting a Project deletes its Vault choices", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const acmeKeys = yield* h.vault("Acme keys", h.acmeId, [
      ["ACME_TOKEN", "acme-token-value-0001"],
    ]);
    const web = yield* h.project("acme-web", h.acmeId);
    yield* h.vaults
      .setProjectChoice({ projectId: web, vaultId: acmeKeys, choice: "add" })
      .pipe(h.asOwner);
    const deleted = yield* h.server.request("/api/projects/mutate", {
      cookie: h.owner,
      body: { type: "project.delete", commandId: "delete-acme-web", projectId: web, force: true },
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(
      yield* h.count(
        h.server.sql`SELECT COUNT(*) AS n FROM project_vault_choices WHERE project_id = ${web}`,
      ),
      0,
    );
    // And none is written for it once deleted.
    const refused = yield* Effect.flip(
      h.vaults
        .setProjectChoice({ projectId: web, vaultId: acmeKeys, choice: "add" })
        .pipe(h.asOwner),
    );
    assert.equal(refused.reason, "not-found");
  }),
);

it.effect(
  "allowing a Vault to a Space never brings back a default or choice of it left from before",
  () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const sql = h.server.sql;
      const tools = yield* h.vault("Tools", null, [["TOOLS_TOKEN", "tools-token-value-0006"]]);
      const web = yield* h.project("globex-web", h.globexId);
      // Rows a Hub before ticket 07 left behind (a Project moved here, an earlier allowance).
      yield* sql`
        INSERT INTO project_vault_choices (project_id, group_id, choice) VALUES (${web}, ${tools}, 'add')
      `;
      yield* sql`
        INSERT INTO space_default_vaults (space_id, group_id, position) VALUES (${h.globexId}, ${tools}, 0)
      `;
      yield* h.vaults
        .allow({ vaultId: tools, subject: { kind: "space", spaceId: h.globexId }, allowed: true })
        .pipe(h.asOwner);
      assert.equal(
        yield* h.count(
          sql`SELECT COUNT(*) AS n FROM project_vault_choices WHERE group_id = ${tools}`,
        ),
        0,
      );
      assert.equal(
        yield* h.count(
          sql`SELECT COUNT(*) AS n FROM space_default_vaults WHERE group_id = ${tools}`,
        ),
        0,
      );
    }),
);

it.effect("nothing new is written for an Organization once its deletion began", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const acmeKeys = yield* h.vault("Acme keys", h.acmeId, [
      ["ACME_TOKEN", "acme-token-value-0001"],
    ]);
    const tools = yield* h.vault("Tools", null, [["TOOLS_TOKEN", "tools-token-value-0006"]]);
    const directory = Context.get(h.server.services, SpaceDirectory.SpaceDirectory);
    yield* directory.setOrganizationArchived({
      actor: h.ownerId,
      spaceId: h.acmeId,
      archived: true,
    });
    // What the Organization's deletion marks first; its rows go after.
    yield* directory.beginOrganizationDeletion({ actor: h.ownerId, spaceId: h.acmeId });
    const reasonOf = <A, R>(effect: Effect.Effect<A, VaultError, R>) =>
      Effect.map(Effect.flip(effect), (error) => error.reason);
    assert.equal(
      yield* reasonOf(h.vaults.create({ name: "Late", owner: orgOwner(h.acmeId) }).pipe(h.asOwner)),
      "not-found",
    );
    assert.equal(
      yield* reasonOf(
        h.vaults
          .putEntry({ vaultId: acmeKeys, name: "LATE", value: Redacted.make("late-value-0007") })
          .pipe(h.asOwner),
      ),
      "not-found",
    );
    assert.equal(
      yield* reasonOf(
        h.vaults
          .allow({ vaultId: tools, subject: { kind: "space", spaceId: h.acmeId }, allowed: true })
          .pipe(h.asOwner),
      ),
      "not-found",
    );
    assert.equal(
      yield* h.count(h.server.sql`SELECT COUNT(*) AS n FROM vault_groups WHERE name = 'Late'`),
      0,
    );
  }),
);

it.effect("removing a User takes back every Vault allowed to them; disabling keeps them", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const sql = h.server.sql;
    for (const id of ["grace", "linus"]) {
      yield* addMember(h.server, { id, displayName: id });
      yield* joinOrganization(h.server, h.acmeId, id, "member");
    }
    const grace = UserId.make("grace");
    const linus = UserId.make("linus");
    yield* Context.get(h.server.services, SpaceDirectory.SpaceDirectory).membershipsChanged([
      grace,
      linus,
    ]);
    const own = Effect.fn(function* (name: string, userId: UserId) {
      const vaultId = yield* h.vault(name, null, [["OWN_TOKEN", `${name}-value-000005`]]);
      yield* h.vaults
        .allow({ vaultId, subject: { kind: "user", userId }, allowed: true })
        .pipe(h.asOwner);
      return vaultId;
    });
    const gracesKeys = yield* own("graces-keys", grace);
    yield* own("linus-keys", linus);
    // A Vault allowed to Grace's Personal space, a default there.
    const gracesSpace = SpaceId.make("personal:grace");
    const toPersonal = yield* h.vault("graces-space-keys", null, [
      ["SPACE_TOKEN", "space-value-0008"],
    ]);
    yield* h.vaults
      .allow({
        vaultId: toPersonal,
        subject: { kind: "space", spaceId: gracesSpace },
        allowed: true,
      })
      .pipe(h.asOwner);
    // A default the Owner chose there before owned-resources 04 (only Grace chooses now).
    yield* sql`
      INSERT INTO space_default_vaults (space_id, group_id, position)
      VALUES (${gracesSpace}, ${toPersonal}, 0)
    `;
    // A Project of hers in that Space, which chose it.
    const at = "2026-11-01T00:00:00.000Z";
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, space_id)
      VALUES ('graces-web', 'graces-web', '/w/graces-web', '[]', ${at}, ${at}, ${gracesSpace})
    `;
    yield* sql`
      INSERT INTO project_vault_choices (project_id, group_id, choice) VALUES ('graces-web', ${toPersonal}, 'add')
    `;
    const allowances = (userId: UserId) =>
      h.count(sql`
        SELECT COUNT(*) AS n FROM vault_allowances WHERE subject_kind = 'user' AND subject_id = ${userId}
      `);

    const users = Context.get(h.server.services, InstallationUserService.InstallationUserService);
    yield* users.setStatus({ actorUserId: h.ownerId, userId: linus, status: "disabled" });
    assert.equal(yield* allowances(linus), 1, "a disabled User keeps theirs");

    yield* users.setStatus({ actorUserId: h.ownerId, userId: grace, status: "removed" });
    assert.equal(yield* allowances(grace), 0);
    // Her frozen Personal space keeps no allowance nor default either.
    assert.equal(
      yield* h.count(sql`
        SELECT COUNT(*) AS n FROM vault_allowances WHERE subject_kind = 'space' AND subject_id = ${gracesSpace}
      `),
      0,
    );
    assert.equal(
      yield* h.count(
        sql`SELECT COUNT(*) AS n FROM space_default_vaults WHERE space_id = ${gracesSpace}`,
      ),
      0,
    );
    assert.equal(
      yield* h.count(
        sql`SELECT COUNT(*) AS n FROM project_vault_choices WHERE project_id = 'graces-web'`,
      ),
      0,
    );
    const chose = yield* sql<{ readonly detail: string }>`
      SELECT detail_json AS "detail" FROM audit_log
      WHERE action = 'vault.choose' AND target_id = ${toPersonal}
        AND detail_json LIKE '%"scope":"project"%'
    `;
    assert.lengthOf(chose, 1, "the dropped choice is audited");
    assert.include(chose[0]?.detail ?? "", '"choice":"inherit"');
    // The Vault itself stays the Owner's, with its secret.
    assert.equal(
      yield* h.count(sql`SELECT COUNT(*) AS n FROM vault_entries WHERE group_id = ${gracesKeys}`),
      1,
    );
    const audited = yield* sql<{ readonly targetId: string; readonly detail: string }>`
      SELECT target_id AS "targetId", detail_json AS "detail" FROM audit_log
      WHERE action = 'vault.allow' AND detail_json LIKE '%"allowed":false%' ORDER BY audit_id
    `;
    assert.deepEqual(
      audited.map((row) => row.targetId).toSorted(),
      [gracesKeys, toPersonal].toSorted(),
    );
    for (const row of audited) assert.include(row.detail, '"subjectName":"grace"');
    // Allowing her anything now is refused.
    const refused = yield* Effect.flip(
      h.vaults
        .allow({ vaultId: gracesKeys, subject: { kind: "user", userId: grace }, allowed: true })
        .pipe(h.asOwner),
    );
    assert.equal(refused.reason, "not-found");
  }),
);
