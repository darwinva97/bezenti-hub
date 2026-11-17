import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2Command,
  ProjectId,
  ProviderInstanceId,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpaceDirectory from "./SpaceDirectory.ts";

// Every Thread reaches the orchestrator through ThreadManagementService.dispatch: the web
// client, launches, the MCP server's tools, scheduled tasks and the CLI.
const makeLayer = (dispatched: Array<OrchestrationV2Command>) =>
  ThreadManagementService.layerWithLegacyImporter.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command as OrchestrationV2Command);
            return { sequence: dispatched.length, storedEvents: [] } as never;
          }),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(SpaceDirectory.layer),
    Layer.provideMerge(CommandReceiptStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(NodeCrypto.layer),
  );

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO users (user_id, display_name, is_owner, created_at) VALUES
      ('owner', 'Ada', 1, '2026-01-01T00:00:00.000Z'),
      ('member-1', 'Grace', 0, '2026-01-01T00:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO spaces (space_id, kind, name, created_at, archived_at) VALUES
      ('org-acme', 'organization', 'Acme', '2026-01-01T00:00:00.000Z', NULL),
      ('org-old', 'organization', 'Old', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO space_memberships (space_id, user_id, role, created_at) VALUES
      ('org-acme', 'member-1', 'member', '2026-01-01T00:00:00.000Z'),
      ('org-old', 'member-1', 'member', '2026-01-01T00:00:00.000Z')
  `;
  // A Project from before Spaces: no space_id.
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project:legacy', 'Legacy', '/work/legacy', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `;
});

const threadCreate = (
  id: string,
  extra: Partial<Extract<OrchestrationV2Command, { type: "thread.create" }>> = {},
): Extract<OrchestrationV2Command, { type: "thread.create" }> => ({
  type: "thread.create",
  createdBy: "agent",
  creationSource: "mcp",
  commandId: CommandId.make(`command:${id}`),
  threadId: ThreadId.make(`thread:${id}`),
  projectId: ProjectId.make("project:scratch"),
  title: "Hello",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  ...extra,
});

const stampOf = (command: OrchestrationV2Command | undefined) =>
  command?.type === "thread.create" ? [command.spaceId, command.ownerUserId] : null;

it.effect("stamps a Thread from a caller with no User of its own as the Owner's", () => {
  const dispatched: Array<OrchestrationV2Command> = [];
  return Effect.gen(function* () {
    yield* seed;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.dispatch(threadCreate("agent"));
    expect(stampOf(dispatched[0])).toEqual(["personal:owner", "owner"]);
  }).pipe(Effect.provide(makeLayer(dispatched)));
});

it.effect("puts a Thread in a Project from before Spaces into the Owner's Personal space", () => {
  const dispatched: Array<OrchestrationV2Command> = [];
  return Effect.gen(function* () {
    yield* seed;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projectId = ProjectId.make("project:legacy");
    const acme = SpaceId.make("org-acme");

    // Ticket 19: a client that names its current Space starts Threads only in that Space's
    // Projects; one that names none (an agent, a fork) gets the Project's Space.
    const mismatched = yield* threads
      .dispatch(threadCreate("owner-elsewhere", { projectId, spaceId: acme }))
      .pipe(Effect.flip);
    expect(SpaceDirectory.spaceRefusalMessage(mismatched)).toBe(
      "This Project is in another Space. Switch to its Space to start a Thread in it.",
    );
    yield* threads.dispatch(
      threadCreate("owner", { projectId, spaceId: SpaceId.make("personal:owner") }),
    );
    expect(stampOf(dispatched[0])).toEqual(["personal:owner", "owner"]);
    yield* threads.dispatch(threadCreate("owner-agent", { projectId }));
    expect(stampOf(dispatched[1])).toEqual(["personal:owner", "owner"]);
    // Grace's Organization does not make the Owner's Project hers, and a Space she cannot see
    // answers like a missing one.
    const refused = yield* threads
      .dispatch(
        threadCreate("member", { projectId, spaceId: acme, ownerUserId: UserId.make("member-1") }),
      )
      .pipe(Effect.flip);
    expect(SpaceDirectory.spaceRefusalMessage(refused)).toBe(
      "Space personal:owner does not exist.",
    );
    // An archived Organization takes no new Threads; it is gone for its Members.
    const archived = yield* threads
      .dispatch(
        threadCreate("archived", {
          spaceId: SpaceId.make("org-old"),
          ownerUserId: UserId.make("member-1"),
        }),
      )
      .pipe(Effect.flip);
    expect(SpaceDirectory.spaceRefusalMessage(archived)).toBe("Space org-old does not exist.");
    expect(dispatched).toHaveLength(2);
  }).pipe(Effect.provide(makeLayer(dispatched)));
});
