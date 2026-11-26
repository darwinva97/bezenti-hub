/**
 * A Space's MCP servers and Skills (.scratch/mcps-and-skills, step 1): its Admins manage them;
 * Members and Guests read names and state; anyone else gets not-found. A Vault reference must be
 * held by a group reaching the Space, and nothing tells whether another Space holds it.
 */
import { type SpaceMcpConfig, SpaceId, UserId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as Grants from "../grants/Grants.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as Vaults from "../vaults/Vaults.ts";
import { orgOwner } from "../vaults/VaultGroups.testkit.ts";
import * as SpaceTools from "./SpaceTools.ts";

const TOKEN_VALUE = "vault-value-never-shown";

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
  const betaId = yield* organization("Beta");
  const person = Effect.fn(function* (
    id: string,
    role?: "admin" | "member" | "guest",
    spaceId: SpaceId = acmeId,
  ) {
    yield* addMember(server, { id, displayName: id });
    if (role !== undefined) yield* joinOrganization(server, spaceId, id, role);
    // An Admin's role holds with a strong factor enrolled.
    if (role === "admin") {
      yield* server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key, sign_count,
          transports, rp_id, created_at)
        VALUES (${`${id}-key`}, ${id}, 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
    }
    return UserId.make(id);
  });
  const admin = yield* person("ada", "admin");
  const member = yield* person("grace", "member");
  const guest = yield* person("hedy", "guest");
  const outsider = yield* person("linus");
  // Beta's Admin; Ada also works in Beta, so she may name it when lending.
  const betaAdmin = yield* person("bea", "admin", betaId);
  yield* joinOrganization(server, betaId, "ada", "member");
  yield* Context.get(server.services, SpaceDirectory.SpaceDirectory).membershipsChanged([
    admin,
    member,
    guest,
    outsider,
    betaAdmin,
  ]);
  const as = (userId: UserId) => CommandActor.actAs(userId);
  const vaults = Context.get(server.services, Vaults.Vaults);
  const tools = Context.get(server.services, SpaceTools.SpaceTools);
  const acmeGroup = yield* vaults
    .create({ name: "Acme secrets", owner: orgOwner(acmeId) })
    .pipe(as(ownerId));
  yield* vaults
    .putEntry({ vaultId: acmeGroup.id, name: "GITHUB_TOKEN", value: Redacted.make(TOKEN_VALUE) })
    .pipe(as(ownerId));
  const betaGroup = yield* vaults
    .create({ name: "Beta secrets", owner: orgOwner(betaId) })
    .pipe(as(ownerId));
  yield* vaults
    .putEntry({ vaultId: betaGroup.id, name: "BETA_TOKEN", value: Redacted.make("beta-only") })
    .pipe(as(ownerId));
  const auditActions = server.sql<{ readonly action: string }>`
    SELECT action FROM audit_log WHERE action LIKE 'space_%' ORDER BY rowid
  `.pipe(Effect.map((rows) => rows.map((row) => row.action)));
  const grants = Context.get(server.services, Grants.Grants);
  return {
    server,
    ownerId,
    acmeId,
    betaId,
    admin,
    member,
    guest,
    outsider,
    betaAdmin,
    acmeGroup: acmeGroup.id,
    as,
    tools,
    grants,
    auditActions,
  };
});

