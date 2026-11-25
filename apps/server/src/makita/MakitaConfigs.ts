// @effect-diagnostics nodeBuiltinImport:off -- random configuration ids, synchronous and small.
/**
 * Makita configurations (Makita ticket 03): who may use Makita in a Space says which repositories
 * it listens to, whom it answers, with which of their AI accounts and what it may do. The only
 * writer of `makita_configs` (pauses inside others' transactions go through makitaRows).
 * Batch 1 accepts a list of GitHub users, «Comment and analyse» and the Space's Sandbox only.
 */
import * as NodeCrypto from "node:crypto";

import {
  AI_GATEWAY_DRIVERS,
  type AiAccountId,
  MAKITA_CONFIG_MAX_PER_SPACE,
  MAKITA_GITHUB_HOST,
  type MakitaAiAccountOption,
  type MakitaConfig,
  type MakitaConfigInput,
  type MakitaConfigRef,
  type MakitaConfigSaveResult,
  type MakitaConfigUpdateInput,
  type MakitaConfigWarning,
  type MakitaConfigsListInput,
  type MakitaConfigsListResult,
  MakitaError,
  MakitaGitHubUser,
  type MakitaProjectRepo,
  MakitaRepos,
  type MakitaTaskApproveResult,
  type MakitaTaskRef,
  type MakitaTaskStopResult,
  MakitaTriggers,
  ModelSelection,
  ProjectId,
  type ProviderDriverKind,
  ProviderInstanceId,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as AiAccounts from "../ai/AiAccounts.ts";
import * as AllowedAiAccounts from "../ai/AllowedAiAccounts.ts";
import { chooseAiAccount } from "../ai/chooseAiAccount.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import { approveFromHubWithin } from "./makitaApprovalFlow.ts";
import { MakitaGitHub, type MakitaGitHubError } from "./MakitaGitHub.ts";
import { resolveProjectRepo, type ResolvedRepo } from "./MakitaRepos.ts";
import { permittedIn, stopTasksWithin } from "./makitaRows.ts";

const NOT_YOURS =
  "Makita is set up by a person in Platform settings or Space settings, not by an agent.";
const NO_SUCH_CONFIG = "No such Makita configuration.";
const NO_SUCH_TASK = "No such Makita task.";
const MAX_NAME = 80;
const MAX_CALLERS = 50;
const MAX_APPROVERS = 20;
const MAX_PROJECTS = 50;
const LABEL_COLOR = "6f42c1";
const LABEL_DESCRIPTION = "Makita, this repository's bot teammate, takes issues with this label.";
const AGENT_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
};

const jsonOf = (value: unknown) => JSON.stringify(value);
const decodeRepos = Schema.decodeUnknownOption(Schema.fromJsonString(MakitaRepos));
const decodeTriggers = Schema.decodeUnknownOption(Schema.fromJsonString(MakitaTriggers));
const decodeUsers = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(MakitaGitHubUser)),
);
const decodeSelection = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection));
const decodeGitHubUser = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ login: Schema.String, id: Schema.Number, type: Schema.String }),
  ),
);

const newConfigId = () => `mk_${NodeCrypto.randomBytes(12).toString("hex")}`;

/** A branch name git and GitHub accept, without the forms that mean something else. */
const validBranch = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(name) &&
  !name.includes("..") &&
  !name.includes("//") &&
  !name.endsWith("/") &&
  !name.endsWith(".") &&
  !name.endsWith(".lock");

/** A GitHub login: letters, digits and single hyphens, up to 39. */
const validLogin = (login: string) =>
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u.test(login);

interface ConfigRow {
  readonly configId: string;
  readonly spaceId: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reposJson: string;
  readonly triggersJson: string;
  readonly callersMode: MakitaConfig["callersMode"];
  readonly callersJson: string;
  readonly strangers: MakitaConfig["strangers"];
  readonly modelSelectionJson: string;
  readonly capability: MakitaConfig["capability"];
  readonly mayLand: number;
  readonly approval: MakitaConfig["approval"];
  readonly approversJson: string;
  readonly baseBranch: string | null;
  readonly environmentId: string | null;
  readonly pausedAt: string | null;
  readonly pausedBy: string | null;
  readonly pausedByName: string | null;
  readonly pausedReason: MakitaConfig["pausedReason"];
}

const CONFIG_SELECT = `
  SELECT c.config_id AS "configId", c.space_id AS "spaceId", c.name, c.created_by AS "createdBy",
    cu.display_name AS "createdByName", c.created_at AS "createdAt", c.updated_at AS "updatedAt",
    c.repos_json AS "reposJson", c.triggers_json AS "triggersJson",
    c.callers_mode AS "callersMode", c.callers_json AS "callersJson", c.strangers,
    c.model_selection_json AS "modelSelectionJson", c.capability, c.may_land AS "mayLand",
    c.approval, c.approvers_json AS "approversJson", c.base_branch AS "baseBranch",
    c.environment_id AS "environmentId", c.paused_at AS "pausedAt", c.paused_by AS "pausedBy",
    pu.display_name AS "pausedByName", c.paused_reason AS "pausedReason"
  FROM makita_configs c
  LEFT JOIN users cu ON cu.user_id = c.created_by
  LEFT JOIN users pu ON pu.user_id = c.paused_by`;

/** What a configuration says, checked: batch 1's values only. */
interface Checked {
  readonly name: string;
  readonly repos: MakitaRepos;
  /** Null when only an assignment or a mention starts a task (ticket 09). */
  readonly label: string | null;
  readonly triggers: MakitaTriggers;
  /** Ticket 08: also the creator alone, or the Space's Members, by their linked accounts. */
  readonly callersMode: "creator" | "list" | "members";
  /** Only for `list`. */
  readonly logins: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly baseBranch: string | null;
  /** Ticket 10: «Also push branches»; ticket 11: when a push waits, and who else approves. */
  readonly capability: MakitaConfig["capability"];
  readonly approval: MakitaConfig["approval"];
  readonly approverLogins: ReadonlyArray<string>;
}

