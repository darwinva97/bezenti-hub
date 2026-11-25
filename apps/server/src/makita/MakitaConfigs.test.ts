// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off - real git checkouts for the Projects, and the audit rows as stored.
/**
 * Makita ticket 03: who may use Makita in a Space makes a configuration (its Projects' GitHub
 * repositories, a list of GitHub users, one of their gateway AI accounts); Admins pause it, the
 * Owner sees and pauses all; nobody else sees it; batch 1 refuses what comes later.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  type AiAccountId,
  EnvironmentId,
  type MakitaConfigInput,
  ProjectId,
  ProviderInstanceId,
  type SpaceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import { platform, posix } from "../ai/AiGatewayRoute.testkit.ts";
import { makitaHub, type MakitaHub } from "./Makita.testkit.ts";
import { classicToken } from "./MakitaGitHub.testkit.ts";

const MODEL = "claude-sonnet-5-5";

/** A checkout with these remotes (name → URL), as a Project's folder on the Hub. */
const checkout = (remotes: Record<string, string>) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-makita-project-"));
  NodeChildProcess.execFileSync("git", ["init", "-q", dir]);
  for (const [name, url] of Object.entries(remotes)) {
    NodeChildProcess.execFileSync("git", ["-C", dir, "remote", "add", name, url]);
  }
  return dir;
};

