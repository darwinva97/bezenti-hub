import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  NodeId,
  SpaceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as HubRepositoryUploadIssues from "../checkpointing/HubRepositoryUploadIssues.ts";
import { addMember } from "../auth/UserAuth.testkit.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as CheckpointUploadService from "../orchestration-v2/CheckpointUploadService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import {
  connectProtocolEnvironment,
  makeHub,
  seedProject,
  type Hub,
  type TestEnvironment,
} from "./HubWithEnvironments.testkit.ts";
import {
  CLAUDE,
  idleAdapters,
  loadFixture,
  replayOn,
  ownerIdOf,
  openProtocolSession,
  git,
  awaitUploaded,
  withEditingTurns,
} from "./HubWithEnvironments.scenarios.testkit.ts";

/**
 * Ready checkpoints of a Thread (turns 1..count) that the Hub repository does not have yet, in a
 * scope named `name` whose workspace is `cwd`.
 */
const seedCheckpoints = Effect.fn(function* (
  hub: Hub,
  threadId: ThreadId,
  count: number,
  options: {
    readonly name?: string;
    readonly cwd?: string;
    readonly refs?: ReadonlyArray<CheckpointRef>;
  } = {},
) {
  const name = options.name ?? "protocol";
  const projection = yield* hub
    .service(Orchestrator.OrchestratorV2)
    .getThreadProjection(threadId)
    .pipe(Effect.orDie);
  const now = projection.thread.createdAt;
  const scopeId = CheckpointScopeId.make(`scope:${name}`);
  const nodeId = NodeId.make(`node:${name}`);
  const seeded = Array.from({ length: count }, (_, index) => ({
    ordinal: index + 1,
    ref:
      options.refs?.[index] ??
      CheckpointRef.make(`refs/t3/orchestration-v2/checkpoints/${name}/ordinal/${index + 1}`),
    checkpointId: CheckpointId.make(`checkpoint:${name}:${index + 1}`),
  }));
  yield* hub.server.eventSink
    .write({
      events: [
        {
          id: EventId.make(`event:${name}-scope`),
          type: "checkpoint-scope.created",
          threadId,
          occurredAt: now,
          payload: {
            id: scopeId,
            threadId,
            runId: null,
            nodeId,
            parentScopeId: null,
            providerThreadId: null,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: options.cwd ?? "/remote/projects/protocol",
            createdAt: now,
          },
        },
        ...seeded.map((checkpoint) => ({
          id: EventId.make(`event:${name}-checkpoint:${checkpoint.ordinal}`),
          type: "checkpoint.captured" as const,
          threadId,
          occurredAt: now,
          payload: {
            id: checkpoint.checkpointId,
            threadId,
            scopeId,
            runId: null,
            nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: checkpoint.ordinal,
            appRunOrdinal: checkpoint.ordinal,
            ref: checkpoint.ref,
            status: "ready" as const,
            files: [],
            capturedAt: now,
            uploadedToHub: false,
          },
        })),
      ],
    })
    .pipe(Effect.orDie);
  return seeded as [(typeof seeded)[number], ...typeof seeded];
});

/** The machine answers the Hub's next request, which must be `method` with `payload`. */
const answerNext = Effect.fn(function* (
  machine: {
    readonly nextFrame: Effect.Effect<Record<string, unknown>>;
    readonly connection: RemoteEnvironments.RemoteConnection;
  },
  method: string,
  payload: unknown,
  result:
    | { readonly _tag: "success"; readonly value: unknown }
    | { readonly _tag: "failure"; readonly error: unknown },
) {
  const frame = yield* machine.nextFrame;
  assert.deepEqual({ method: frame.method, payload: frame.payload }, { method, payload });
  yield* machine.connection.receive({ type: "response", requestId: frame.requestId, result });
});

/** No request with `method` reaches the machine for a while. */
const assertNoRequest = Effect.fn(function* (
  machine: { readonly nextFrame: Effect.Effect<Record<string, unknown>> },
  method: string,
  wait: Duration.Input = "600 millis",
) {
  const frame = yield* machine.nextFrame.pipe(
    Effect.repeat({ until: (next) => next.method === method }),
    Effect.timeoutOption(wait),
  );
  assert.isTrue(Option.isNone(frame), `unexpected ${method}`);
});