const reasonOf = <A, E extends { readonly reason: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

const github = (credential: string): SpaceMcpConfig => ({
  transport: "http",
  url: "https://mcp.example.test/mcp",
  headers: { Authorization: ["Bearer", credential].join(" ") },
});

/** A URL that carries a login, built at run time. */
const urlWithLogin = () => {
  const url = new URL("https://mcp.example.test");
  url.username = "someone";
  return url.href;
};

const SKILL = `---
name: release-notes
description: Writes release notes from merged pull requests.
---
Read the merged pull requests and write the notes.
`;

it.effect("an Admin saves an MCP whose token is a Vault reference; no answer holds the value", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const saved = yield* h.tools
      .putMcp({ spaceId: h.acmeId, name: "github", config: github("${GITHUB_TOKEN}") })
      .pipe(h.as(h.admin));
    assert.deepEqual(saved.references, ["GITHUB_TOKEN"]);
    assert.deepEqual(saved.config, github("${GITHUB_TOKEN}"));
    const read = yield* h.tools.getMcp({ id: saved.id }).pipe(h.as(h.admin));
    const listed = yield* h.tools.list({ spaceId: h.acmeId }).pipe(h.as(h.member));
    assert.isFalse(listed.canManage);
    assert.deepEqual(
      listed.mcps.map((mcp) => [mcp.name, mcp.transport, mcp.enabled]),
      [["github", "http", true]],
    );
    const stored = yield* h.server.sql<{ readonly text: string }>`
      SELECT config_json AS text FROM space_mcps
      UNION ALL SELECT COALESCE(detail_json, '') FROM audit_log WHERE action LIKE 'space_%'
    `;
    for (const text of [JSON.stringify([saved, read, listed]), ...stored.map((row) => row.text)]) {
      assert.notInclude(text, TOKEN_VALUE);
    }
    // Changed, turned off and on, and deleted: each seen in the list and audited.
    yield* h.tools
      .putMcp({
        spaceId: h.acmeId,
        id: saved.id,
        name: "github-ro",
        config: github("${GITHUB_TOKEN}"),
      })
      .pipe(h.as(h.admin));
    const tool = { kind: "mcp", id: saved.id } as const;
    yield* h.tools.setEnabled({ tool, enabled: false }).pipe(h.as(h.admin));
    assert.deepEqual(
      (yield* h.tools.list({ spaceId: h.acmeId }).pipe(h.as(h.member))).mcps.map((mcp) => [
        mcp.name,
        mcp.enabled,
      ]),
      [["github-ro", false]],
    );
    yield* h.tools.setEnabled({ tool, enabled: true }).pipe(h.as(h.admin));
    yield* h.tools.remove({ tool }).pipe(h.as(h.admin));
    assert.deepEqual((yield* h.tools.list({ spaceId: h.acmeId }).pipe(h.as(h.admin))).mcps, []);
    assert.deepEqual(yield* h.auditActions, [
      "space_mcp.create",
      "space_mcp.update",
      "space_mcp.disable",
      "space_mcp.enable",
      "space_mcp.delete",
    ]);
  }),
);

it.effect(
  "a reference no group reaching the Space holds is refused, alike if another Space has it",
  () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const refusal = (name: string) =>
        h.tools
          .putMcp({ spaceId: h.acmeId, name: "github", config: github(`\${${name}}`) })
          .pipe(h.as(h.admin), Effect.flip);
      const elsewhere = yield* refusal("BETA_TOKEN");
      const nowhere = yield* refusal("NOWHERE_TOKEN");
      assert.equal(elsewhere.reason, "unknown-reference");
      assert.equal(
        elsewhere.message.replace("BETA_TOKEN", "X"),
        nowhere.message.replace("NOWHERE_TOKEN", "X"),
      );
      assert.deepEqual(yield* h.auditActions, []);
    }),
);

it.effect("a credential given as a literal is refused: in a header, a variable or the URL", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const put = (config: SpaceMcpConfig) =>
      reasonOf(h.tools.putMcp({ spaceId: h.acmeId, name: "github", config }).pipe(h.as(h.admin)));
    assert.equal(yield* put(github(TOKEN_VALUE)), "secret-literal");
    assert.equal(
      yield* put({ transport: "http", url: urlWithLogin(), headers: {} }),
      "secret-literal",
    );
    assert.equal(
      yield* put({
        transport: "stdio",
        command: "github-mcp",
        args: [],
        env: { GITHUB_TOKEN: TOKEN_VALUE },
      }),
      "secret-literal",
    );
    const stdio = yield* h.tools
      .putMcp({
        spaceId: h.acmeId,
        name: "github",
        config: {
          transport: "stdio",
          command: "github-mcp",
          args: ["--read-only"],
          env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "info" },
        },
      })
      .pipe(h.as(h.admin));
    assert.deepEqual(stdio.references, ["GITHUB_TOKEN"]);
  }),
);

