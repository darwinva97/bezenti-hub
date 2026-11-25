// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off - real git checkouts for the Projects, and the audit rows as stored.
/**
 * Makita ticket 21: a repository added by name. The Space's Project with that remote is reused;
 * otherwise the Hub's clone path makes one in the configuration's Space, as the person, audited.
 * A private repository the person cannot see answers like a missing one; other Spaces add nothing.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { type MakitaRepoAddInput, ProjectId, type UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { makitaReady } from "./MakitaFixtures.testkit.ts";
import { type MakitaProjectCloner, parseRepo } from "./MakitaRepoAdd.ts";

const live = it.live.skipIf(!posix || platform === undefined);

let clonedCount = 0;

/** Makita ready in Acme; `acme/new-thing` public, `acme/secret` private; a recording clone path. */
const ready = Effect.gen(function* () {
  const ctx = yield* makitaReady;
  const { setup } = ctx;
  setup.github.repos.set("acme/new-thing", new Set());
  setup.github.repos.set("acme/secret", new Set());
  setup.github.privateRepos.add("acme/secret");
  const clones: Array<{
    readonly spaceId: string;
    readonly actorUserId: UserId;
    readonly repo: string;
  }> = [];
  // The Hub's clone path, as a checkout with the repository's remote and a Project row.
  const cloner: MakitaProjectCloner = (input) =>
    Effect.gen(function* () {
      clones.push(input);
      clonedCount += 1;
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-makita-added-"));
      NodeChildProcess.execFileSync("git", ["init", "-q", dir]);
      NodeChildProcess.execFileSync("git", [
        "-C",
        dir,
        "remote",
        "add",
        "origin",
        `https://github.com/${input.repo}.git`,
      ]);
      const projectId = ProjectId.make(`makita-added-${clonedCount}`);
      const at = "2026-11-25T00:00:00.000Z";
      yield* setup.server.sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
          created_at, updated_at, space_id, owner_user_id)
        VALUES (${projectId}, ${input.repo.split("/")[1]!}, ${dir}, '[]', ${at}, ${at},
          ${input.spaceId}, ${input.actorUserId})
      `.pipe(Effect.orDie);
      return { projectId, workspaceRoot: dir, phase: Effect.succeed("done") };
    });
  const addAs = (userId: UserId, repo: string) =>
    setup.makitaRepoAdd
      .addForSession({ spaceId: setup.acmeId, repo } satisfies MakitaRepoAddInput, cloner)
      .pipe(CommandActor.actAs(userId));
  const repoRequests = (repo: string) =>
    setup.github.requests.filter((request) => request.path.startsWith(`repos/${repo}`));
  return { ...ctx, clones, cloner, addAs, repoRequests };
});

it("reads owner/name out of what a person types or pastes", () => {
  assert.equal(parseRepo("acme/widgets"), "acme/widgets");
  assert.equal(parseRepo(" https://github.com/acme/widgets.git "), "acme/widgets");
  assert.equal(parseRepo("https://github.com/acme/widgets/issues/12"), "acme/widgets");
  assert.equal(parseRepo("github.com/acme/widgets"), "acme/widgets");
  assert.equal(parseRepo("git@github.com:acme/widgets.git"), "acme/widgets");
  for (const bad of ["widgets", "https://gitlab.com/acme/widgets", "acme/../x", "-acme/x", ""]) {
    assert.isUndefined(parseRepo(bad), bad);
  }
});

live(
  "Grace adds a repository by its URL: one Project in Acme, made as her, audited; asked again, or for a Project's own repository, it is reused; unchosen, the Project stays",
  () =>
    Effect.gen(function* () {
      const ctx = yield* ready;
      const { setup } = ctx;
      const grace = setup.people.member;
      const made = yield* ctx.addAs(grace, "https://github.com/acme/new-thing.git");
      assert.isTrue(made.created);
      assert.deepEqual(
        [made.project.title, made.project.repo, made.project.state],
        ["new-thing", "acme/new-thing", "ok"],
      );
      assert.deepEqual(made.notes, []);
      assert.deepEqual(ctx.clones, [
        { spaceId: setup.acmeId, actorUserId: grace, repo: "acme/new-thing" },
      ]);
      const audits = yield* setup.server.sql<{ readonly actor: string; readonly detail: string }>`
        SELECT actor_user_id AS actor, detail_json AS detail FROM audit_log
        WHERE action = 'makita.repo.add' ORDER BY audit_id
      `;
      assert.deepEqual(
        audits.map((row) => [row.actor, JSON.parse(row.detail)]),
        [
          [
            grace,
            {
              space: setup.acmeId,
              repo: "acme/new-thing",
              project: made.project.projectId,
              created: true,
            },
          ],
        ],
      );

      // Again, spelled otherwise: the same Project, nothing cloned.
      const again = yield* ctx.addAs(grace, "Acme/New-Thing");
      assert.isFalse(again.created);
      assert.equal(again.project.projectId, made.project.projectId);
      const widgets = yield* ctx.addAs(grace, "acme/widgets");
      assert.isFalse(widgets.created);
      assert.equal(widgets.project.projectId, ctx.widgets);
      assert.lengthOf(ctx.clones, 1);

      // Chosen in a configuration, then left out of it: the Project is still there.
      const config = yield* ctx.configure({
        repos: { projects: [ctx.widgets, made.project.projectId] },
      });
      assert.deepEqual(
        config.projects.map((project) => project.repo),
        ["acme/widgets", "acme/new-thing"],
      );
      yield* setup.makitaConfigs
        .updateForSession({
          configId: config.configId,
          ...ctx.input({ repos: { projects: [ctx.widgets] } }),
        })
        .pipe(CommandActor.actAs(grace));
      const [kept] = yield* setup.server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM projection_projects
        WHERE project_id = ${made.project.projectId} AND deleted_at IS NULL
      `;
      assert.equal(kept?.n, 1);
    }),
);

