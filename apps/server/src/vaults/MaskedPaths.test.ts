// @effect-diagnostics nodeBuiltinImport:off - reads the server's own sources and runs git.
// @effect-diagnostics anyUnknownInErrorContext:off - a door's proof fails with whatever it failed with.
// @effect-diagnostics globalErrorInEffectFailure:off - a failed proof names its door for the report.
/**
 * Spec 5 ticket 05, the inventory: every door of the Hub (as DoorRules lists them) and every
 * executor operation has a rule in `MaskedPaths.ts`, by name (a new door has none and fails here).
 * Every door marked masked is called here with a secret, on a Hub whose Thread holds one, and must
 * answer `[NAME]`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  CommandId,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  type EnvironmentSessionPrincipalShape,
  type GitActionProgressEvent,
  type OrchestrationV2CommandOutputFrame,
  type ThreadId,
  TurnItemId,
  type UserId,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { issueAssetUrl, resolveAsset } from "../assets/AssetAccess.ts";
import * as AssetSigner from "../assets/AssetSigner.ts";
import { maskedMachineAsset } from "../assets/MachineAssetResponse.ts";
import { machineOver } from "../assets/MachineAssets.testkit.ts";
import { MCP_TOOL_RULES, RAW_ROUTE_RULES } from "../auth/DoorRules.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import { REMOTE_OPERATIONS, REMOTE_STREAM_ITEMS } from "../environment/RemoteExecutorWire.ts";
import type * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import {
  hubCheckoutOf,
  OWNER_TOKEN,
  threadWorkspaceOf,
  turnThatPrintsTheSecret,
} from "../environments/HubWithEnvironments.secretMasking.testkit.ts";
import type { Hub } from "../environments/HubWithEnvironments.testkit.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ReviewService from "../review/ReviewService.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import * as PullRequestReviewGuides from "../persistence/PullRequestReviewGuides.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { maskedAssetText } from "./maskAssets.ts";
import { maskGitProgress, maskingGitErrors, maskingServiceFailures } from "./maskGitProgress.ts";
import { maskingPullRequestReads } from "./maskPullRequests.ts";
import {
  type DoorRule,
  EXECUTOR_OPERATIONS,
  HTTP_DOOR_RULES,
  MCP_DOOR_RULES,
  ORCHESTRATION_TABLE_WRITERS,
  RAW_DOOR_RULES,
  WS_DOOR_RULES,
} from "./MaskedPaths.ts";
import * as SecretMasker from "./SecretMasker.ts";

const SRC = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const sources = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "testkit" ? [] : sources(full);
    return entry.name.endsWith(".ts") && !/\.test(kit)?\.ts$|\.testkit\.ts$/.test(entry.name)
      ? [full]
      : [];
  });

const files = new Map(
  sources(SRC).map((file) => [
    NodePath.relative(SRC, file).replaceAll("\\", "/"),
    NodeFS.readFileSync(file, "utf8"),
  ]),
);

const endpoints = (() => {
  const found: Array<string> = [];
  HttpApi.reflect(EnvironmentHttpApi, {
    onGroup: () => undefined,
    onEndpoint: ({ group, endpoint }) => found.push(`${group.identifier}.${endpoint.identifier}`),
  });
  return found;
})();

const DOORS = {
  ws: { doors: [...WsRpcGroup.requests.keys()], rules: WS_DOOR_RULES },
  http: { doors: endpoints, rules: HTTP_DOOR_RULES },
  raw: { doors: Object.keys(RAW_ROUTE_RULES), rules: RAW_DOOR_RULES },
  mcp: { doors: Object.keys(MCP_TOOL_RULES), rules: MCP_DOOR_RULES },
  executor: {
    doors: [...new Set([...Object.keys(REMOTE_OPERATIONS), ...Object.keys(REMOTE_STREAM_ITEMS)])],
    rules: EXECUTOR_OPERATIONS as Record<string, DoorRule>,
  },
};

// ── The proofs: each masked door, called with the Owner's secret ────────────────────────────────

interface Scenario {
  readonly hub: Hub;
  readonly owner: UserId;
  readonly threadId: ThreadId;
  readonly workspace: ThreadWorkspace.ThreadWorkspace["Service"];
  /** The Hub machine's copy of the Thread's Project. */
  readonly cwd: string;
}

