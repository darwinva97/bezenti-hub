// @effect-diagnostics nodeBuiltinImport:off - real git checkouts for the Projects.
/**
 * A Hub where Makita is ready (Makita tickets 04–05): its account registered with a fake token,
 * Grace allowed in Acme, an Acme Project whose checkout's remote is `acme/widgets`, an AI account
 * she may use, and GitHub users octocat (1), Grace-GH (3), a bot and a stranger.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  EnvironmentId,
  type MakitaConfigInput,
  ProjectId,
  ProviderInstanceId,
  type SpaceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as CommandActor from "../auth/CommandActor.ts";
import { makitaHub, type MakitaHub } from "./Makita.testkit.ts";
import { classicToken, type FakeGitHubUser } from "./MakitaGitHub.testkit.ts";

const MODEL = "claude-sonnet-5-5";
export const MAKITA_BOT: FakeGitHubUser = { login: "makita-bot", id: 4242 };
export const OCTOCAT: FakeGitHubUser = { login: "octocat", id: 1 };
export const GRACE_GH: FakeGitHubUser = { login: "Grace-GH", id: 3 };
export const STRANGER: FakeGitHubUser = { login: "mallory", id: 666 };
export const DEPENDABOT: FakeGitHubUser = { login: "dependabot", id: 9, type: "Bot" };

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
    const projectId = ProjectId.make(`makita-fixture-project-${projects}`);
    const at = "2026-11-24T00:00:00.000Z";
    yield* setup.server.sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
        created_at, updated_at, space_id, owner_user_id)
      VALUES (${projectId}, ${title}, ${root}, '[]', ${at}, ${at}, ${spaceId}, ${setup.ownerId})
    `;
    return projectId;
  });

const asGrace = (setup: MakitaHub) => CommandActor.actAs(setup.people.member);

/**
 * Ticket 15: machines as the registry keeps them: one dedicated to Acme, Grace's and Gus's
 * personal ones, Gus's lent to Acme by a Grant (a Sandbox of its own), one dedicated to Globex.
 */
export const makitaMachines = (setup: MakitaHub) =>
  Effect.gen(function* () {
    const at = "2026-11-24T00:00:00.000Z";
    yield* setup.server.sql`
      INSERT INTO environments (environment_id, name, kind, mode, owner_user_id, space_id,
        credential_hash, credential_issued_at, registered_at)
      VALUES
        ('acme-box', 'Acme box', 'external', 'dedicated', NULL, ${setup.acmeId},
          'hash-acme-box', ${at}, ${at}),
        ('grace-laptop', 'Grace laptop', 'external', 'personal', ${setup.people.member}, NULL,
          'hash-grace-laptop', ${at}, ${at}),
        ('gus-laptop', 'Gus laptop', 'external', 'personal', ${setup.people.globexMember}, NULL,
          'hash-gus-laptop', ${at}, ${at}),
        ('globex-box', 'Globex box', 'external', 'dedicated', NULL, ${setup.globexId},
          'hash-globex-box', ${at}, ${at})
    `;
    yield* setup.server.sql`
      INSERT INTO environments (environment_id, name, kind, mode, space_id, registered_at,
        grant_id, host_environment_id)
      VALUES ('lent:gus-to-acme', 'Gus laptop for Acme', 'sandbox', 'lent', ${setup.acmeId},
        ${at}, 'gus-to-acme', 'gus-laptop')
    `;
    return {
      box: EnvironmentId.make("acme-box"),
      laptop: EnvironmentId.make("grace-laptop"),
      lent: EnvironmentId.make("lent:gus-to-acme"),
      globexBox: EnvironmentId.make("globex-box"),
    };
  });

/** The Owner dedicates the machine to Globex instead: it is no longer Acme's. */
export const moveMachineToGlobex = (setup: MakitaHub, environmentId: EnvironmentId) =>
  setup.server.sql`
    UPDATE environments SET space_id = ${setup.globexId} WHERE environment_id = ${environmentId}
  `;

/** Makita ready in Acme; no configuration yet. */
export const makitaReady = Effect.gen(function* () {
  const setup = yield* makitaHub;
  const token = classicToken("intake");
  setup.github.tokens.set(token, { user: MAKITA_BOT, scopes: ["public_repo"] });
  for (const user of [OCTOCAT, GRACE_GH, STRANGER, DEPENDABOT]) {
    setup.github.users.set(user.login.toLowerCase(), user);
  }
  setup.github.repos.set("acme/widgets", new Set(["makita"]));
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
  const acmeClaude = yield* setup.account("Acme Claude", "claude", { spaceIds: [setup.acmeId] });
  const input = (over: Partial<MakitaConfigInput> = {}): MakitaConfigInput => ({
    spaceId: setup.acmeId,
    name: "Widget bugs",
    repos: { projects: [widgets] },
    triggers: { label: "makita", assigned: false, mention: false },
    callersMode: "list",
    callers: [OCTOCAT.login],
    strangers: "ignore",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: MODEL,
      aiAccountId: acmeClaude,
    },
    capability: "comment",
    mayLand: false,
    approval: "others",
    approvers: [],
    baseBranch: null,
    environmentId: null,
    ...over,
  });
  /** Grace makes a configuration (by default: Widgets, the `makita` label, octocat). */
  const configure = (over: Partial<MakitaConfigInput> = {}) =>
    setup.makitaConfigs.createForSession(input(over)).pipe(
      asGrace(setup),
      Effect.map((saved) => saved.config),
    );
  /** Every cursor due now, as if its time had come. */
  const due = setup.server.sql`UPDATE makita_repo_cursors SET next_poll_at = NULL`;
  const events = setup.server.sql<{
    readonly key: string;
    readonly number: number;
    readonly kind: string;
    readonly actor: number | null;
    readonly login: string | null;
    readonly configId: string | null;
    readonly taskId: string | null;
    readonly outcome: string;
    readonly detail: string | null;
  }>`
    SELECT event_key AS key, number, kind, actor_github_id AS actor, actor_login AS login,
      config_id AS "configId", task_id AS "taskId", outcome, detail
    FROM makita_events ORDER BY seen_at, event_key
  `;
  const cursor = setup.server.sql<{
    readonly etag: string | null;
    readonly cursor: string | null;
    readonly nextPollAt: string | null;
    readonly lastError: string | null;
    readonly unreachableSince: string | null;
  }>`
    SELECT etag, cursor, next_poll_at AS "nextPollAt", last_error AS "lastError",
      unreachable_since AS "unreachableSince"
    FROM makita_repo_cursors WHERE repo = 'acme/widgets' AND feed = 'issue-events'
  `;
  /** Requests made to the issue-events feed so far. */
  const feedReads = () =>
    setup.github.requests.filter((request) => /issues\/events/u.test(request.path));
  return { setup, widgets, acmeClaude, input, configure, due, events, cursor, feedReads };
});

export type MakitaReady = Effect.Success<typeof makitaReady>;