export class MakitaConfigs extends Context.Service<
  MakitaConfigs,
  {
    readonly list: (
      input: MakitaConfigsListInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaConfigsListResult, MakitaError>;
    readonly create: (
      input: MakitaConfigInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaConfigSaveResult, MakitaError>;
    readonly update: (
      input: MakitaConfigUpdateInput & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaConfigSaveResult, MakitaError>;
    readonly remove: (
      input: MakitaConfigRef & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaConfig, MakitaError>;
    readonly pause: (
      input: MakitaConfigRef & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaConfig, MakitaError>;
    readonly resume: (
      input: MakitaConfigRef & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaConfig, MakitaError>;
    /** The same, for a person's own WS session only (never an agent, the shell or one Space). */
    readonly listForSession: (
      input: MakitaConfigsListInput,
    ) => Effect.Effect<MakitaConfigsListResult, MakitaError>;
    readonly createForSession: (
      input: MakitaConfigInput,
    ) => Effect.Effect<MakitaConfigSaveResult, MakitaError>;
    readonly updateForSession: (
      input: MakitaConfigUpdateInput,
    ) => Effect.Effect<MakitaConfigSaveResult, MakitaError>;
    readonly removeForSession: (input: MakitaConfigRef) => Effect.Effect<MakitaConfig, MakitaError>;
    readonly pauseForSession: (input: MakitaConfigRef) => Effect.Effect<MakitaConfig, MakitaError>;
    readonly resumeForSession: (input: MakitaConfigRef) => Effect.Effect<MakitaConfig, MakitaError>;
    /** Ticket 06: one task stopped now, by whoever may pause its configuration. */
    readonly stopTask: (
      input: MakitaTaskRef & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaTaskStopResult, MakitaError>;
    readonly stopTaskForSession: (
      input: MakitaTaskRef,
    ) => Effect.Effect<MakitaTaskStopResult, MakitaError>;
    /** Ticket 11: the Owner approves a task's waiting push from the Hub. */
    readonly approveTask: (
      input: MakitaTaskRef & { readonly actorUserId: UserId },
    ) => Effect.Effect<MakitaTaskApproveResult, MakitaError>;
    readonly approveTaskForSession: (
      input: MakitaTaskRef,
    ) => Effect.Effect<MakitaTaskApproveResult, MakitaError>;
    /**
     * Ticket 05, at each task's start: the AI account and model still a gateway one the creator
     * may use in the Space, serving the model (the same check as saving). Answers its name.
     */
    readonly checkSelection: (
      creator: UserId,
      spaceId: SpaceId,
      selection: ModelSelection,
    ) => Effect.Effect<string, MakitaError>;
  }
>()("t3/makita/MakitaConfigs") {}

const fail = (reason: MakitaError["reason"], message: string) =>
  Effect.fail(new MakitaError({ reason, message }));

/**
 * The values taken so far (the table holds the spec's others for later tickets): the creator, a
 * list of GitHub users or the Members (ticket 08), any trigger, «Comment and analyse» or
 * (ticket 10) «Also push branches», any approval and approvers (ticket 11), no landing, the Sandbox.
 */
const checkedInput = (
  input: Omit<MakitaConfigInput, "spaceId">,
):
  | { readonly _tag: "ok"; readonly value: Checked }
  | { readonly _tag: "refused"; readonly message: string } => {
  const refused = (message: string) => ({ _tag: "refused", message }) as const;
  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_NAME) {
    return refused(`Name the configuration (up to ${MAX_NAME} characters).`);
  }
  if ("projects" in input.repos) {
    const projects = input.repos.projects;
    if (projects.length === 0 || projects.length > MAX_PROJECTS) {
      return refused("Choose at least one Project, or all Projects with a GitHub remote.");
    }
    if (new Set(projects).size !== projects.length) return refused("Each Project once.");
  }
  // Ticket 09: the label, an assignment to Makita, a mention; at least one.
  const { assigned, mention } = input.triggers;
  const raw = input.triggers.label ?? "";
  const label = raw.trim();
  if (label.length === 0 && raw.length === 0 && !assigned && !mention) {
    return refused("Choose what hands an issue to Makita: a label, assigning it, or a mention.");
  }
  if ((label.length === 0 && raw.length > 0) || label.length > 50 || label !== raw) {
    return refused("Name the label that hands an issue to Makita (up to 50 characters).");
  }
  const callersMode = input.callersMode;
  if (callersMode === "anyone") {
    return refused(
      "For now Makita answers only you, a list of GitHub users, or this Space's Members with a linked GitHub account.",
    );
  }
  // «Only me» and «Members» keep no list: they read the linked accounts at each event.
  const logins =
    callersMode === "list" ? input.callers.map((login) => login.trim().replace(/^@/u, "")) : [];
  if (callersMode === "list" && (logins.length === 0 || logins.length > MAX_CALLERS)) {
    return refused(`Name 1 to ${MAX_CALLERS} GitHub users it answers.`);
  }
  const bad = logins.find((login) => !validLogin(login));
  if (bad !== undefined) return refused(`«${bad}» is not a GitHub login.`);
  if (input.strangers !== "ignore") {
    return refused("For now Makita stays silent with people not on the list.");
  }
  if (input.mayLand) {
    return refused("Landing on the default branch comes later.");
  }
  // Ticket 11: approvers besides the creator, by login, resolved to ids like the callers.
  const approverLogins = input.approvers.map((login) => login.trim().replace(/^@/u, ""));
  if (approverLogins.length > MAX_APPROVERS) {
    return refused(`Name at most ${MAX_APPROVERS} approvers besides you.`);
  }
  const badApprover = approverLogins.find((login) => !validLogin(login));
  if (badApprover !== undefined) return refused(`«${badApprover}» is not a GitHub login.`);
  if (input.environmentId !== null) {
    return refused("For now Makita works only in the Space's Sandbox.");
  }
  const baseBranch = input.baseBranch === null ? null : input.baseBranch.trim();
  if (baseBranch !== null && baseBranch.length > 0 && !validBranch(baseBranch)) {
    return refused(`«${baseBranch}» is not a branch name.`);
  }
  if (input.modelSelection.model.trim().length === 0) return refused("Choose a model.");
  return {
    _tag: "ok",
    value: {
      name,
      repos: input.repos,
      label: label.length === 0 ? null : label,
      triggers: { label: label.length === 0 ? null : label, assigned, mention },
      callersMode,
      logins: [...new Map(logins.map((login) => [login.toLowerCase(), login])).values()],
      modelSelection: input.modelSelection,
      baseBranch: baseBranch === null || baseBranch.length === 0 ? null : baseBranch,
      capability: input.capability,
      approval: input.approval,
      approverLogins: [
        ...new Map(approverLogins.map((login) => [login.toLowerCase(), login])).values(),
      ],
    },
  };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const audit = yield* AuditLog.AuditLog;
  const allowedAccounts = yield* AllowedAiAccounts.AllowedAiAccounts;
  const aiAccounts = yield* AiAccounts.AiAccounts;
  const github = yield* MakitaGitHub;
  const processes = yield* ProcessRunner.ProcessRunner;
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`MakitaConfigs: could not ${what}`, { cause }).pipe(
      Effect.andThen(fail("storage", `Could not ${what}. Try again.`)),
    );

  const principalFor = (userId: UserId) =>
    spaces.principalOf(userId).pipe(Effect.catch(storage("read who you are")));

  const spaceFor = (spaceId: SpaceId) =>
    spaces.spacesById([spaceId]).pipe(
      Effect.map((found) => found.get(spaceId)),
      Effect.catch(storage("read the Space")),
    );

  const permitted = (userId: UserId, spaceId: SpaceId) =>
    permittedIn(sql, userId, spaceId).pipe(Effect.catch(storage("read who may use Makita")));

  /** The Space as Makita's policy sees it for this User. */
  const makitaSpace = Effect.fn("MakitaConfigs.makitaSpace")(function* (
    userId: UserId,
    space: AccessPolicy.SpaceResource,
  ) {
    return {
      kind: "makita-space",
      space,
      permitted: yield* permitted(userId, space.id),
    } satisfies AccessPolicy.MakitaSpaceResource;
  });

  /** A Space's live Projects, each with its GitHub repository (read from its checkout). */
  const projectsOf = Effect.fn("MakitaConfigs.projectsOf")(function* (spaceId: SpaceId) {
    const rows = yield* sql<{
      readonly projectId: string;
      readonly title: string;
      readonly workspaceRoot: string;
    }>`
      SELECT project_id AS "projectId", title, workspace_root AS "workspaceRoot"
      FROM projection_projects
      WHERE space_id = ${spaceId} AND deleted_at IS NULL
      ORDER BY title, project_id
    `.pipe(Effect.catch(storage("read the Space's Projects")));
    return yield* Effect.forEach(
      rows,
      (row) =>
        resolveProjectRepo(row.workspaceRoot).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, processes),
          Effect.map((resolved: ResolvedRepo): MakitaProjectRepo => ({
            projectId: ProjectId.make(row.projectId),
            title: row.title,
            repo: resolved.repo,
            state: resolved.state,
          })),
        ),
      { concurrency: 4 },
    );
  });

  /** What a configuration listens to, out of its Space's Projects as they stand. */
  const projectsFor = (repos: MakitaRepos, inSpace: ReadonlyArray<MakitaProjectRepo>) =>
    "all" in repos
      ? inSpace.filter((project) => project.state === "ok")
      : repos.projects.map(
          (projectId): MakitaProjectRepo =>
            inSpace.find((project) => project.projectId === projectId) ?? {
              projectId,
              title: null,
              repo: null,
              state: "gone",
            },
        );

  const driverOf = Effect.fn("MakitaConfigs.driverOf")(function* (instanceId: string) {
    if (Option.isSome(settings)) {
      const current = yield* settings.value.getSettings.pipe(Effect.option);
      const configured = Option.isSome(current)
        ? current.value.providerInstances[instanceId as never]
        : undefined;
      if (configured !== undefined) return Option.some(String(configured.driver));
    }
    return AI_GATEWAY_DRIVERS.has(instanceId) ? Option.some(instanceId) : Option.none<string>();
  });

  const modelsOf = (accountId: AiAccountId) =>
    aiAccounts.modelsOf(accountId).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>()),
    );

  /** The AI account and model for a User in a Space: a gateway one they may use, serving it. */
  const checkedSelection = Effect.fn("MakitaConfigs.checkedSelection")(function* (
    userId: UserId,
    spaceId: SpaceId,
    selection: ModelSelection,
  ) {
    const driver = yield* driverOf(selection.instanceId);
    if (Option.isNone(driver) || !AI_GATEWAY_DRIVERS.has(driver.value)) {
      return yield* fail("invalid", "Choose an agent that works through the Hub's AI gateway.");
    }
    if (selection.aiAccountId === undefined) {
      return yield* fail("invalid", "Choose the AI account it spends.");
    }
    const allowed = yield* allowedAccounts
      .for(userId, spaceId)
      .pipe(Effect.catch(storage("read your AI accounts")));
    const account = allowed.find((candidate) => candidate.id === selection.aiAccountId);
    if (account === undefined) {
      return yield* fail("invalid", "Choose an AI account you may use in this Space.");
    }
    if (account.type === "direct") {
      return yield* fail(
        "invalid",
        "Choose an AI account that goes through the Hub's AI gateway, not a direct one.",
      );
    }
    const choice = yield* chooseAiAccount({
      driver: driver.value as ProviderDriverKind,
      allowed,
      chosen: selection.aiAccountId,
      model: selection.model,
      modelsOf,
      atTheDoor: true,
    });
    if (choice._tag === "refused") {
      return yield* fail(
        "invalid",
        choice.reason === "model-not-served"
          ? `${account.name} does not serve ${selection.model}.`
          : "Choose an AI account you may use in this Space.",
      );
    }
    return account.name;
  });

  /** The Projects named, live in the Space and each with one GitHub repository. */
  const checkedProjects = Effect.fn("MakitaConfigs.checkedProjects")(function* (
    spaceId: SpaceId,
    repos: MakitaRepos,
  ) {
    if ("all" in repos) return;
    const inSpace = yield* projectsOf(spaceId);
    for (const projectId of repos.projects) {
      const project = inSpace.find((candidate) => candidate.projectId === projectId);
      if (project === undefined) return yield* fail("invalid", "No such Project in this Space.");
      if (project.state === "no-remote") {
        return yield* fail("invalid", `«${project.title}» has no GitHub remote.`);
      }
      if (project.state === "ambiguous") {
        return yield* fail(
          "invalid",
          `Pick the GitHub remote of «${project.title}»: it has several (run \`gh repo set-default\` in its checkout).`,
        );
      }
    }
  });

  /** Each login's numeric id, with Makita's token; logins already known keep theirs. */
  const resolvedCallers = Effect.fn("MakitaConfigs.resolvedCallers")(function* (
    logins: ReadonlyArray<string>,
    known: ReadonlyArray<MakitaGitHubUser>,
  ) {
    const users: Array<MakitaGitHubUser> = [];
    for (const login of logins) {
      const kept = known.find((user) => user.login.toLowerCase() === login.toLowerCase());
      if (kept !== undefined) {
        users.push(kept);
        continue;
      }
      const answer = yield* github
        .rest({ operation: "resolve-login", path: `users/${encodeURIComponent(login)}` })
        .pipe(
          Effect.catch((error: MakitaGitHubError) =>
            error.reason === "not-found"
              ? fail("invalid", `There is no GitHub user «${login}».`)
              : error.reason === "no-token"
                ? fail(
                    "invalid",
                    "Makita's GitHub account is not registered yet: the Owner registers it in Platform → Makita.",
                  )
                : fail("github", `Could not look up «${login}» on GitHub: ${error.message}`),
          ),
        );
      const user = decodeGitHubUser(answer.body);
      if (Option.isNone(user)) {
        return yield* fail("github", `GitHub answered something unexpected for «${login}».`);
      }
      if (user.value.type !== "User") {
        return yield* fail("invalid", `«${user.value.login}» is not a person's account.`);
      }
      if (!users.some((existing) => existing.id === user.value.id)) {
        users.push({ id: user.value.id, login: user.value.login });
      }
    }
    return users;
  });

  /** After a save, the label in each repository it listens to: made when missing, else a note. */
  const ensureLabels = Effect.fn("MakitaConfigs.ensureLabels")(function* (input: {
    readonly configId: string;
    readonly configName: string;
    readonly spaceId: SpaceId;
    readonly label: string | null;
    readonly repos: ReadonlyArray<string>;
    readonly actorUserId: UserId;
  }) {
    const notes: Array<string> = [];
    const label = input.label;
    // No label trigger (ticket 09): nothing to make.
    if (label === null) return notes as ReadonlyArray<string>;
    for (const repo of new Set(input.repos)) {
      const labelPath = `repos/${repo}/labels/${encodeURIComponent(label)}`;
      const found = yield* github
        .rest({ operation: "label-get", path: labelPath })
        .pipe(Effect.result);
      if (found._tag === "Success") continue;
      if (found.failure.reason !== "not-found") {
        notes.push(`Could not check the label «${label}» in ${repo}: ${found.failure.message}`);
        continue;
      }
      const made = yield* github
        .rest({
          operation: "label-create",
          method: "POST",
          path: `repos/${repo}/labels`,
          body: { name: label, color: LABEL_COLOR, description: LABEL_DESCRIPTION },
        })
        .pipe(Effect.result);
      if (made._tag === "Failure") {
        notes.push(
          `Could not create the label «${label}» in ${repo}: ${made.failure.message} Create it there by hand.`,
        );
        continue;
      }
      yield* audit
        .record({
          actor: AuditLog.userActor(input.actorUserId),
          action: "makita.github.label",
          spaceId: input.spaceId,
          target: { kind: "makita_config", id: input.configId, name: input.configName },
          detail: { space: input.spaceId, repo, label: label, outcome: "created" },
        })
        .pipe(Effect.catch(storage("audit the label")));
    }
    return notes;
  });

  const readConfig = Effect.fn("MakitaConfigs.readConfig")(function* (configId: string) {
    const rows = yield* sql<ConfigRow>`
      ${sql.literal(CONFIG_SELECT)} WHERE c.config_id = ${configId} AND c.deleted_at IS NULL
    `.pipe(Effect.catch(storage("read the configuration")));
    return Option.fromUndefinedOr(rows[0]);
  });

  const configResource = Effect.fn("MakitaConfigs.configResource")(function* (
    userId: UserId,
    row: ConfigRow,
    space: AccessPolicy.SpaceResource,
  ) {
    return {
      kind: "makita-config",
      space,
      createdBy: UserId.make(row.createdBy),
      permitted: yield* permitted(userId, space.id),
      pausedByOwner: row.pausedReason === "owner",
    } satisfies AccessPolicy.MakitaConfigResource;
  });

  /** The configurations as this viewer sees them: names, repositories, warnings, what they may do. */
  const shown = Effect.fn("MakitaConfigs.shown")(function* (
    viewer: AccessPolicy.Principal,
    rows: ReadonlyArray<ConfigRow>,
  ) {
    const spaceIds = [...new Set(rows.map((row) => SpaceId.make(row.spaceId)))];
    const found = yield* spaces.spacesById(spaceIds).pipe(Effect.catch(storage("read the Spaces")));
    const projectsBySpace = new Map<string, ReadonlyArray<MakitaProjectRepo>>();
    for (const spaceId of spaceIds) projectsBySpace.set(spaceId, yield* projectsOf(spaceId));
    const accountIds = [
      ...new Set(
        rows.flatMap((row) => {
          const selection = decodeSelection(row.modelSelectionJson);
          return Option.isSome(selection) && selection.value.aiAccountId !== undefined
            ? [selection.value.aiAccountId]
            : [];
        }),
      ),
    ];
    const accountNames =
      accountIds.length === 0
        ? []
        : yield* sql<{ readonly id: string; readonly name: string }>`
            SELECT account_id AS id, name FROM ai_accounts WHERE ${sql.in("account_id", accountIds)}
          `.pipe(Effect.catch(storage("read the AI accounts")));
    const nameOf = new Map(accountNames.map((account) => [account.id, account.name]));
    // Ticket 04: repositories the poller could not read (403/404) since it last could.
    const unreachable = new Set(
      (yield* sql<{ readonly repo: string }>`
        SELECT DISTINCT repo FROM makita_repo_cursors
        WHERE host = ${MAKITA_GITHUB_HOST} AND unreachable_since IS NOT NULL
      `.pipe(Effect.catch(storage("read what Makita could not reach")))).map((row) =>
        row.repo.toLowerCase(),
      ),
    );
    const configs: Array<MakitaConfig> = [];
    for (const row of rows) {
      const space = found.get(SpaceId.make(row.spaceId));
      const selection = Option.getOrElse(
        decodeSelection(row.modelSelectionJson),
        (): ModelSelection => ({ instanceId: ProviderInstanceId.make("claudeAgent"), model: "" }),
      );
      const repos = Option.getOrElse(decodeRepos(row.reposJson), () => ({
        projects: [] as ReadonlyArray<ProjectId>,
      }));
      const projects = projectsFor(repos, projectsBySpace.get(row.spaceId) ?? []);
      const warnings: Array<MakitaConfigWarning> = [];
      if (!projects.some((project) => project.state === "ok")) warnings.push("no-repository");
      if (
        projects.some(
          (project) => project.repo !== null && unreachable.has(project.repo.toLowerCase()),
        )
      ) {
        warnings.push("repo-unreachable");
      }
      const creator = UserId.make(row.createdBy);
      const usable =
        selection.aiAccountId !== undefined &&
        (yield* allowedAccounts.for(creator, SpaceId.make(row.spaceId)).pipe(
          Effect.map((accounts) =>
            accounts.some(
              (account) => account.id === selection.aiAccountId && account.type !== "direct",
            ),
          ),
          Effect.orElseSucceed(() => false),
        ));
      if (!usable) warnings.push("ai-account-unavailable");
      const resource =
        space === undefined ? undefined : yield* configResource(viewer.userId, row, space.resource);
      const may = (action: AccessPolicy.Action) =>
        resource !== undefined &&
        AccessPolicy.isAllowed(AccessPolicy.decide(viewer, action, resource));
      configs.push({
        configId: row.configId,
        spaceId: SpaceId.make(row.spaceId),
        spaceName: space?.name ?? null,
        name: row.name,
        createdBy: creator,
        createdByName: row.createdByName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        repos,
        projects,
        triggers: Option.getOrElse(decodeTriggers(row.triggersJson), () => ({
          label: null,
          assigned: false,
          mention: false,
        })),
        callersMode: row.callersMode,
        callers: Option.getOrElse(decodeUsers(row.callersJson), () => []),
        strangers: row.strangers,
        modelSelection: selection,
        aiAccountName:
          selection.aiAccountId === undefined ? null : (nameOf.get(selection.aiAccountId) ?? null),
        capability: row.capability,
        mayLand: row.mayLand === 1,
        approval: row.approval,
        approvers: Option.getOrElse(decodeUsers(row.approversJson), () => []),
        baseBranch: row.baseBranch,
        environmentId: row.environmentId as MakitaConfig["environmentId"],
        pausedAt: row.pausedAt,
        pausedBy: row.pausedBy === null ? null : UserId.make(row.pausedBy),
        pausedByName: row.pausedByName,
        pausedReason: row.pausedReason,
        warnings,
        canEdit: may("makita.edit"),
        canPause: row.pausedAt === null && may("makita.pause"),
        canResume: row.pausedAt !== null && may("makita.resume"),
        canDelete: may("makita.delete"),
      });
    }
    return configs;
  });

  /** One configuration, if the viewer may see its Space's; another's answers like a missing one. */
  const visibleConfig = Effect.fn("MakitaConfigs.visibleConfig")(function* (
    actorUserId: UserId,
    configId: string,
  ) {
    const row = yield* readConfig(configId);
    if (Option.isNone(row)) return yield* fail("not-found", NO_SUCH_CONFIG);
    const principal = yield* principalFor(actorUserId);
    const space = yield* spaceFor(SpaceId.make(row.value.spaceId));
    const sees =
      space === undefined
        ? principal.isOwner && principal.inactive !== true
        : AccessPolicy.isAllowed(
            AccessPolicy.decide(
              principal,
              "makita.view",
              yield* makitaSpace(actorUserId, space.resource),
            ),
          ) ||
          // Its creator still sees it while they are in its Space, permission or not.
          (row.value.createdBy === actorUserId &&
            AccessPolicy.isAllowed(
              AccessPolicy.decide(
                principal,
                "makita.pause",
                yield* configResource(actorUserId, row.value, space.resource),
              ),
            ));
    if (!sees) return yield* fail("not-found", NO_SUCH_CONFIG);
    return { row: row.value, principal, space };
  });

  const answerOne = Effect.fn("MakitaConfigs.answerOne")(function* (
    principal: AccessPolicy.Principal,
    configId: string,
  ) {
    const rows = yield* sql<ConfigRow>`
      ${sql.literal(CONFIG_SELECT)} WHERE c.config_id = ${configId}
    `.pipe(Effect.catch(storage("read the configuration")));
    const [config] = yield* shown(principal, rows);
    if (config === undefined) return yield* fail("not-found", NO_SUCH_CONFIG);
    return config;
  });

  /** The form's choices for a User who may use Makita here. */
  const formOptions = Effect.fn("MakitaConfigs.formOptions")(function* (
    userId: UserId,
    spaceId: SpaceId,
  ) {
    const allowed = yield* allowedAccounts
      .for(userId, spaceId)
      .pipe(Effect.catch(storage("read your AI accounts")));
    const aiAccountOptions = yield* Effect.forEach(
      allowed.filter((account) => account.type !== "direct"),
      (account) =>
        modelsOf(account.id).pipe(
          Effect.map((models): MakitaAiAccountOption => ({
            id: account.id,
            name: account.name,
            type: account.type,
            provider: account.provider,
            models: Option.getOrNull(models),
          })),
        ),
      { concurrency: 4 },
    );
    const account = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM makita_account WHERE account_id = 'makita'
    `.pipe(Effect.catch(storage("read Makita's account")));
    return {
      accountReady: (account[0]?.n ?? 0) > 0,
      aiAccounts: aiAccountOptions,
      agents: [...AI_GATEWAY_DRIVERS].map((instanceId) => ({
        instanceId,
        label: AGENT_LABELS[instanceId] ?? instanceId,
      })),
    };
  });

  const list = Effect.fn("MakitaConfigs.list")(function* (
    input: MakitaConfigsListInput & { readonly actorUserId: UserId },
  ) {
    const principal = yield* principalFor(input.actorUserId);
    const read = Effect.fn("MakitaConfigs.read")(function* (
      spaceIds: ReadonlyArray<string> | null,
    ) {
      if (spaceIds !== null && spaceIds.length === 0) return [] as ReadonlyArray<ConfigRow>;
      const where =
        spaceIds === null
          ? sql`c.deleted_at IS NULL`
          : sql`c.deleted_at IS NULL AND ${sql.in("c.space_id", [...spaceIds])}`;
      return yield* sql<ConfigRow>`
        ${sql.literal(CONFIG_SELECT)} WHERE ${where}
        ORDER BY c.space_id, c.created_at, c.config_id
      `.pipe(Effect.catch(storage("list the configurations")));
    });

    if (input.spaceId !== undefined) {
      const space = yield* spaceFor(input.spaceId);
      if (space === undefined) {
        return yield* fail("forbidden", "You cannot see Makita in this Space.");
      }
      const resource = yield* makitaSpace(input.actorUserId, space.resource);
      if (!AccessPolicy.isAllowed(AccessPolicy.decide(principal, "makita.view", resource))) {
        return yield* fail("forbidden", "You cannot see Makita in this Space.");
      }
      const canCreate = AccessPolicy.isAllowed(
        AccessPolicy.decide(principal, "makita.use", resource),
      );
      const configs = yield* shown(principal, yield* read([input.spaceId]));
      const options = canCreate
        ? yield* formOptions(input.actorUserId, input.spaceId)
        : { accountReady: false, aiAccounts: [], agents: [] };
      return {
        configs,
        everyone: false,
        space: {
          canCreate,
          accountReady: options.accountReady,
          projects: canCreate ? yield* projectsOf(input.spaceId) : [],
          aiAccounts: options.aiAccounts,
          agents: options.agents,
        },
      } satisfies MakitaConfigsListResult;
    }

    if (principal.isOwner && principal.inactive !== true) {
      return {
        configs: yield* shown(principal, yield* read(null)),
        everyone: true,
        space: null,
      } satisfies MakitaConfigsListResult;
    }
    // Their Personal space and the Organizations they are in, where the policy agrees.
    const candidates = [
      SpaceDirectory.personalSpaceIdOf(input.actorUserId),
      ...principal.roles.keys(),
    ];
    const found = yield* spaces
      .spacesById(candidates)
      .pipe(Effect.catch(storage("read the Spaces")));
    const viewable: Array<string> = [];
    for (const space of found.values()) {
      const resource = yield* makitaSpace(input.actorUserId, space.resource);
      if (AccessPolicy.isAllowed(AccessPolicy.decide(principal, "makita.view", resource))) {
        viewable.push(space.resource.id);
      }
    }
    return {
      configs: yield* shown(principal, yield* read(viewable)),
      everyone: false,
      space: null,
    } satisfies MakitaConfigsListResult;
  });

  /** The repositories a saved configuration listens to now, for its label. */
  const reposNow = Effect.fn("MakitaConfigs.reposNow")(function* (
    spaceId: SpaceId,
    repos: MakitaRepos,
  ) {
    return projectsFor(repos, yield* projectsOf(spaceId)).flatMap((project) =>
      project.state === "ok" && project.repo !== null ? [project.repo] : [],
    );
  });

  /**
   * Makes one. `makita.use` first (so nobody else learns a Project's name or spends GitHub
   * requests), then the values and logins (outside the transaction: GitHub is slow); `makita.use`
   * again, the live count and the insert are one write transaction.
   */
  const create = Effect.fn("MakitaConfigs.create")(function* (
    input: MakitaConfigInput & { readonly actorUserId: UserId },
  ) {
    const space = yield* spaceFor(input.spaceId);
    const principal = yield* principalFor(input.actorUserId);
    if (
      space === undefined ||
      !AccessPolicy.isAllowed(
        AccessPolicy.decide(
          principal,
          "makita.use",
          yield* makitaSpace(input.actorUserId, space.resource),
        ),
      )
    ) {
      return yield* fail(
        "forbidden",
        "You cannot use Makita in this Space. The Owner gives that permission.",
      );
    }
    const checked = checkedInput(input);
    if (checked._tag === "refused") return yield* fail("invalid", checked.message);
    const value = checked.value;
    yield* checkedSelection(input.actorUserId, input.spaceId, value.modelSelection);
    yield* checkedProjects(input.spaceId, value.repos);
    const callers = yield* resolvedCallers(value.logins, []);
    const approvers = yield* resolvedCallers(value.approverLogins, []);
    const configId = newConfigId();
    const at = DateTime.formatIso(yield* DateTime.now);
    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const principal = yield* spaces.principalOf(input.actorUserId);
          const space = (yield* spaces.spacesById([input.spaceId])).get(input.spaceId);
          if (space === undefined) return { _tag: "forbidden" } as const;
          const decision = AccessPolicy.decide(principal, "makita.use", {
            kind: "makita-space",
            space: space.resource,
            permitted: yield* permittedIn(sql, input.actorUserId, input.spaceId),
          });
          if (decision._tag === "Deny") return { _tag: "denied", reason: decision.reason } as const;
          const live = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM makita_configs
            WHERE space_id = ${input.spaceId} AND deleted_at IS NULL
          `;
          if ((live[0]?.n ?? 0) >= MAKITA_CONFIG_MAX_PER_SPACE) return { _tag: "limit" } as const;
          yield* sql`
            INSERT INTO makita_configs (config_id, space_id, name, created_by, created_at,
              updated_at, repos_json, triggers_json, callers_mode, callers_json, strangers,
              model_selection_json, capability, may_land, approval, approvers_json, base_branch,
              environment_id)
            VALUES (${configId}, ${input.spaceId}, ${value.name}, ${input.actorUserId}, ${at},
              ${at}, ${jsonOf(value.repos)},
              ${jsonOf(value.triggers)}, ${value.callersMode},
              ${jsonOf(callers)}, 'ignore', ${jsonOf(value.modelSelection)}, ${value.capability}, 0,
              ${value.approval}, ${jsonOf(approvers)}, ${value.baseBranch}, NULL)
          `;
          yield* audit.record({
            actor: AuditLog.userActor(input.actorUserId),
            action: "makita.config.create",
            spaceId: input.spaceId,
            target: { kind: "makita_config", id: configId, name: value.name },
            detail: {
              space: input.spaceId,
              repos: "all" in value.repos ? "all" : value.repos.projects.length,
              callersMode: value.callersMode,
              capability: value.capability,
              mayLand: false,
              aiAccount: value.modelSelection.aiAccountId ?? null,
            },
          });
          return { _tag: "made", principal } as const;
        }),
      )
      .pipe(Effect.catch(storage("save the configuration")));
    switch (outcome._tag) {
      case "forbidden":
        return yield* fail("forbidden", "You cannot use Makita in this Space.");
      case "denied":
        return yield* fail(
          "forbidden",
          outcome.reason === "space-archived" || outcome.reason === "space-frozen"
            ? "This Space is archived: nothing new runs in it."
            : "You cannot use Makita in this Space. The Owner gives that permission.",
        );
      case "limit":
        return yield* fail(
          "limit",
          `This Space has ${MAKITA_CONFIG_MAX_PER_SPACE} Makita configurations. Delete one to make another.`,
        );
      case "made": {
        const notes = yield* ensureLabels({
          configId,
          configName: value.name,
          spaceId: input.spaceId,
          label: value.label,
          repos: yield* reposNow(input.spaceId, value.repos),
          actorUserId: input.actorUserId,
        });
        return {
          config: yield* answerOne(outcome.principal, configId),
          notes,
        } satisfies MakitaConfigSaveResult;
      }
    }
  });

  /** Changes one: its creator, with `makita.use`; the same checks as making it. */
  const update = Effect.fn("MakitaConfigs.update")(function* (
    input: MakitaConfigUpdateInput & { readonly actorUserId: UserId },
  ) {
    const found = yield* visibleConfig(input.actorUserId, input.configId);
    if (found.space === undefined) return yield* fail("forbidden", "This Space no longer exists.");
    const spaceId = SpaceId.make(found.row.spaceId);
    const resource = yield* configResource(input.actorUserId, found.row, found.space.resource);
    if (!AccessPolicy.isAllowed(AccessPolicy.decide(found.principal, "makita.edit", resource))) {
      return yield* fail("forbidden", "Only its creator, who may use Makita here, edits it.");
    }
    const checked = checkedInput(input);
    if (checked._tag === "refused") return yield* fail("invalid", checked.message);
    const value = checked.value;
    yield* checkedSelection(input.actorUserId, spaceId, value.modelSelection);
    yield* checkedProjects(spaceId, value.repos);
    const known = Option.getOrElse(decodeUsers(found.row.callersJson), () => []);
    const callers = yield* resolvedCallers(value.logins, known);
    const approvers = yield* resolvedCallers(
      value.approverLogins,
      Option.getOrElse(decodeUsers(found.row.approversJson), () => []),
    );
    const before = {
      name: found.row.name,
      repos: found.row.reposJson,
      triggers: found.row.triggersJson,
      callersMode: found.row.callersMode,
      callers: found.row.callersJson,
      modelSelection: found.row.modelSelectionJson,
      baseBranch: found.row.baseBranch,
      capability: found.row.capability,
      approval: found.row.approval,
      approvers: found.row.approversJson,
    };
    const after = {
      name: value.name,
      repos: jsonOf(value.repos),
      triggers: jsonOf(value.triggers),
      callersMode: value.callersMode,
      callers: jsonOf(callers),
      modelSelection: jsonOf(value.modelSelection),
      baseBranch: value.baseBranch,
      capability: value.capability,
      approval: value.approval,
      approvers: jsonOf(approvers),
    };
    const changed = (Object.keys(after) as Array<keyof typeof after>).filter(
      (key) => before[key] !== after[key],
    );
    const at = DateTime.formatIso(yield* DateTime.now);
    if (changed.length > 0) {
      const outcome = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const principal = yield* spaces.principalOf(input.actorUserId);
            const decision = AccessPolicy.decide(principal, "makita.edit", {
              ...resource,
              permitted: yield* permittedIn(sql, input.actorUserId, spaceId),
            });
            if (decision._tag === "Deny") return "denied" as const;
            const updated = yield* sql<{ readonly id: string }>`
              UPDATE makita_configs SET name = ${after.name}, repos_json = ${after.repos},
                triggers_json = ${after.triggers}, callers_mode = ${after.callersMode},
                callers_json = ${after.callers},
                model_selection_json = ${after.modelSelection}, base_branch = ${after.baseBranch},
                capability = ${after.capability}, approval = ${after.approval},
                approvers_json = ${after.approvers}, updated_at = ${at}
              WHERE config_id = ${input.configId} AND deleted_at IS NULL
              RETURNING config_id AS id
            `;
            if (updated.length === 0) return "gone" as const;
            yield* audit.record({
              actor: AuditLog.userActor(input.actorUserId),
              action: "makita.config.update",
              spaceId,
              target: { kind: "makita_config", id: input.configId, name: value.name },
              detail: {
                space: spaceId,
                changed: changed.join(","),
                capability: value.capability,
                mayLand: false,
                aiAccount: value.modelSelection.aiAccountId ?? null,
              },
            });
            return "changed" as const;
          }),
        )
        .pipe(Effect.catch(storage("save the configuration")));
      if (outcome === "denied") {
        return yield* fail("forbidden", "Only its creator, who may use Makita here, edits it.");
      }
      if (outcome === "gone") return yield* fail("not-found", NO_SUCH_CONFIG);
    }
    const notes = yield* ensureLabels({
      configId: input.configId,
      configName: value.name,
      spaceId,
      label: value.label,
      repos: yield* reposNow(spaceId, value.repos),
      actorUserId: input.actorUserId,
    });
    return {
      config: yield* answerOne(found.principal, input.configId),
      notes,
    } satisfies MakitaConfigSaveResult;
  });

  /** One of pause, resume or delete, decided by the policy and audited when it changes. */
  const act = Effect.fn("MakitaConfigs.act")(function* (
    input: MakitaConfigRef & { readonly actorUserId: UserId },
    action: "makita.pause" | "makita.resume" | "makita.delete",
  ) {
    const found = yield* visibleConfig(input.actorUserId, input.configId);
    const spaceId = SpaceId.make(found.row.spaceId);
    const allowed =
      found.space === undefined
        ? found.principal.isOwner && action !== "makita.resume"
        : AccessPolicy.isAllowed(
            AccessPolicy.decide(
              found.principal,
              action,
              yield* configResource(input.actorUserId, found.row, found.space.resource),
            ),
          );
    if (!allowed) {
      return yield* fail(
        "forbidden",
        action === "makita.resume" && found.row.pausedReason === "owner"
          ? "The Owner paused this configuration: only the Owner resumes it."
          : action === "makita.pause"
            ? "You cannot pause this configuration."
            : action === "makita.resume"
              ? "You cannot resume this configuration."
              : "Only its creator or the Owner deletes it.",
      );
    }
    const at = DateTime.formatIso(yield* DateTime.now);
    const reason =
      found.principal.isOwner && found.row.createdBy !== input.actorUserId ? "owner" : "manual";
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const changed =
            action === "makita.pause"
              ? yield* sql<{ readonly id: string }>`
                  UPDATE makita_configs SET paused_at = ${at}, paused_by = ${input.actorUserId},
                    paused_reason = ${reason}, updated_at = ${at}
                  WHERE config_id = ${input.configId} AND deleted_at IS NULL AND paused_at IS NULL
                  RETURNING config_id AS id
                `
              : action === "makita.resume"
                ? yield* sql<{ readonly id: string }>`
                    UPDATE makita_configs SET paused_at = NULL, paused_by = NULL,
                      paused_reason = NULL, updated_at = ${at}
                    WHERE config_id = ${input.configId} AND deleted_at IS NULL
                      AND paused_at IS NOT NULL
                    RETURNING config_id AS id
                  `
                : yield* sql<{ readonly id: string }>`
                    UPDATE makita_configs SET deleted_at = ${at}, updated_at = ${at}
                    WHERE config_id = ${input.configId} AND deleted_at IS NULL
                    RETURNING config_id AS id
                  `;
          if (changed.length === 0) return;
          // Paused or deleted, its running work stops in the same transaction (ticket 06).
          if (action !== "makita.resume") {
            yield* stopTasksWithin(sql, {
              actor: AuditLog.userActor(input.actorUserId),
              scope: { configId: input.configId },
              reason: action === "makita.pause" ? "config-paused" : "config-deleted",
            });
          }
          const entry = {
            actor: AuditLog.userActor(input.actorUserId),
            spaceId,
            target: { kind: "makita_config", id: input.configId, name: found.row.name },
          } as const;
          yield* action === "makita.pause"
            ? audit.record({
                ...entry,
                action: "makita.config.pause",
                detail: { space: spaceId, reason },
              })
            : action === "makita.resume"
              ? audit.record({
                  ...entry,
                  action: "makita.config.resume",
                  detail: { space: spaceId },
                })
              : audit.record({
                  ...entry,
                  action: "makita.config.delete",
                  detail: { space: spaceId },
                });
        }),
      )
      .pipe(Effect.catch(storage("change the configuration")));
    return yield* answerOne(found.principal, input.configId);
  });

  /** The person behind a WS session: never an agent, the Hub's shell or a one-Space session. */
  const sessionUser = Effect.gen(function* () {
    const actor = yield* CommandActor.resolve;
    if (actor._tag !== "User" || actor.via !== undefined || actor.spaceLimit !== undefined) {
      return yield* fail("forbidden", NOT_YOURS);
    }
    return actor.userId;
  });

  const remove = (input: MakitaConfigRef & { readonly actorUserId: UserId }) =>
    act(input, "makita.delete");
  const pause = (input: MakitaConfigRef & { readonly actorUserId: UserId }) =>
    act(input, "makita.pause");
  const resume = (input: MakitaConfigRef & { readonly actorUserId: UserId }) =>
    act(input, "makita.resume");

  /** One task stopped now (ticket 06): `makita.pause` on its configuration; its turn interrupted by MakitaStops. */
  const stopTask = Effect.fn("MakitaConfigs.stopTask")(function* (
    input: MakitaTaskRef & { readonly actorUserId: UserId },
  ) {
    const [task] = yield* sql<{ readonly configId: string }>`
      SELECT config_id AS "configId" FROM makita_tasks WHERE task_id = ${input.taskId}
    `.pipe(Effect.catch(storage("read the task")));
    if (task === undefined) return yield* fail("not-found", NO_SUCH_TASK);
    // A task of a configuration the actor cannot see answers like a missing one.
    const found = yield* visibleConfig(input.actorUserId, task.configId).pipe(
      Effect.catchIf(
        (error) => error.reason === "not-found",
        () => fail("not-found", NO_SUCH_TASK),
      ),
    );
    const allowed =
      found.space === undefined
        ? found.principal.isOwner
        : AccessPolicy.isAllowed(
            AccessPolicy.decide(
              found.principal,
              "makita.pause",
              yield* configResource(input.actorUserId, found.row, found.space.resource),
            ),
          );
    if (!allowed) return yield* fail("forbidden", "You cannot stop this Makita task.");
    const stopped = yield* sql
      .withTransaction(
        stopTasksWithin(sql, {
          actor: AuditLog.userActor(input.actorUserId),
          scope: { taskId: input.taskId },
          reason: "manual",
        }),
      )
      .pipe(Effect.catch(storage("stop the task")));
    return { stopped: stopped.length > 0 } satisfies MakitaTaskStopResult;
  });

  /**
   * Ticket 11: the Owner's «Approve» on a task's waiting push (AccessPolicy `makita.approve`);
   * anyone else is refused before the task is read, so it says nothing about the task.
   */
  const approveTask = Effect.fn("MakitaConfigs.approveTask")(function* (
    input: MakitaTaskRef & { readonly actorUserId: UserId },
  ) {
    const principal = yield* principalFor(input.actorUserId);
    if (!principal.isOwner || principal.inactive === true) {
      return yield* fail("forbidden", "Only the Owner approves a Makita push from the Hub.");
    }
    const [task] = yield* sql<{ readonly configId: string }>`
      SELECT config_id AS "configId" FROM makita_tasks WHERE task_id = ${input.taskId}
    `.pipe(Effect.catch(storage("read the task")));
    if (task === undefined) return yield* fail("not-found", NO_SUCH_TASK);
    const found = yield* visibleConfig(input.actorUserId, task.configId).pipe(
      Effect.catchIf(
        (error) => error.reason === "not-found",
        () => fail("not-found", NO_SUCH_TASK),
      ),
    );
    const allowed =
      found.space !== undefined &&
      AccessPolicy.isAllowed(
        AccessPolicy.decide(
          found.principal,
          "makita.approve",
          yield* configResource(input.actorUserId, found.row, found.space.resource),
        ),
      );
    if (!allowed) {
      return yield* fail("forbidden", "Nothing runs in this Space now, so nothing is approved.");
    }
    const outcome = yield* sql
      .withTransaction(
        approveFromHubWithin(sql, { taskId: input.taskId, actorUserId: input.actorUserId }),
      )
      .pipe(Effect.catch(storage("approve the push")));
    if (outcome === "nothing-pending") {
      return yield* fail("invalid", "Nothing of this task is waiting for approval.");
    }
    return { approved: outcome === "approved" } satisfies MakitaTaskApproveResult;
  });

  return MakitaConfigs.of({
    checkSelection: checkedSelection,
    list,
    create,
    update,
    remove,
    pause,
    resume,
    listForSession: Effect.fn("MakitaConfigs.listAsSession")(function* (
      input: MakitaConfigsListInput,
    ) {
      return yield* list({ ...input, actorUserId: yield* sessionUser });
    }),
    createForSession: Effect.fn("MakitaConfigs.createAsSession")(function* (
      input: MakitaConfigInput,
    ) {
      return yield* create({ ...input, actorUserId: yield* sessionUser });
    }),
    updateForSession: Effect.fn("MakitaConfigs.updateAsSession")(function* (
      input: MakitaConfigUpdateInput,
    ) {
      return yield* update({ ...input, actorUserId: yield* sessionUser });
    }),
    removeForSession: Effect.fn("MakitaConfigs.removeAsSession")(function* (
      input: MakitaConfigRef,
    ) {
      return yield* remove({ ...input, actorUserId: yield* sessionUser });
    }),
    pauseForSession: Effect.fn("MakitaConfigs.pauseAsSession")(function* (input: MakitaConfigRef) {
      return yield* pause({ ...input, actorUserId: yield* sessionUser });
    }),
    resumeForSession: Effect.fn("MakitaConfigs.resumeAsSession")(function* (
      input: MakitaConfigRef,
    ) {
      return yield* resume({ ...input, actorUserId: yield* sessionUser });
    }),
    stopTask,
    stopTaskForSession: Effect.fn("MakitaConfigs.stopTaskAsSession")(function* (
      input: MakitaTaskRef,
    ) {
      return yield* stopTask({ ...input, actorUserId: yield* sessionUser });
    }),
    approveTask,
    approveTaskForSession: Effect.fn("MakitaConfigs.approveTaskAsSession")(function* (
      input: MakitaTaskRef,
    ) {
      return yield* approveTask({ ...input, actorUserId: yield* sessionUser });
    }),
  });
});

/** Needs Makita's GitHub client, the AI accounts and a process runner (git, in each checkout). */
export const layer = Layer.effect(MakitaConfigs, make);