let projects = 0;
const project = (setup: MakitaHub, spaceId: SpaceId, title: string, root: string) =>
  Effect.gen(function* () {
    projects += 1;
    const projectId = ProjectId.make(`makita-project-${projects}`);
    const at = "2026-11-24T00:00:00.000Z";
    yield* setup.server.sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
        created_at, updated_at, space_id, owner_user_id)
      VALUES (${projectId}, ${title}, ${root}, '[]', ${at}, ${at}, ${spaceId}, ${setup.ownerId})
    `;
    return projectId;
  });

/** Makita registered, Grace allowed in Acme, three Acme Projects and a Globex one, AI accounts. */
const ready = Effect.gen(function* () {
  const setup = yield* makitaHub;
  const token = classicToken("configs");
  setup.github.tokens.set(token, { user: { login: "makita-bot", id: 4242 }, scopes: ["repo"] });
  setup.github.users.set("octocat", { login: "octocat", id: 1 });
  setup.github.users.set("grace-gh", { login: "Grace-GH", id: 3 });
  setup.github.users.set("dependabot", { login: "dependabot", id: 9, type: "Bot" });
  setup.github.repos.set("acme/widgets", new Set());
  setup.github.repos.set("acme/gadgets", new Set(["makita"]));
  setup.github.repos.set("acme/locked", new Set());
  setup.github.labelsRefused.add("acme/locked");
  yield* setup.makitaAccount.setForSession({ token: Redacted.make(token) }).pipe(setup.asOwner);
  yield* setup.makitaPermissions
    .grantForSession({ userId: setup.people.member, spaceId: setup.acmeId })
    .pipe(setup.asOwner);
  const widgets = yield* project(
    setup,
    setup.acmeId,
    "Widgets",
    checkout({ origin: "https://github.com/acme/widgets.git" }),
  );
  const gadgets = yield* project(
    setup,
    setup.acmeId,
    "Gadgets",
    // A fork and its upstream: gh takes upstream.
    checkout({
      origin: "https://github.com/grace/gadgets.git",
      upstream: "git@github.com:acme/gadgets.git",
    }),
  );
  const local = yield* project(setup, setup.acmeId, "Local", checkout({}));
  const twins = yield* project(
    setup,
    setup.acmeId,
    "Twins",
    checkout({ one: "https://github.com/acme/one.git", two: "https://github.com/acme/two.git" }),
  );
  const locked = yield* project(
    setup,
    setup.acmeId,
    "Locked",
    checkout({ origin: "https://github.com/acme/locked.git" }),
  );
  const globex = yield* project(
    setup,
    setup.globexId,
    "Globex app",
    checkout({ origin: "https://github.com/globex/app.git" }),
  );
  const acmeClaude = yield* setup.account("Acme Claude", "claude", { spaceIds: [setup.acmeId] });
  const globexClaude = yield* setup.account("Globex Claude", "claude", {
    spaceIds: [setup.globexId],
  });
  const direct = yield* setup.accounts
    .create({
      name: "Direct Gemini",
      type: "direct",
      provider: "gemini",
      apiKey: Redacted.make("sk-test-direct-gemini-0123456789abcdef"),
    })
    .pipe(setup.asOwner);
  yield* setup.lendTo(direct.id, [setup.acmeId]);
  return {
    setup,
    projects: { widgets, gadgets, local, twins, locked, globex },
    accounts: { acmeClaude, globexClaude, direct: direct.id },
  };
});
type Ready = Effect.Success<typeof ready>;

const input = (
  { setup, projects: p, accounts }: Ready,
  over: Partial<MakitaConfigInput> = {},
): MakitaConfigInput => ({
  spaceId: setup.acmeId,
  name: "Widget bugs",
  repos: { projects: [p.widgets] },
  triggers: { label: "makita", assigned: false, mention: false },
  callersMode: "list",
  callers: ["octocat"],
  strangers: "ignore",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: MODEL,
    aiAccountId: accounts.acmeClaude,
  },
  capability: "comment",
  mayLand: false,
  approval: "others",
  approvers: [],
  baseBranch: "public-hub-1",
  environmentId: null,
  ...over,
});

const asGrace = (setup: MakitaHub) => CommandActor.actAs(setup.people.member);

const auditOf = (setup: MakitaHub, action: string) =>
  setup.server.sql<{ readonly actor: string | null; readonly detail: string }>`
    SELECT actor_user_id AS actor, detail_json AS detail FROM audit_log WHERE action = ${action}
    ORDER BY audit_id
  `;

it.live.skipIf(!posix || platform === undefined)(
  "Grace, allowed in Acme, makes a configuration: its repositories resolved from the Projects, the logins to ids, the missing label created; she edits it",
  () =>
    Effect.gen(function* () {
      const ctx = yield* ready;
      const { setup, projects: p } = ctx;
      const saved = yield* setup.makitaConfigs
        .createForSession(input(ctx, { repos: { projects: [p.widgets, p.gadgets] } }))
        .pipe(asGrace(setup));
      const config = saved.config;
      assert.deepEqual(saved.notes, []);
      assert.match(config.configId, /^mk_[0-9a-f]{24}$/u);
      assert.deepEqual(
        config.projects.map((row) => [row.title, row.repo, row.state]),
        [
          ["Widgets", "acme/widgets", "ok"],
          ["Gadgets", "acme/gadgets", "ok"],
        ],
      );
      assert.deepEqual(config.callers, [{ id: 1, login: "octocat" }]);
      assert.deepEqual(config.triggers, { label: "makita", assigned: false, mention: false });
      assert.deepEqual(
        [config.callersMode, config.strangers, config.capability, config.mayLand, config.approval],
        ["list", "ignore", "comment", false, "others"],
      );
      assert.equal(config.aiAccountName, "Acme Claude");
      assert.isNull(config.environmentId);
      assert.equal(config.baseBranch, "public-hub-1");
      assert.deepEqual(config.warnings, []);
      assert.isTrue(config.canEdit && config.canPause && config.canDelete);
      // The label was missing in acme/widgets only: made there, audited.
      assert.isTrue(setup.github.repos.get("acme/widgets")!.has("makita"));
      const labels = yield* auditOf(setup, "makita.github.label");
      assert.deepEqual(
        labels.map((row) => JSON.parse(row.detail)),
        [{ space: setup.acmeId, repo: "acme/widgets", label: "makita", outcome: "created" }],
      );
      const created = yield* auditOf(setup, "makita.config.create");
      assert.deepEqual(JSON.parse(created[0]!.detail), {
        space: setup.acmeId,
        repos: 2,
        callersMode: "list",
        capability: "comment",
        mayLand: false,
        aiAccount: ctx.accounts.acmeClaude,
      });

      // The Space's list: the configuration and, for her, the form's choices.
      const listed = yield* setup.makitaConfigs
        .listForSession({ spaceId: setup.acmeId })
        .pipe(asGrace(setup));
      assert.deepEqual(
        listed.configs.map((row) => row.configId),
        [config.configId],
      );
      assert.isTrue(listed.space!.canCreate);
      assert.isTrue(listed.space!.accountReady);
      assert.deepEqual(
        listed.space!.projects.map((row) => [row.title, row.state]),
        [
          ["Gadgets", "ok"],
          ["Local", "no-remote"],
          ["Locked", "ok"],
          ["Twins", "ambiguous"],
          ["Widgets", "ok"],
        ],
      );
      assert.deepEqual(
        listed.space!.aiAccounts.map((account) => account.name),
        ["Acme Claude"],
      );

      // She edits it: a new name and a second login (the first keeps its id); audited by field.
      const edited = yield* setup.makitaConfigs
        .updateForSession({
          ...input(ctx, { repos: { projects: [p.widgets, p.gadgets] } }),
          configId: config.configId,
          name: "All widget bugs",
          callers: ["octocat", "@grace-gh"],
        })
        .pipe(asGrace(setup));
      assert.equal(edited.config.name, "All widget bugs");
      assert.deepEqual(edited.config.callers, [
        { id: 1, login: "octocat" },
        { id: 3, login: "Grace-GH" },
      ]);
      const updates = yield* auditOf(setup, "makita.config.update");
      assert.equal(JSON.parse(updates[0]!.detail).changed, "name,callers");

      // «All Projects with a GitHub remote»: the label cannot be made in acme/locked, said.
      const all = yield* setup.makitaConfigs
        .createForSession(input(ctx, { name: "Everything", repos: { all: true } }))
        .pipe(asGrace(setup));
      assert.deepEqual(
        all.config.projects.map((row) => row.repo),
        ["acme/gadgets", "acme/locked", "acme/widgets"],
      );
      assert.lengthOf(all.notes, 1);
      assert.include(all.notes[0]!, "acme/locked");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "refuses a Member without the permission, an agent, an AI account she may not use or a direct one, another Space's Project, one with no or two GitHub remotes, and what comes in later batches",
  () =>
    Effect.gen(function* () {
      const ctx = yield* ready;
      const { setup, projects: p, accounts } = ctx;
      // Ada (Admin, no permission), Linus (Guest), Gus (Globex), an agent as Grace, a session
      // limited to Acme: refused before any Project is read or GitHub asked.
      const asked = setup.github.requests.length;
      for (const as of [
        CommandActor.actAs(setup.people.admin),
        CommandActor.actAs(setup.people.guest),
        CommandActor.actAs(setup.people.globexMember),
        CommandActor.actAsResolved({ _tag: "User", userId: setup.people.member, via: "agent" }),
        CommandActor.actAsResolved({
          _tag: "User",
          userId: setup.people.member,
          spaceLimit: setup.acmeId,
        }),
      ]) {
        const refused = yield* setup.makitaConfigs
          .createForSession(input(ctx, { repos: { projects: [p.local] }, callers: ["octocat"] }))
          .pipe(as, Effect.flip);
        assert.equal(refused.reason, "forbidden");
        assert.notInclude(refused.message, "Local");
      }
      assert.equal(setup.github.requests.length, asked, "GitHub was asked for a refused caller");
      const selection = (aiAccountId: AiAccountId, instanceId = "claudeAgent") => ({
        modelSelection: {
          instanceId: ProviderInstanceId.make(instanceId),
          model: MODEL,
          aiAccountId,
        },
      });
      for (const [why, over] of [
        ["an account lent to Globex", selection(accounts.globexClaude)],
        ["a direct account", selection(accounts.direct)],
        ["an agent off the gateway", selection(accounts.acmeClaude, "cursor")],
        ["Globex's Project", { repos: { projects: [p.globex] } }],
        ["a Project with no GitHub remote", { repos: { projects: [p.local] } }],
        ["a Project with two GitHub remotes", { repos: { projects: [p.twins] } }],
        ["a machine", { environmentId: EnvironmentId.make("env-dedicated") }],
        // Ticket 11: approvers are GitHub logins that exist.
        ["an unknown approver", { capability: "push" as const, approvers: ["nobody-here"] }],
        ["a bad approver login", { capability: "push" as const, approvers: ["not a login"] }],
        // Ticket 13: landing only where Makita also pushes.
        ["landing without push", { capability: "comment" as const, mayLand: true }],
        ["anyone", { callersMode: "anyone" as const }],
        ["replies to strangers", { strangers: "reply" as const }],
        ["an empty label", { triggers: { label: " ", assigned: false, mention: true } }],
        ["no label", { triggers: { label: null, assigned: false, mention: false } }],
        ["no caller", { callers: [] }],
        ["an unknown login", { callers: ["nobody-here"] }],
        ["a bot", { callers: ["dependabot"] }],
        ["a bad branch", { baseBranch: "main..x" }],
      ] as const) {
        const refused = yield* setup.makitaConfigs
          .createForSession(input(ctx, over))
          .pipe(asGrace(setup), Effect.flip);
        assert.equal(refused.reason, "invalid", why);
      }
      const rows = yield* setup.server.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM makita_configs
      `;
      assert.equal(rows[0]?.n, 0);

      // 20 live configurations per Space.
      for (let index = 0; index < 20; index += 1) {
        yield* setup.server.sql`
          INSERT INTO makita_configs (config_id, space_id, name, created_by, created_at,
            updated_at, repos_json, triggers_json, callers_mode, model_selection_json)
          VALUES (${`mk_seed_${index}`}, ${setup.acmeId}, 'Seed', ${setup.people.member},
            '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z', '{"all":true}',
            '{"label":"makita","assigned":false,"mention":false}', 'list',
            '{"instanceId":"claudeAgent","model":"m"}')
        `;
      }
      const full = yield* setup.makitaConfigs
        .createForSession(input(ctx))
        .pipe(asGrace(setup), Effect.flip);
      assert.equal(full.reason, "limit");
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "an Admin pauses Grace's configuration but neither edits, resumes nor deletes it; what the Owner pauses only the Owner resumes; deleting is hers or the Owner's",
  () =>
    Effect.gen(function* () {
      const ctx = yield* ready;
      const { setup } = ctx;
      const asAda = CommandActor.actAs(setup.people.admin);
      const { config } = yield* setup.makitaConfigs
        .createForSession(input(ctx))
        .pipe(asGrace(setup));
      const ref = { configId: config.configId };

      const paused = yield* setup.makitaConfigs.pauseForSession(ref).pipe(asAda);
      assert.deepEqual([paused.pausedReason, paused.pausedBy], ["manual", setup.people.admin]);
      for (const attempt of [
        setup.makitaConfigs.resumeForSession(ref).pipe(Effect.asVoid),
        setup.makitaConfigs.removeForSession(ref).pipe(Effect.asVoid),
        setup.makitaConfigs
          .updateForSession({ ...input(ctx), configId: config.configId })
          .pipe(Effect.asVoid),
      ]) {
        assert.equal((yield* attempt.pipe(asAda, Effect.flip)).reason, "forbidden");
      }
      const resumed = yield* setup.makitaConfigs.resumeForSession(ref).pipe(asGrace(setup));
      assert.isNull(resumed.pausedAt);

      const byOwner = yield* setup.makitaConfigs.pauseForSession(ref).pipe(setup.asOwner);
      assert.equal(byOwner.pausedReason, "owner");
      const mine = yield* setup.makitaConfigs
        .listForSession({ spaceId: setup.acmeId })
        .pipe(asGrace(setup));
      assert.isFalse(mine.configs[0]!.canResume);
      assert.equal(
        (yield* setup.makitaConfigs.resumeForSession(ref).pipe(asGrace(setup), Effect.flip)).reason,
        "forbidden",
      );
      // The Owner neither edits it.
      assert.equal(
        (yield* setup.makitaConfigs
          .updateForSession({ ...input(ctx), configId: config.configId })
          .pipe(setup.asOwner, Effect.flip)).reason,
        "forbidden",
      );
      yield* setup.makitaConfigs.resumeForSession(ref).pipe(setup.asOwner);

      yield* setup.makitaConfigs.removeForSession(ref).pipe(asGrace(setup));
      assert.equal(
        (yield* setup.makitaConfigs.pauseForSession(ref).pipe(asGrace(setup), Effect.flip)).reason,
        "not-found",
      );
      assert.deepEqual(
        (yield* auditOf(setup, "makita.config.pause")).map((row) => [
          row.actor,
          JSON.parse(row.detail).reason,
        ]),
        [
          [setup.people.admin, "manual"],
          [setup.ownerId, "owner"],
        ],
      );
      assert.lengthOf(yield* auditOf(setup, "makita.config.resume"), 2);
      assert.lengthOf(yield* auditOf(setup, "makita.config.delete"), 1);
    }).pipe(Effect.scoped),
);