/** What git says when a proxy in front of the Hub refuses a push's size. */
const PUSH_TOO_LARGE = {
  _tag: "failure",
  error: {
    _tag: "VcsProcessExitError",
    operation: "HubRepository.push",
    command: "git push",
    cwd: "/remote/projects/protocol",
    exitCode: 1,
    detail:
      "error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413\nsend-pack: unexpected disconnect while reading sideband packet",
  },
} as const;

const PUSH_FAILED = {
  _tag: "failure",
  error: {
    _tag: "VcsProcessExitError",
    operation: "HubRepository.push",
    command: "git push",
    cwd: "/remote/projects/protocol",
    exitCode: 1,
    detail: "src refspec does not match any",
  },
} as const;

describe("Hub repository", () => {
  it.live(
    "an Environment reaches the repositories of Projects its owner works in, until removed",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: idleAdapters(ProviderInstanceId.make("claudeAgent")),
        });
        const own = ProjectId.make("project:own");
        const { workspaceRoot } = yield* seedProject(hub.server, {
          projectId: own,
          title: "Own",
          defaultModelSelection: null,
        });
        yield* addMember(hub.server, { id: "member-1", displayName: "Grace Hopper" });
        const others = ProjectId.make("project:graces");
        yield* seedProject(hub.server, {
          projectId: others,
          title: "Grace's",
          defaultModelSelection: null,
          spaceId: SpaceId.make("personal:member-1"),
        });
        const ref = CheckpointRef.make("refs/t3/orchestration-v2/checkpoints/test/ordinal/1");
        yield* git(workspaceRoot, ["update-ref", ref, "HEAD"]);
        const remote = (projectId: ProjectId) =>
          HubRepository.withEnvironmentCredential(
            HubRepository.hubRepositoryUrl(hub.server.url, { projectId }),
            laptop.credential,
          );
        const push = (projectId: ProjectId) =>
          git(workspaceRoot, ["push", remote(projectId).url, `${ref}:${ref}`], {
            env: remote(projectId).env ?? {},
          });
        const advertised = (projectId: ProjectId, credential = laptop.credential) =>
          HttpClient.HttpClient.pipe(
            Effect.flatMap((client) =>
              client.execute(
                HttpClientRequest.get(
                  `${remote(projectId).url}/info/refs?service=git-upload-pack`,
                ).pipe(HttpClientRequest.bearerToken(credential)),
              ),
            ),
            Effect.map((response) => response.status),
            Effect.provide(FetchHttpClient.layer),
            Effect.orDie,
          );

        // Its own Project: it may fetch (which refs it may see is the next test's).
        const listed = yield* git(workspaceRoot, ["ls-remote", remote(own).url], {
          env: remote(own).env ?? {},
        });
        assert.equal(listed.exitCode, 0);
        assert.equal(yield* advertised(own), 200);

        // Another User's Space: the Owner's machine neither reads nor writes its Project.
        assert.equal(yield* advertised(others), 403);
        assert.notEqual((yield* push(others)).exitCode, 0);
        assert.equal(yield* advertised(own, "not-a-credential"), 401);

        // Removed: push and fetch stop at once.
        const owner = yield* ownerIdOf(hub);
        yield* hub
          .service(EnvironmentRegistry.EnvironmentRegistry)
          .remove({ actorUserId: owner, environmentId: laptop.environmentId });
        assert.equal(yield* advertised(own), 401);
        assert.notEqual(
          (yield* git(workspaceRoot, ["ls-remote", remote(own).url], {
            env: remote(own).env ?? {},
          })).exitCode,
          0,
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "a turn's checkpoint uploads, and its diffs open on the Hub with the machine offline",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hub = yield* makeHub();
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: withEditingTurns(loaded.adapters, {
            file: "notes.md",
            content: "Written on the Laptop",
          }),
        });
        yield* replayOn(hub, laptop, loaded);
        const [threadId] = loaded.materialized.projectionThreadIds;
        assert.isDefined(threadId);
        yield* awaitUploaded(hub, threadId, 1);
        yield* laptop.disconnect;

        const diffs = hub.service(CheckpointDiffQuery.CheckpointDiffQuery);
        const turn = yield* diffs.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
        assert.include(turn.diff, "+Written on the Laptop (turn 1)");
        const whole = yield* diffs.getFullThreadDiff({ threadId, toTurnCount: 1 });
        assert.include(whole.diff, "notes.md");

        // Uploaded to the Hub, not to the Project's own remote the Laptop cloned from.
        const projection = yield* hub
          .service(Orchestrator.OrchestratorV2)
          .getThreadProjection(threadId);
        const project = yield* hub
          .service(ProjectStore.ProjectStoreV2)
          .get(projection.thread.projectId);
        assert.isTrue(Option.isSome(project));
        const origin = Option.getOrThrow(project).workspaceRoot;
        assert.equal((yield* git(origin, ["for-each-ref", "refs/t3/"])).stdout, "");
        for (const checkpoint of projection.checkpoints) {
          if (checkpoint.status === "ready") assert.isTrue(checkpoint.uploadedToHub, checkpoint.id);
        }
      }).pipe(Effect.scoped),
  );

  it.live("a machine reads and writes only the refs of Threads it runs, and deletes none", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const desktop = yield* hub.join({ name: "Desktop", adapters: idleAdapters(instanceId) });
      const projectId = ProjectId.make("project:shared");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Shared",
        defaultModelSelection: null,
      });
      const threadId = ThreadId.make("thread:on-laptop");
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:thread-on-laptop"),
        threadId,
        projectId,
        title: "On the Laptop",
        modelSelection: { instanceId, model: "claude-sonnet-4-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeEnvironmentId: laptop.environmentId,
      });
      const scopeId = CheckpointScopeId.make("scope:on-laptop");
      const projection = yield* hub
        .service(Orchestrator.OrchestratorV2)
        .getThreadProjection(threadId);
      yield* hub.server.eventSink.write({
        events: [
          {
            id: EventId.make("event:on-laptop-scope"),
            type: "checkpoint-scope.created",
            threadId,
            occurredAt: projection.thread.createdAt,
            payload: {
              id: scopeId,
              threadId,
              runId: null,
              nodeId: NodeId.make("node:on-laptop"),
              parentScopeId: null,
              providerThreadId: null,
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: workspaceRoot,
              createdAt: projection.thread.createdAt,
            },
          },
        ],
      });
      const checkpointRef = yield* checkpointRefForScopeOrdinal({
        scopeId,
        ordinalWithinScope: 1,
      }).pipe(Effect.provide(NodeCrypto.layer));
      const headRef = `${HubRepository.threadRefPrefixes(threadId)[0]}head`;
      // A checkpoint is a commit of its own, never a tip of the Project's branches (which every
      // machine working in the Project reads).
      const checkpointCommit = (yield* git(workspaceRoot, [
        "-c",
        "user.email=hub@example.com",
        "-c",
        "user.name=Hub",
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "HEAD",
        "-m",
        "Checkpoint",
      ])).stdout.trim();
      yield* git(workspaceRoot, ["update-ref", checkpointRef, checkpointCommit]);
      yield* git(workspaceRoot, ["update-ref", headRef, checkpointCommit]);
      const on = (machine: TestEnvironment, ...args: ReadonlyArray<string>) => {
        const remote = HubRepository.withEnvironmentCredential(
          HubRepository.hubRepositoryUrl(hub.server.url, { projectId }),
          machine.credential,
        );
        return git(workspaceRoot, [args[0]!, remote.url, ...args.slice(1)], {
          env: remote.env ?? {},
        });
      };

      // The Laptop runs the Thread: it uploads the Thread's refs.
      const succeeded = (output: { readonly exitCode: number; readonly stderr: string }) =>
        assert.equal(output.exitCode, 0, output.stderr);
      succeeded(yield* on(laptop, "push", `+${checkpointRef}:${checkpointRef}`));
      succeeded(yield* on(laptop, "push", `+${headRef}:${headRef}`));
      assert.include((yield* on(laptop, "ls-remote")).stdout, checkpointRef);
      // Another machine sees none of them and changes none, nor writes outside a Thread's refs.
      const seen = (yield* on(desktop, "ls-remote")).stdout;
      assert.notInclude(seen, checkpointRef);
      assert.notInclude(seen, headRef);
      // Nor fetches a hidden object by its id, in any protocol version.
      const sha = (yield* git(workspaceRoot, ["rev-parse", checkpointRef])).stdout.trim();
      const fresh = `${workspaceRoot}-fresh`;
      yield* git(workspaceRoot, ["init", "-q", fresh]);
      for (const version of ["2", "0"]) {
        const remote = HubRepository.withEnvironmentCredential(
          HubRepository.hubRepositoryUrl(hub.server.url, { projectId }),
          desktop.credential,
        );
        const stolen = yield* git(
          fresh,
          ["-c", `protocol.version=${version}`, "fetch", "-q", remote.url, sha],
          { env: remote.env ?? {} },
        );
        assert.notEqual(stolen.exitCode, 0, `protocol ${version}`);
      }
      assert.notEqual((yield* on(desktop, "push", `+HEAD:${checkpointRef}`)).exitCode, 0);
      assert.notEqual((yield* on(desktop, "push", `+HEAD:${headRef}`)).exitCode, 0);
      assert.notEqual((yield* on(laptop, "push", "+HEAD:refs/heads/main")).exitCode, 0);
      // Nobody deletes on the Hub, the machine that runs the Thread included.
      assert.notEqual((yield* on(laptop, "push", `:${checkpointRef}`)).exitCode, 0);
      assert.include((yield* on(laptop, "ls-remote")).stdout, checkpointRef);
    }).pipe(Effect.scoped),
  );

  it.live("a failed upload shows as not uploaded and retries when the machine comes back", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      const { threadId } = opened;
      const [{ ref, checkpointId }] = yield* seedCheckpoints(hub, threadId, 1);
      yield* hub.service(CheckpointUploadService.CheckpointUploads).request(threadId);

      const pushed = yield* opened.machine.nextFrame;
      assert.equal(pushed.method, "checkpoint.push");
      assert.deepEqual(pushed.payload, {
        cwd: "/remote/projects/protocol",
        projectId: "project:protocol",
        checkpointRefs: [ref],
      });
      yield* opened.machine.connection.receive({
        type: "response",
        requestId: pushed.requestId,
        result: {
          _tag: "failure",
          error: {
            _tag: "VcsProcessExitError",
            operation: "HubRepository.push",
            command: "git push",
            cwd: "/remote/projects/protocol",
            exitCode: 128,
            detail: "Could not reach the Hub.",
          },
        },
      });
      const stored = yield* hub.server.sql<{ readonly uploaded: number | null }>`
        SELECT uploaded_to_hub AS uploaded FROM orchestration_v2_projection_checkpoints
        WHERE checkpoint_id = ${checkpointId}
      `;
      assert.deepEqual(stored, [{ uploaded: 0 }]);

      // The machine reconnects: the upload runs again at once, and the turn is marked uploaded.
      yield* opened.machine.disconnect;
      const back = yield* connectProtocolEnvironment(hub, {
        environmentId: opened.environmentId,
        instanceId: opened.instanceId,
        driver: CLAUDE,
        capabilities: ClaudeProviderCapabilitiesV2,
      });
      const retried = yield* back.nextFrame;
      assert.equal(retried.method, "checkpoint.push");
      yield* back.connection.receive({
        type: "response",
        requestId: retried.requestId,
        result: { _tag: "success", value: null },
      });
      yield* awaitUploaded(hub, threadId, 1);
    }).pipe(Effect.scoped),
  );

  it.live("a ref its machine lacks is left for its source machine and holds back no other", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      const [first, second] = yield* seedCheckpoints(hub, opened.threadId, 2);
      assert.isDefined(second);
      const transfer = (refs: ReadonlyArray<CheckpointRef>) => ({
        cwd: "/remote/projects/protocol",
        projectId: "project:protocol",
        checkpointRefs: refs,
      });
      yield* hub.service(CheckpointUploadService.CheckpointUploads).request(opened.threadId);

      // The batch fails on a ref the checkout lacks: the machine is asked which it has (no push
      // per ref), the missing one is set aside and the rest go in one push.
      yield* answerNext(
        opened.machine,
        "checkpoint.push",
        transfer([first.ref, second.ref]),
        PUSH_FAILED,
      );
      yield* answerNext(
        opened.machine,
        "checkpoint.hasRef",
        { cwd: "/remote/projects/protocol", checkpointRef: first.ref },
        { _tag: "success", value: true },
      );
      yield* answerNext(
        opened.machine,
        "checkpoint.hasRef",
        { cwd: "/remote/projects/protocol", checkpointRef: second.ref },
        { _tag: "success", value: false },
      );
      yield* answerNext(opened.machine, "checkpoint.push", transfer([first.ref]), {
        _tag: "success",
        value: null,
      });
      yield* awaitUploaded(hub, opened.threadId, 1);
      const stored = yield* hub.server.sql<{ readonly id: string; readonly uploaded: number }>`
        SELECT checkpoint_id AS id, uploaded_to_hub AS uploaded
        FROM orchestration_v2_projection_checkpoints ORDER BY ordinal_within_scope
      `;
      assert.deepEqual(stored, [
        { id: first.checkpointId, uploaded: 1 },
        { id: second.checkpointId, uploaded: 0 },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("a repository refused as too large backs off as a whole, and the machine says why", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      const [first, second] = yield* seedCheckpoints(hub, opened.threadId, 2);
      assert.isDefined(second);
      const uploads = hub.service(CheckpointUploadService.CheckpointUploads);
      yield* uploads.request(opened.threadId);

      // The batch is too large; the newest alone is tried once, then nothing per ref.
      const batch = yield* opened.machine.nextFrame;
      assert.deepEqual((batch.payload as { checkpointRefs: unknown }).checkpointRefs, [
        first.ref,
        second.ref,
      ]);
      yield* opened.machine.connection.receive({
        type: "response",
        requestId: batch.requestId,
        result: PUSH_TOO_LARGE,
      });
      const alone = yield* opened.machine.nextFrame;
      assert.equal(alone.method, "checkpoint.push");
      assert.lengthOf(
        (alone.payload as { checkpointRefs: ReadonlyArray<unknown> }).checkpointRefs,
        1,
      );
      yield* opened.machine.connection.receive({
        type: "response",
        requestId: alone.requestId,
        result: PUSH_TOO_LARGE,
      });

      // The machine's list says why, for whoever manages it.
      const issues = hub.service(HubRepositoryUploadIssues.HubRepositoryUploadIssues);
      const recorded = yield* issues
        .of(opened.environmentId)
        .pipe(Effect.repeat({ until: (found) => found.length > 0 }), Effect.timeout("5 seconds"));
      assert.lengthOf(recorded, 1);
      assert.equal(recorded[0]!.projectId, ProjectId.make("project:protocol"));
      assert.equal(recorded[0]!.kind, "too-large");
      assert.equal(recorded[0]!.pendingCheckpoints, 2);
      assert.include(recorded[0]!.detail, "413");
      assert.isNotNull(recorded[0]!.nextAttemptAt);

      // A new checkpoint's request and a reconnect push nothing before the repository's retry.
      yield* uploads.request(opened.threadId);
      yield* assertNoRequest(opened.machine, "checkpoint.push");
      yield* opened.machine.disconnect;
      const back = yield* connectProtocolEnvironment(hub, {
        environmentId: opened.environmentId,
        instanceId: opened.instanceId,
        driver: CLAUDE,
        capabilities: ClaudeProviderCapabilitiesV2,
      });
      yield* assertNoRequest(back, "checkpoint.push");
    }).pipe(Effect.scoped),
  );

  it.live("one machine uploads to one repository at a time, whichever Threads ask", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      const other = ThreadId.make("thread:protocol-other");
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:protocol-other"),
        threadId: other,
        projectId: ProjectId.make("project:protocol"),
        title: "Protocol, again",
        modelSelection: { instanceId: opened.instanceId, model: "claude-sonnet-4-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeEnvironmentId: opened.environmentId,
      });
      yield* seedCheckpoints(hub, opened.threadId, 1);
      yield* seedCheckpoints(hub, other, 1, { name: "other" });
      const uploads = hub.service(CheckpointUploadService.CheckpointUploads);
      yield* uploads.request(opened.threadId);
      yield* uploads.request(other);

      const firstPush = yield* opened.machine.nextFrame;
      assert.equal(firstPush.method, "checkpoint.push");
      // The other Thread's upload waits for this one to end.
      yield* assertNoRequest(opened.machine, "checkpoint.push");
      yield* opened.machine.connection.receive({
        type: "response",
        requestId: firstPush.requestId,
        result: { _tag: "success", value: null },
      });
      const secondPush = yield* opened.machine.nextFrame;
      assert.equal(secondPush.method, "checkpoint.push");
      assert.notDeepEqual(secondPush.payload, firstPush.payload);
      yield* opened.machine.connection.receive({
        type: "response",
        requestId: secondPush.requestId,
        result: { _tag: "success", value: null },
      });
      yield* awaitUploaded(hub, opened.threadId, 1);
      yield* awaitUploaded(hub, other, 1);
    }).pipe(Effect.scoped),
  );

  it.live("an upload too large for one request goes in parts and arrives whole", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      // Every upload goes in parts, of 64 KiB.
      const laptop = yield* hub.join({
        name: "Laptop",
        adapters: idleAdapters(instanceId),
        packUploads: { partBytes: 64 * 1024, smartPushMaxBytes: 0 },
      });
      const projectId = ProjectId.make("project:large");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Large",
        defaultModelSelection: null,
      });
      const threadId = ThreadId.make("thread:large");
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:thread-large"),
        threadId,
        projectId,
        title: "Large",
        modelSelection: { instanceId, model: "claude-sonnet-4-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeEnvironmentId: laptop.environmentId,
      });
      const checkpointRef = yield* checkpointRefForScopeOrdinal({
        scopeId: CheckpointScopeId.make("scope:large"),
        ordinalWithinScope: 1,
      }).pipe(Effect.provide(NodeCrypto.layer));
      // A checkpoint whose one file is larger than a part, and does not compress.
      const large = `${workspaceRoot}/large.bin`;
      yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFile(large, noise(300 * 1024)),
      ).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
      const blob = (yield* git(workspaceRoot, ["hash-object", "-w", large])).stdout.trim();
      const treeId = (yield* gitWithInput(
        workspaceRoot,
        ["mktree"],
        `100644 blob ${blob}\tlarge.bin\n`,
      )).stdout.trim();
      const commit = (yield* git(workspaceRoot, [
        "-c",
        "user.email=hub@example.com",
        "-c",
        "user.name=Hub",
        "commit-tree",
        treeId,
        "-p",
        "HEAD",
        "-m",
        "Checkpoint",
      ])).stdout.trim();
      yield* git(workspaceRoot, ["update-ref", checkpointRef, commit]);
      yield* seedCheckpoints(hub, threadId, 1, {
        name: "large",
        cwd: workspaceRoot,
        refs: [checkpointRef],
      });

      yield* hub.service(CheckpointUploadService.CheckpointUploads).request(threadId);
      yield* awaitUploaded(hub, threadId, 1);

      // The Hub has it whole: a fresh repository fetches the commit and the file is the same.
      const remote = HubRepository.withEnvironmentCredential(
        HubRepository.hubRepositoryUrl(hub.server.url, { projectId }),
        laptop.credential,
      );
      const fresh = `${workspaceRoot}-fresh`;
      yield* git(workspaceRoot, ["init", "-q", fresh]);
      const fetched = yield* git(fresh, ["fetch", "-q", remote.url, checkpointRef], {
        env: remote.env ?? {},
      });
      assert.equal(fetched.exitCode, 0, fetched.stderr);
      assert.equal((yield* git(fresh, ["rev-parse", "FETCH_HEAD"])).stdout.trim(), commit);
      assert.equal((yield* git(fresh, ["rev-parse", "FETCH_HEAD:large.bin"])).stdout.trim(), blob);
      // It went in parts, and the machine kept no pack of it.
      const uploadsFolder = `${workspaceRoot}/.git/t3-hub-uploads`;
      const left = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.readDirectory(uploadsFolder),
      ).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
      assert.deepEqual(left, []);
    }).pipe(Effect.scoped),
  );

  it.live("parts resume where the Hub is, and an apply is checked like a push", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const { projectId, headRef, commit } = yield* threadOnMachine(hub, laptop);
      const base = `${HubRepository.hubRepositoryUrl(hub.server.url, { projectId })}/packs/${"a".repeat(40)}`;
      const send = (request: HttpClientRequest.HttpClientRequest) =>
        HttpClient.HttpClient.pipe(
          Effect.flatMap((client) =>
            client.execute(HttpClientRequest.bearerToken(request, laptop.credential)),
          ),
          Effect.flatMap((response) =>
            response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
          ),
          Effect.provide(FetchHttpClient.layer),
          Effect.orDie,
        );
      const part = (offset: number, text: string) =>
        send(
          HttpClientRequest.post(`${base}?offset=${offset}`).pipe(
            HttpClientRequest.bodyText(text, "application/octet-stream"),
          ),
        );
      assert.deepEqual(yield* part(0, "abc"), {
        status: 200,
        text: '{"state":"receiving","size":3}',
      });
      // The same part again, or one that does not start where the Hub is: the Hub says where.
      assert.deepEqual(yield* part(0, "abc"), {
        status: 409,
        text: '{"state":"receiving","size":3}',
      });
      assert.deepEqual(yield* part(7, "xyz"), {
        status: 409,
        text: '{"state":"receiving","size":3}',
      });
      assert.deepEqual(yield* part(3, "de"), {
        status: 200,
        text: '{"state":"receiving","size":5}',
      });
      assert.deepEqual(yield* send(HttpClientRequest.get(base)), {
        status: 200,
        text: '{"state":"receiving","size":5}',
      });
      const apply = (ref: string) =>
        send(
          HttpClientRequest.post(`${base}/apply`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ size: 5, updates: [{ ref, newOid: commit }] }),
          ),
        );
      // Outside the Threads it runs, nothing is applied.
      assert.equal((yield* apply("refs/heads/main")).status, 403);
      // Its own Thread's ref: applied, and refused by git as no pack.
      const started = yield* apply(headRef);
      assert.equal(started.status, 202);
      const ended = yield* send(HttpClientRequest.get(base)).pipe(
        Effect.repeat({ until: (status) => !status.text.includes('"applying"') }),
        Effect.timeout("10 seconds"),
      );
      assert.include(ended.text, '"state":"failed"');
    }).pipe(Effect.scoped),
  );
});