live(
  "a private repository answers like a missing one unless the person's linked GitHub account is a collaborator",
  () =>
    Effect.gen(function* () {
      const ctx = yield* ready;
      const { setup } = ctx;
      const grace = setup.people.member;
      const secret = yield* ctx.addAs(grace, "acme/secret").pipe(Effect.flip);
      const missing = yield* ctx.addAs(grace, "acme/nothing").pipe(Effect.flip);
      assert.equal(secret.reason, "not-found");
      assert.equal(secret.reason, missing.reason);
      assert.equal(
        secret.message.replace("acme/secret", "R"),
        missing.message.replace("acme/nothing", "R"),
      );
      assert.lengthOf(ctx.clones, 0);

      // Linked, but not a collaborator: the same answer.
      yield* setup.server.sql`
        INSERT INTO github_identities (user_id, host, github_user_id, login, linked_at)
        VALUES (${grace}, 'github.com', 3, 'Grace-GH', '2026-11-25T00:00:00.000Z')
      `;
      const notYet = yield* ctx.addAs(grace, "acme/secret").pipe(Effect.flip);
      assert.equal(notYet.message, secret.message);
      // A collaborator: added.
      setup.github.collaborators.set("acme/secret", new Set(["grace-gh"]));
      const added = yield* ctx.addAs(grace, "acme/secret");
      assert.isTrue(added.created);
      assert.equal(added.project.repo, "acme/secret");
    }),
);

live(
  "only who may use Makita in the Space adds, never into another Space; a bad name asks GitHub nothing; Makita without push gets a note",
  () =>
    Effect.gen(function* () {
      const ctx = yield* ready;
      const { setup } = ctx;
      for (const outsider of [setup.people.globexMember, setup.people.guest, setup.people.admin]) {
        const refused = yield* ctx.addAs(outsider, "acme/new-thing").pipe(Effect.flip);
        assert.equal(refused.reason, "forbidden");
      }
      assert.deepEqual(ctx.repoRequests("acme/new-thing"), []);
      const bad = yield* ctx.addAs(setup.people.member, "not a repository").pipe(Effect.flip);
      assert.equal(bad.reason, "invalid");
      assert.deepEqual(ctx.repoRequests("acme/new-thing"), []);
      assert.lengthOf(ctx.clones, 0);
      // An agent's call never reaches it.
      const agent = yield* setup.makitaRepoAdd
        .addForSession({ spaceId: setup.acmeId, repo: "acme/new-thing" }, ctx.cloner)
        .pipe(
          CommandActor.actAsResolved({
            _tag: "User",
            userId: setup.people.member,
            via: "agent",
          }),
          Effect.flip,
        );
      assert.equal(agent.reason, "forbidden");

      setup.github.readOnlyRepos.add("acme/new-thing");
      const added = yield* ctx.addAs(setup.people.member, "acme/new-thing");
      assert.isTrue(added.created);
      assert.lengthOf(added.notes, 1);
      assert.include(added.notes[0]!, "not push");
    }),
);