it.effect("a Member or Guest reads names, not configurations; an outsider gets not-found", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const saved = yield* h.tools
      .putMcp({ spaceId: h.acmeId, name: "github", config: github("${GITHUB_TOKEN}") })
      .pipe(h.as(h.admin));
    for (const who of [h.member, h.guest]) {
      assert.equal(yield* reasonOf(h.tools.getMcp({ id: saved.id }).pipe(h.as(who))), "forbidden");
      assert.equal(
        yield* reasonOf(
          h.tools
            .putMcp({ spaceId: h.acmeId, name: "other", config: github("${GITHUB_TOKEN}") })
            .pipe(h.as(who)),
        ),
        "forbidden",
      );
      assert.equal(
        yield* reasonOf(h.tools.remove({ tool: { kind: "mcp", id: saved.id } }).pipe(h.as(who))),
        "forbidden",
      );
    }
    assert.equal(
      yield* reasonOf(h.tools.list({ spaceId: h.acmeId }).pipe(h.as(h.outsider))),
      "not-found",
    );
    assert.equal(
      yield* reasonOf(h.tools.getMcp({ id: saved.id }).pipe(h.as(h.outsider))),
      "not-found",
    );
  }),
);

it.effect("a Skill is read from SKILL.md; it is turned off, on and deleted, each audited", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    assert.equal(
      yield* reasonOf(
        h.tools
          .putSkill({ spaceId: h.acmeId, files: { "notes.md": "x" }, expects: [] })
          .pipe(h.as(h.admin)),
      ),
      "invalid",
    );
    assert.equal(
      yield* reasonOf(
        h.tools
          .putSkill({ spaceId: h.acmeId, files: { "SKILL.md": SKILL, "../x": "y" }, expects: [] })
          .pipe(h.as(h.admin)),
      ),
      "invalid",
    );
    const skill = yield* h.tools
      .putSkill({
        spaceId: h.acmeId,
        files: { "SKILL.md": SKILL, "templates/notes.md": "# Notes" },
        expects: ["GITHUB_TOKEN"],
      })
      .pipe(h.as(h.admin));
    assert.deepEqual(
      [skill.name, skill.description, skill.expects],
      ["release-notes", "Writes release notes from merged pull requests.", ["GITHUB_TOKEN"]],
    );
    assert.equal(
      yield* reasonOf(
        h.tools
          .putSkill({ spaceId: h.acmeId, files: { "SKILL.md": SKILL }, expects: [] })
          .pipe(h.as(h.admin)),
      ),
      "name-taken",
    );
    const tool = { kind: "skill", id: skill.id } as const;
    yield* h.tools.setEnabled({ tool, enabled: false }).pipe(h.as(h.admin));
    const off = yield* h.tools.list({ spaceId: h.acmeId }).pipe(h.as(h.guest));
    assert.deepEqual(
      off.skills.map((row) => [row.name, row.enabled]),
      [["release-notes", false]],
    );
    yield* h.tools.setEnabled({ tool, enabled: true }).pipe(h.as(h.admin));
    yield* h.tools.remove({ tool }).pipe(h.as(h.admin));
    assert.deepEqual((yield* h.tools.list({ spaceId: h.acmeId }).pipe(h.as(h.admin))).skills, []);
    assert.deepEqual(yield* h.auditActions, [
      "space_skill.create",
      "space_skill.disable",
      "space_skill.enable",
      "space_skill.delete",
    ]);
  }),
);