/** A Thread of a new Project on `machine`, with a commit of its own as its head ref. */
const threadOnMachine = Effect.fn(function* (hub: Hub, machine: TestEnvironment) {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const projectId = ProjectId.make("project:packs");
  const { workspaceRoot } = yield* seedProject(hub.server, {
    projectId,
    title: "Packs",
    defaultModelSelection: null,
  });
  const threadId = ThreadId.make("thread:packs");
  yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:thread-packs"),
    threadId,
    projectId,
    title: "Packs",
    modelSelection: { instanceId, model: "claude-sonnet-4-6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeEnvironmentId: machine.environmentId,
  });
  const commit = (yield* git(workspaceRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return {
    threadId,
    projectId,
    headRef: `${HubRepository.threadRefPrefixes(threadId)[0]}head`,
    commit,
  };
});

/** Bytes that do not compress (xorshift), so the pack is as large as the file. */
const noise = (length: number) => {
  const bytes = new Uint8Array(length);
  let state = 0x9e3779b9;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
};

/** Git with `stdin`. */
const gitWithInput = (cwd: string, args: ReadonlyArray<string>, stdin: string) =>
  Effect.flatMap(VcsProcess.VcsProcess, (vcs) =>
    vcs.run({ operation: "HubRepository.test.git", command: "git", cwd, args, stdin }),
  ).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))), Effect.orDie);