type Proof = (scenario: Scenario) => Effect.Effect<void, unknown>;

const shownMasked = (text: string, door: string) => {
  expect(text, door).toContain("[OWNER_TOKEN]");
  expect(text, door).not.toContain(OWNER_TOKEN);
};

/** An effect of the Hub's own services, made for the Owner (the request's principal). */
const asOwner = <A, E>(scenario: Scenario, effect: Effect.Effect<A, E, never>) =>
  effect.pipe(
    Effect.provideService(EnvironmentAuthenticatedPrincipal, {
      userId: scenario.owner,
    } as unknown as EnvironmentSessionPrincipalShape),
  );

const inHub = <A, E>(scenario: Scenario, effect: Effect.Effect<A, E, unknown>) =>
  asOwner(
    scenario,
    effect.pipe(Effect.provideContext(scenario.hub.server.services as never)) as Effect.Effect<
      A,
      E
    >,
  );

const caller = (scenario: Scenario) => ({ userId: scenario.owner });

const readFile: Proof = (scenario) =>
  Effect.gen(function* () {
    const read = yield* scenario.workspace.readFile(
      { cwd: scenario.cwd, relativePath: "notes.md", threadId: scenario.threadId },
      caller(scenario),
    );
    shownMasked(read.contents, "files.read");
    expect(read.masked).toBe(true);
  });

const searchContents: Proof = (scenario) =>
  Effect.gen(function* () {
    const search = yield* scenario.workspace.searchContents(
      {
        cwd: scenario.cwd,
        query: "turn 1",
        limit: 10,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
        threadId: scenario.threadId,
      },
      caller(scenario),
    );
    // The only line that matches holds the value: never shown, not even masked.
    expect(JSON.stringify(search)).not.toContain(OWNER_TOKEN);
    expect(search.matches.filter((match) => match.path.endsWith("notes.md"))).toEqual([]);
  });

const writeFile: Proof = (scenario) =>
  Effect.gen(function* () {
    const refused = yield* Effect.flip(
      scenario.workspace.writeFile(
        {
          cwd: scenario.cwd,
          relativePath: "notes.md",
          contents: "TOKEN=[OWNER_TOKEN] (turn 1)\nedited\n",
          threadId: scenario.threadId,
        },
        caller(scenario),
      ),
    );
    expect(String((refused as { readonly message?: unknown }).message)).toContain("secrets");
  });