it.live.skipIf(!posix || platform === undefined)(
  "another Space sees nothing of Acme's configurations; the Owner sees every one; revoking Grace's permission pauses hers until it is given back",
  () =>
    Effect.gen(function* () {
      const ctx = yield* ready;
      const { setup } = ctx;
      const { config } = yield* setup.makitaConfigs
        .createForSession(input(ctx))
        .pipe(asGrace(setup));
      const ref = { configId: config.configId };
      const asGus = CommandActor.actAs(setup.people.globexMember);
      // Gus (Globex), Linus (Guest of Acme): no list of Acme's, no configuration by id.
      for (const as of [asGus, CommandActor.actAs(setup.people.guest)]) {
        assert.equal(
          (yield* setup.makitaConfigs
            .listForSession({ spaceId: setup.acmeId })
            .pipe(as, Effect.flip)).reason,
          "forbidden",
        );
        for (const attempt of [
          setup.makitaConfigs.pauseForSession(ref),
          setup.makitaConfigs.removeForSession(ref),
        ]) {
          assert.equal((yield* attempt.pipe(as, Effect.flip)).reason, "not-found");
        }
      }
      const gus = yield* setup.makitaConfigs.listForSession({}).pipe(asGus);
      assert.deepEqual(gus.configs, []);
      const everyone = yield* setup.makitaConfigs.listForSession({}).pipe(setup.asOwner);
      assert.isTrue(everyone.everyone);
      assert.deepEqual(
        everyone.configs.map((row) => [row.configId, row.spaceName]),
        [[config.configId, "Acme"]],
      );
      // Ada, an Admin, sees it in Acme without the permission, and may not create.
      const ada = yield* setup.makitaConfigs
        .listForSession({ spaceId: setup.acmeId })
        .pipe(CommandActor.actAs(setup.people.admin));
      assert.lengthOf(ada.configs, 1);
      assert.isFalse(ada.space!.canCreate);
      assert.deepEqual(ada.space!.aiAccounts, []);

      yield* setup.makitaPermissions
        .revokeForSession({ userId: setup.people.member, spaceId: setup.acmeId })
        .pipe(setup.asOwner);
      const after = yield* setup.makitaConfigs.listForSession({}).pipe(setup.asOwner);
      assert.deepEqual(
        [after.configs[0]!.pausedReason, after.configs[0]!.pausedBy],
        ["permission-revoked", setup.ownerId],
      );
      // She still sees it while in Acme, and cannot resume it without the permission.
      assert.equal(
        (yield* setup.makitaConfigs.resumeForSession(ref).pipe(asGrace(setup), Effect.flip)).reason,
        "forbidden",
      );
      yield* setup.makitaPermissions
        .grantForSession({ userId: setup.people.member, spaceId: setup.acmeId })
        .pipe(setup.asOwner);
      const back = yield* setup.makitaConfigs.resumeForSession(ref).pipe(asGrace(setup));
      assert.isNull(back.pausedAt);
      // Removing her from the Hub pauses everything of hers (creator-left).
      const status = (value: string) =>
        setup.server.request(`/api/installation/users/${setup.people.member}/status`, {
          body: { status: value },
          cookie: setup.ownerCookie,
        });
      assert.equal((yield* status("disabled")).status, 200);
      assert.equal((yield* status("removed")).status, 200);
      const gone = yield* setup.makitaConfigs.listForSession({}).pipe(setup.asOwner);
      assert.equal(gone.configs[0]!.pausedReason, "creator-left");
    }).pipe(Effect.scoped),
);