it.effect(
  "a lent MCP needs its Vault groups lent first; the borrower uses it, never reads it",
  () =>
    Effect.gen(function* () {
      const h = yield* hub;
      const mcp = yield* h.tools
        .putMcp({ spaceId: h.acmeId, name: "github", config: github("${GITHUB_TOKEN}") })
        .pipe(h.as(h.admin));
      const lendMcp = h.grants
        .give(
          {
            resource: { kind: "space-mcp", spaceMcpId: mcp.id },
            spaceId: h.betaId,
            limits: { kind: "space-mcp" },
          },
          { strongFactor: false },
        )
        .pipe(h.as(h.admin));
      // Decision 1 (A): its token reaches Beta only through Acme's own group, lent there first.
      const early = yield* Effect.flip(lendMcp);
      assert.equal(early.reason, "not-lendable");
      assert.include(early.message, "GITHUB_TOKEN");
      const groupLoan = yield* h.grants
        .give(
          {
            resource: { kind: "vault-group", vaultGroupId: h.acmeGroup },
            spaceId: h.betaId,
            limits: { kind: "vault-group" },
          },
          { strongFactor: true },
        )
        .pipe(h.as(h.admin));
      yield* h.grants
        .accept({ grantId: groupLoan.id }, { strongFactor: false })
        .pipe(h.as(h.betaAdmin));
      const loan = yield* lendMcp;
      yield* h.grants.accept({ grantId: loan.id }, { strongFactor: false }).pipe(h.as(h.betaAdmin));

      const seen = yield* h.tools.list({ spaceId: h.betaId }).pipe(h.as(h.betaAdmin));
      assert.deepEqual(
        seen.mcps.map((row) => [row.name, row.lent?.grantId]),
        [["github", loan.id]],
      );
      // Read-only there: no configuration, no change, no lending it on.
      for (const attempt of [
        h.tools.getMcp({ id: mcp.id }),
        h.tools.setEnabled({ tool: { kind: "mcp", id: mcp.id }, enabled: false }),
        h.tools.remove({ tool: { kind: "mcp", id: mcp.id } }),
      ]) {
        assert.equal(yield* reasonOf(attempt.pipe(h.as(h.betaAdmin))), "not-found");
      }
      const lendOn = yield* h.grants
        .give(
          {
            resource: { kind: "space-mcp", spaceMcpId: mcp.id },
            spaceId: `personal:${h.betaAdmin}` as SpaceId,
            limits: { kind: "space-mcp" },
          },
          { strongFactor: false },
        )
        .pipe(h.as(h.betaAdmin), Effect.flip);
      assert.equal(lendOn.reason, "not-found");

      // Taken back: gone from Beta's list at once.
      yield* h.grants.end({ grantId: loan.id }).pipe(h.as(h.admin));
      assert.deepEqual(
        (yield* h.tools.list({ spaceId: h.betaId }).pipe(h.as(h.betaAdmin))).mcps,
        [],
      );
    }),
);

it.effect("deleting a lent Skill ends its loan, which keeps the Skill's name", () =>
  Effect.gen(function* () {
    const h = yield* hub;
    const skill = yield* h.tools
      .putSkill({ spaceId: h.acmeId, files: { "SKILL.md": SKILL }, expects: [] })
      .pipe(h.as(h.admin));
    const loan = yield* h.grants
      .give(
        {
          resource: { kind: "space-skill", spaceSkillId: skill.id },
          spaceId: h.betaId,
          limits: { kind: "space-skill" },
        },
        { strongFactor: false },
      )
      .pipe(h.as(h.admin));
    yield* h.grants.accept({ grantId: loan.id }, { strongFactor: false }).pipe(h.as(h.betaAdmin));
    assert.deepEqual(
      (yield* h.tools.list({ spaceId: h.betaId }).pipe(h.as(h.betaAdmin))).skills.map(
        (row) => row.name,
      ),
      ["release-notes"],
    );
    yield* h.tools.remove({ tool: { kind: "skill", id: skill.id } }).pipe(h.as(h.admin));
    const [ended] = yield* h.server.sql<{ readonly state: string; readonly name: string }>`
      SELECT state || '/' || end_reason AS state, resource_name AS name FROM grants
      WHERE grant_id = ${loan.id}
    `;
    assert.deepEqual(ended, { state: "ended/resource-gone", name: "release-notes" });
  }),
);