/** A terminal that printed the value, watched by `attach` or `observe`, and its snapshot. */
const terminal =
  (watch: "attach" | "observe"): Proof =>
  (scenario) =>
    Effect.gen(function* () {
      const terminalId = `term-${watch}`;
      const input = { threadId: scenario.threadId, terminalId };
      yield* scenario.workspace.terminalOpen(
        { ...input, cwd: scenario.cwd, cols: 80, rows: 24 },
        caller(scenario),
      );
      const ready = yield* Deferred.make<void>();
      const frames = yield* Queue.unbounded<string>();
      const stream =
        watch === "attach"
          ? scenario.workspace.terminalAttach(input, `viewer-${watch}`, caller(scenario))
          : scenario.workspace.terminalObserve(input, caller(scenario));
      yield* stream.pipe(
        Stream.runForEach((event) =>
          event.type === "snapshot"
            ? Deferred.succeed(ready, undefined)
            : event.type === "output"
              ? Queue.offer(frames, event.data)
              : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      yield* scenario.workspace.terminalWrite(
        { ...input, data: "echo $OWNER_TOKEN\r" },
        caller(scenario),
      );
      shownMasked(yield* Queue.take(frames), `terminal.${watch}`);
      const reopened = yield* scenario.workspace.terminalOpen(
        { ...input, cwd: scenario.cwd, cols: 80, rows: 24 },
        caller(scenario),
      );
      shownMasked(reopened.history, "terminal.open");
    }).pipe(Effect.scoped);

const turnDiff: Proof = (scenario) =>
  Effect.gen(function* () {
    const diffs = scenario.hub.service(CheckpointDiffQuery.CheckpointDiffQuery);
    const turn = yield* diffs.getTurnDiff({
      threadId: scenario.threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
    });
    shownMasked(turn.diff, "getTurnDiff");
  });

const fullThreadDiff: Proof = (scenario) =>
  Effect.gen(function* () {
    const diffs = scenario.hub.service(CheckpointDiffQuery.CheckpointDiffQuery);
    const whole = yield* diffs.getFullThreadDiff({ threadId: scenario.threadId, toTurnCount: 1 });
    shownMasked(whole.diff, "getFullThreadDiff");
  });

const rejectedCommand: Proof = (scenario) =>
  Effect.gen(function* () {
    const receipt = yield* scenario.hub.service(EventSink.EventSinkV2).commitRejectedCommand({
      commandId: CommandId.make("command:masked-door"),
      threadId: scenario.threadId,
      commandType: "thread.turn.start",
      rejectedAt: yield* DateTime.now,
      error: `git push said ${OWNER_TOKEN}`,
    });
    shownMasked(JSON.stringify(receipt), "dispatchCommand");
  });

/** Each call writes its own item. */
let calls = 0;

const commandOutput: Proof = (scenario) =>
  Effect.gen(function* () {
    const projection = yield* scenario.hub
      .service(Orchestrator.OrchestratorV2)
      .getThreadProjection(scenario.threadId);
    const call = (calls += 1);
    const itemId = TurnItemId.make(`item:masked-door-${call}`);
    const now = yield* DateTime.now;
    yield* scenario.hub.service(EventSink.EventSinkV2).write({
      events: [
        {
          id: `event:masked-door-${call}` as never,
          type: "turn-item.updated",
          threadId: scenario.threadId,
          driver: "claudeAgent" as never,
          providerInstanceId: projection.thread.modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: itemId,
            threadId: scenario.threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 99,
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "command_execution",
            input: "echo $OWNER_TOKEN",
            status: "running",
          },
        } as never,
      ],
    });
    const hub = scenario.hub.service(CommandOutputHub.CommandOutputHub);
    const frames = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame>();
    yield* hub.subscribe({ threadId: scenario.threadId, itemId }).pipe(
      Stream.runForEach((frame) => Queue.offer(frames, frame)),
      Effect.forkScoped,
    );
    yield* hub.append({
      threadId: scenario.threadId,
      itemId,
      chunk: `out ${OWNER_TOKEN} done\n`,
    });
    let seen = "";
    while (!seen.includes("done")) seen += (yield* Queue.take(frames)).text;
    shownMasked(seen, "subscribeCommandOutput");
  }).pipe(Effect.scoped);

const worktreeSetup: Proof = (scenario) =>
  Effect.gen(function* () {
    const tracker = yield* inHub(
      scenario,
      Effect.service(WorktreeSetupTracker.WorktreeSetupTracker).pipe(
        Effect.provide(WorktreeSetupTracker.layer),
      ),
    );
    yield* tracker.begin({
      threadId: scenario.threadId,
      branch: null,
      baseRef: null,
      stages: ["setup-script"],
      fiber: null,
    });
    yield* tracker.appendTail(scenario.threadId, "setup-script", `TOKEN=${OWNER_TOKEN}`);
    shownMasked(JSON.stringify(yield* tracker.get(scenario.threadId)), "subscribeWorktreeSetup");
  });

/** What the asset route signs and resolves with, over the Hub's own secret store. */
const assetLayers = Layer.merge(WorkspacePaths.layer, AssetSigner.layer);

const assetUrl: Proof = (scenario) =>
  Effect.gen(function* () {
    const file = NodePath.join(scenario.cwd, "proof-asset.txt");
    yield* Effect.promise(() => NodeFSP.writeFile(file, `TOKEN=${OWNER_TOKEN}\n`));
    const issued = yield* inHub(
      scenario,
      issueAssetUrl({
        resource: {
          _tag: "media-file",
          threadId: scenario.threadId,
          path: file,
          disposition: "attachment",
        },
        viewer: scenario.owner,
      }).pipe(Effect.provide(assetLayers)),
    );
    const [token, name] = issued.relativeUrl.split("/").slice(-2);
    const asset = yield* inHub(
      scenario,
      resolveAsset(token!, decodeURIComponent(name!)).pipe(Effect.provide(assetLayers)),
    );
    assert.isNotNull(asset);
    assert.equal(asset!.kind, "file");
    const viewer = (asset as { readonly viewer?: string }).viewer;
    assert.equal(viewer, scenario.owner);
    const response = yield* inHub(
      scenario,
      maskedAssetText((asset as { readonly path: string }).path, Option.some(scenario.owner)),
    );
    const body = response?.body;
    shownMasked(
      body?._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "",
      "assets.createUrl",
    );
  });

/** Ticket 15: a Thread's file a URL serves from its machine, read through the Hub. */
const machineAssetUrl: Proof = (scenario) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(scenario.cwd, "proof-machine.txt"), `TOKEN=${OWNER_TOKEN}\n`),
    );
    const source = machineOver(scenario.cwd);
    const file = yield* source.inspect("proof-machine.txt");
    const response = yield* inHub(
      scenario,
      maskedMachineAsset(source, file, Option.some(scenario.owner)),
    );
    const body = response?.body;
    shownMasked(
      body?._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "",
      "files.streamAsset",
    );
  });

/** The Changes panel's service, as the server builds it, over the Hub's own services. */
const reviewLayer = ReviewService.layer.pipe(
  Layer.provideMerge(
    KnownWorkspaces.layer.pipe(
      Layer.provide(ProjectStore.layer),
      Layer.provide(GitVcsDriver.layer),
    ),
  ),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const review =
  (method: "getBranchCommits" | "getDiffPreview" | "getDiffFileContents"): Proof =>
  (scenario) =>
    Effect.gen(function* () {
      const cwd = scenario.cwd;
      const base = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
      const branch = `proof-${method}`;
      git(cwd, "checkout", "-q", "-b", branch);
      NodeFS.writeFileSync(NodePath.join(cwd, `${method}.env`), `TOKEN=${OWNER_TOKEN}\n`);
      git(cwd, "add", `${method}.env`);
      git(
        cwd,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "-m",
        `uses ${OWNER_TOKEN}`,
      );
      const service = yield* inHub(
        scenario,
        Effect.service(ReviewService.ReviewService).pipe(Effect.provide(reviewLayer)),
      );
      const answer = yield* inHub(
        scenario,
        (method === "getBranchCommits"
          ? service.getBranchCommits({ cwd, baseRef: base })
          : method === "getDiffPreview"
            ? service.getDiffPreview({ cwd, baseRef: base, sourceKind: "branch-range" })
            : service.getDiffFileContents({
                cwd,
                sourceKind: "branch-range",
                changeType: "new",
                baseRef: base,
                headRef: branch,
                oldPath: `${method}.env`,
                newPath: `${method}.env`,
              })) as Effect.Effect<unknown, unknown>,
      ).pipe(Effect.ensuring(Effect.sync(() => git(cwd, "checkout", "-q", base))));
      shownMasked(JSON.stringify(answer), `review.${method}`);
    });

/** The masking a Git action's progress and failure go through, with the Hub's own masker. */
const gitAction: Proof = (scenario) =>
  Effect.gen(function* () {
    const masker = Option.some(scenario.hub.service(SecretMasker.SecretMasker));
    const published: Array<unknown> = [];
    const options = yield* asOwner(
      scenario,
      maskGitProgress(masker, {
        progressReporter: {
          publish: (event: GitActionProgressEvent) => Effect.sync(() => published.push(event)),
        },
      }),
    );
    yield* options!.progressReporter!.publish({
      actionId: "action-proof",
      cwd: scenario.cwd,
      action: "commit",
      kind: "hook_output",
      hookName: "pre-commit",
      stream: "stdout",
      text: `checking ${OWNER_TOKEN}`,
    } as unknown as GitActionProgressEvent);
    shownMasked(JSON.stringify(published), "git hook output");
    const failed = yield* asOwner(
      scenario,
      Effect.flip(
        maskingGitErrors(masker, (_input: string, _options: undefined) =>
          Effect.fail(new GitFailed({ detail: `hook failed: ${OWNER_TOKEN}` })),
        )("commit", undefined),
      ),
    );
    shownMasked(failed.message, "git failure");
  });

/**
 * A Git workflow method that fails with git's stderr (the value in a nested cause and a defect),
 * through the masking the workflow service wraps every method in, with the Hub's own masker.
 */
const gitWorkflowFailure =
  (method: string): Proof =>
  (scenario) =>
    Effect.gen(function* () {
      const masker = Option.some(scenario.hub.service(SecretMasker.SecretMasker));
      const service = maskingServiceFailures(masker, {
        [method]: (_input: unknown) =>
          Effect.fail(
            new GitFailed({ detail: "git failed", cause: { stderr: `fatal: ${OWNER_TOKEN}` } }),
          ),
      }) as Record<string, (input: unknown) => Effect.Effect<unknown, GitFailed>>;
      const failed = yield* asOwner(scenario, Effect.flip(service[method]!({})));
      shownMasked(JSON.stringify(failed.cause), method);
      const died = maskingServiceFailures(masker, {
        [method]: (_input: unknown) => Effect.die(new Error(`hook: ${OWNER_TOKEN}`)),
      }) as Record<string, (input: unknown) => Effect.Effect<unknown>>;
      const exit = yield* asOwner(scenario, Effect.exit(died[method]!({})));
      shownMasked(String(exit._tag === "Failure" ? Cause.squash(exit.cause) : ""), method);
    });

class GitFailed extends Schema.TaggedError<GitFailed>()("GitFailed", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * A change request's method, through the masking the services wrap every method in, with the
 * Hub's own masker (no host answers in tests: the method's answer is a stand-in with the value).
 */
const pullRequest =
  (method: string): Proof =>
  (scenario) =>
    Effect.gen(function* () {
      const masker = Option.some(scenario.hub.service(SecretMasker.SecretMasker));
      const service = maskingPullRequestReads(masker, {
        [method]: (_input: unknown) => Effect.succeed({ body: `it uses ${OWNER_TOKEN}` }),
      }) as Record<string, (input: unknown) => Effect.Effect<unknown, unknown>>;
      const ref = { repository: "acme/web", number: 7 };
      const answer = yield* asOwner(scenario, service[method]!(ref));
      shownMasked(JSON.stringify(answer), method);
      if (method === "update" || method === "updateComment") {
        // An edit of what was shown masked: refused.
        const edit = yield* asOwner(
          scenario,
          Effect.exit(service[method]!({ ...ref, body: "it uses [OWNER_TOKEN]" })),
        );
        expect(edit._tag, method).toBe("Failure");
      }
    });

/** An MCP tool call: the agent's User comes from its invocation, with no session principal. */
const asMcpCaller = (scenario: Scenario) =>
  Effect.provideService(McpInvocationContext, { userId: scenario.owner } as never);

/** `write_pull_request_guides`: the guide is stored masked with the MCP caller's values. */
const mcpGuideStore: Proof = (scenario) =>
  Effect.gen(function* () {
    const generatedBy = yield* asMcpCaller(scenario)(SecretMasker.requester);
    expect(Option.getOrUndefined(generatedBy)).toBe(scenario.owner);
    const repository = yield* Effect.service(
      PullRequestReviewGuides.PullRequestReviewGuideRepository,
    ).pipe(
      Effect.provide(PullRequestReviewGuides.layer),
      Effect.provideContext(scenario.hub.server.services as never),
    ) as Effect.Effect<PullRequestReviewGuides.PullRequestReviewGuideRepository["Service"]>;
    yield* repository.put(
      { host: "github.com", repository: "acme/web", number: 7 } as never,
      {
        headSha: `sha-${OWNER_TOKEN}`,
        generatedAt: "2026-11-13T00:00:00.000Z",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        stops: [],
      } as never,
      generatedBy,
    );
    const rows = yield* scenario.hub.server.sql<{ readonly guide: string }>`
      SELECT guide_json AS guide FROM pull_request_review_guides
    `;
    shownMasked(JSON.stringify(rows), "write_pull_request_guides");
  });

/** `read_pull_request_guide`: what it answers, masked for the MCP caller (no session). */
const mcpGuideRead: Proof = (scenario) =>
  Effect.gen(function* () {
    const masker = Option.some(scenario.hub.service(SecretMasker.SecretMasker));
    const service = maskingPullRequestReads(masker, {
      get: (_input: unknown) => Effect.succeed({ guide: { headSha: `sha-${OWNER_TOKEN}` } }),
    });
    const answer = yield* asMcpCaller(scenario)(service.get({ repository: "acme/web", number: 7 }));
    shownMasked(JSON.stringify(answer), "read_pull_request_guide");
  });

const PULL_REQUEST_METHODS = [
  "list",
  "listStats",
  "filterOptions",
  "summary",
  "stack",
  "detail",
  "preview",
  "checks",
  "activity",
  "reviewGuide",
  "generateReviewGuide",
  "threadComments",
  "diffFileContents",
  "changeBreakdown",
  "filesViewed",
  "runAction",
  "update",
  "comment",
  "updateComment",
  "submitReview",
  "replyToThread",
];

const PROOFS: Record<string, Proof> = {
  "ws:projects.readFile": readFile,
  "ws:projects.searchContents": searchContents,
  "ws:projects.writeFile": writeFile,
  "ws:terminal.open": terminal("attach"),
  "ws:terminal.attach": terminal("attach"),
  "ws:terminal.observe": terminal("observe"),
  "ws:review.getBranchCommits": review("getBranchCommits"),
  "ws:review.getDiffPreview": review("getDiffPreview"),
  "ws:review.getDiffFileContents": review("getDiffFileContents"),
  "ws:git.runStackedAction": gitAction,
  "ws:vcs.pull": gitWorkflowFailure("pullCurrentBranch"),
  "ws:git.resolvePullRequest": gitWorkflowFailure("resolvePullRequest"),
  "ws:git.preparePullRequestThread": gitWorkflowFailure("preparePullRequestThread"),
  "ws:vcs.listRefs": gitWorkflowFailure("listRefs"),
  "ws:vcs.createWorktree": gitWorkflowFailure("createWorktree"),
  "ws:vcs.removeWorktree": gitWorkflowFailure("removeWorktree"),
  "ws:vcs.createRef": gitWorkflowFailure("createRef"),
  "ws:vcs.switchRef": gitWorkflowFailure("switchRef"),
  "ws:orchestration.dispatchCommand": rejectedCommand,
  "ws:orchestration.getTurnDiff": turnDiff,
  "ws:orchestration.getFullThreadDiff": fullThreadDiff,
  "ws:orchestration.subscribeCommandOutput": commandOutput,
  "ws:subscribeWorktreeSetup": worktreeSetup,
  "ws:assets.createUrl": assetUrl,
  ...Object.fromEntries(
    PULL_REQUEST_METHODS.map((method) => [`ws:pullRequests.${method}`, pullRequest(method)]),
  ),
  "http:pullRequests.diff": pullRequest("diff"),
  "raw:guest/http.ts: GET GUEST_COMMAND_OUTPUT_ROUTE": commandOutput,
  "raw:http.ts: GET `${ASSET_ROUTE_PREFIX}/*`": assetUrl,
  "mcp:read_pull_request_guide": mcpGuideRead,
  "mcp:write_pull_request_guides": mcpGuideStore,
  "executor:files.read": readFile,
  "executor:files.write": writeFile,
  "executor:files.streamAsset": machineAssetUrl,
  "executor:search.contents": searchContents,
  "executor:terminal.open": terminal("attach"),
  "executor:terminal.stream": terminal("observe"),
  "executor:checkpoint.diff": turnDiff,
};

const maskedDoors = () =>
  Object.entries(DOORS).flatMap(([kind, { rules }]) =>
    Object.entries(rules).flatMap(([door, rule]) => ("masked" in rule ? [`${kind}:${door}`] : [])),
  );

describe("MaskedPaths: every door says how a Thread's process output reaches it masked", () => {
  it("has a rule for every door, by name, and no rule no door uses", () => {
    for (const [kind, { doors, rules }] of Object.entries(DOORS)) {
      expect(doors.length, kind).toBeGreaterThan(0);
      const names = new Set(doors);
      expect({ kind, without: doors.filter((door) => !Object.hasOwn(rules, door)) }).toEqual({
        kind,
        without: [],
      });
      expect({ kind, unused: Object.keys(rules).filter((rule) => !names.has(rule)) }).toEqual({
        kind,
        unused: [],
      });
      // No wildcard can let a new door through.
      expect(Object.keys(rules).filter((rule) => rule.endsWith("*") && !names.has(rule))).toEqual(
        [],
      );
    }
  });

  it("has a call with a secret for every masked door, and for nothing else", () => {
    expect(Object.keys(PROOFS).sort()).toEqual(maskedDoors().sort());
  });

  it.live("calls every masked door with a secret: each answers [NAME]", () =>
    Effect.gen(function* () {
      const { hub, owner, threadId } = yield* turnThatPrintsTheSecret();
      const scenario: Scenario = {
        hub,
        owner,
        threadId,
        workspace: yield* threadWorkspaceOf(hub),
        cwd: yield* hubCheckoutOf(hub, threadId),
      };
      for (const door of maskedDoors()) {
        yield* PROOFS[door]!(scenario).pipe(
          Effect.mapError((cause) => new Error(`${door}: ${String(cause)}`)),
        );
      }
    }).pipe(Effect.scoped),
  );

  it("knows every writer of the Thread tables", () => {
    const writers = [...files]
      .filter(
        ([file, text]) =>
          !file.startsWith("persistence/Migrations") &&
          /(INSERT INTO|UPDATE)\s+orchestration_v2_/.test(text),
      )
      .map(([file]) => file)
      .sort();
    expect(writers).toEqual(Object.keys(ORCHESTRATION_TABLE_WRITERS).sort());
  });

  it("serves history only from the masked store: live provider events are read in one place", () => {
    // On the Hub they go to the masked sinks; a joined machine's agent reads its own to send them.
    const readers = [...files]
      .filter(([, text]) => /\bruntime\.events\b/.test(text))
      .map(([file]) => file)
      .filter((file) => !file.startsWith("orchestration-v2/Adapters/"))
      .sort();
    expect(readers).toEqual([
      "environments/EnvironmentAgent.ts",
      "orchestration-v2/ProviderSessionManager.ts",
    ]);
  });

  it("wires the masking the proofs above call into the services the doors use", () => {
    expect(files.get("server.ts")).toMatch(/SecretMasker\.layer/);
    expect(files.get("vaults/SecretDelivery.ts")).toMatch(/\.remember\(/);
    expect(files.get("orchestration-v2/EventSink.ts")).toMatch(/maskingEventWrites\(/);
    expect(files.get("git/GitManager.ts")).toMatch(/maskGitProgress\(/);
    expect(files.get("git/GitManager.ts")).toMatch(
      /maskingGitErrors\(secretMasker, runStackedAction\)/,
    );
    expect(files.get("pullRequest/PullRequestService.ts")).toMatch(/maskingPullRequestReads\(/);
    expect(files.get("pullRequest/PullRequestReviewGuideService.ts")).toMatch(
      /maskingPullRequestReads\(/,
    );
    expect(files.get("http.ts")).toMatch(/maskedAssetText\(/);
  });
});
