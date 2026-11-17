/**
 * The «Hub con Environments» scenario for spec 5 ticket 05 (masking): the Owner's Thread on a
 * Laptop whose agent printed OWNER_TOKEN and wrote it to notes.md, and the Hub's doors over it.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the tests read the Hub's files on disk.
// @effect-diagnostics globalJsonInEffect:off -- a test reads the whole database as text.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { assert } from "@effect/vitest";
import {
  type ProviderInstanceId,
  type SpaceId,
  type ThreadId,
  type UserId,
  type VaultEntryId,
} from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { maskDeep } from "@t3tools/shared/secretMasking";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Vaults from "../vaults/Vaults.ts";
import { type Hub, makeHub, type TestEnvironment } from "./HubWithEnvironments.testkit.ts";
import {
  awaitUploaded,
  createOrganization,
  loadFixture,
  ownerIdOf,
  replayOn,
  withEditingTurns,
} from "./HubWithEnvironments.scenarios.testkit.ts";
import { orgOwner, ownersDefault } from "../vaults/VaultGroups.testkit.ts";

export const OWNER_TOKEN = "owner-token-value-3333";
export const ROTATED_TOKEN = "owner-token-rotated-4444";

/** The Hub's workspace RPCs (what `ws.ts` calls), over the Hub's own projection and Environments. */
export const threadWorkspaceOf = (hub: Hub) =>
  ThreadWorkspace.make.pipe(
    Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
    Effect.provideContext(hub.server.services as never),
  ) as Effect.Effect<ThreadWorkspace.ThreadWorkspace["Service"]>;

/**
 * An agent that takes its secrets and prints one: its reply carries the value it received, split
 * in two as a streamed reply would. (The recorded reply is «fixture simple ok».)
 */
const printingSecret = (
  adapters: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >,
  value: string,
) =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (instanceId: ProviderInstanceId) =>
        registry.get(instanceId).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            receivesSecretEnv: true as const,
            openSession: (open: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              adapter.openSession(open).pipe(
                Effect.map((runtime) => ({
                  ...runtime,
                  events: runtime.events.pipe(
                    Stream.map((event) =>
                      maskDeep(event, (text) =>
                        text.replaceAll("fixture simple ok", `the token is ${value}, ok`),
                      ),
                    ),
                  ),
                })),
              ),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

/** Every file under `root` (but `skip`) that holds `value`, by path from `root`. */
export const filesHolding = (root: string, value: string, skip: ReadonlyArray<string> = []) =>
  Effect.promise(async () => {
    const needle = Buffer.from(value);
    const found: Array<string> = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        const full = NodePath.join(directory, entry.name);
        if (skip.includes(full)) continue;
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && NodeFS.readFileSync(full).includes(needle)) {
          found.push(NodePath.relative(root, full));
        }
      }
    };
    await walk(root);
    return found;
  });

/**
 * Every file of the Hub's state that holds `value`, by path. The sealed store included (spec 5
 * ticket 09): what it seals holds no clear text, so nothing is left out.
 */
export const hubFilesHolding = (hub: Hub, value: string) =>
  filesHolding(hub.service(ServerConfig.ServerConfig).stateDir, value);

/** Every file of a machine's T3 home but its Projects' checkouts (the agent's own files). */
export const machineFilesHolding = (machine: TestEnvironment, value: string) =>
  filesHolding(NodePath.dirname(machine.workspaceRoot), value, [machine.workspaceRoot]);

/** Every process of this host whose arguments hold `value` (`/proc/<pid>/cmdline`), by pid. */
export const processArgsHolding = (value: string) =>
  Effect.promise(async () => {
    // Hosts without /proc (macOS, Windows) have nothing to read here.
    if (!NodeFS.existsSync("/proc/self/cmdline")) return [];
    const found: Array<string> = [];
    for (const pid of await NodeFSP.readdir("/proc")) {
      if (!/^\d+$/u.test(pid)) continue;
      const args = await NodeFSP.readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.alloc(0));
      if (args.includes(Buffer.from(value)))
        found.push(`${pid}: ${args.toString().replaceAll("\0", " ")}`);
    }
    return found;
  });

/** Every row of every table of the Hub's database, as text. */
export const databaseText = (hub: Hub) =>
  Effect.gen(function* () {
    const tables = yield* hub.server.sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `;
    let text = "";
    for (const { name } of tables) {
      const rows = yield* hub.server.sql.unsafe(`SELECT * FROM "${name}"`);
      text += JSON.stringify(rows);
    }
    return text;
  });

export const putOwnerToken = (hub: Hub, owner: UserId, value: string, entryId?: VaultEntryId) =>
  ownersDefault(hub.server.sql).pipe(
    Effect.flatMap((main) =>
      hub
        .service(Vaults.Vaults)
        .putEntry({
          vaultId: main,
          ...(entryId === undefined ? {} : { entryId }),
          name: "OWNER_TOKEN",
          value: Redacted.make(value),
        })
        .pipe(CommandActor.actAs(owner)),
    ),
  );

/** The Hub's copy of the Thread's Project: the folder clients name. */
export const hubCheckoutOf = Effect.fn(function* (hub: Hub, threadId: ThreadId) {
  const projection = yield* hub.service(Orchestrator.OrchestratorV2).getThreadProjection(threadId);
  const project = yield* hub.service(ProjectStore.ProjectStoreV2).get(projection.thread.projectId);
  return projection.thread.worktreePath ?? Option.getOrThrow(project).workspaceRoot;
});

/** The Owner's Thread on the Laptop: its agent printed OWNER_TOKEN and wrote it to notes.md. */
export const turnThatPrintsTheSecret = Effect.fn(function* (
  options: {
    /** The Thread in an Organization «Acme», OWNER_TOKEN in its default «Acme secrets». */
    readonly inOrganization?: boolean;
  } = {},
) {
  const loaded = yield* loadFixture("simple");
  const hub = yield* makeHub();
  const owner = yield* ownerIdOf(hub);
  let spaceId: SpaceId | undefined;
  let entry: { readonly id: VaultEntryId };
  if (options.inOrganization === true) {
    spaceId = yield* createOrganization(hub, "Acme");
    const vaults = hub.service(Vaults.Vaults);
    const acme = yield* vaults
      .create({ name: "Acme secrets", owner: orgOwner(spaceId) })
      .pipe(CommandActor.actAs(owner));
    const put = yield* vaults
      .putEntry({ vaultId: acme.id, name: "OWNER_TOKEN", value: Redacted.make(OWNER_TOKEN) })
      .pipe(CommandActor.actAs(owner));
    entry = put.entry;
    yield* vaults
      .setSpaceDefaults({ spaceId, vaultIds: [acme.id] })
      .pipe(CommandActor.actAs(owner));
  } else {
    entry = (yield* putOwnerToken(hub, owner, OWNER_TOKEN)).entry;
  }
  const laptop = yield* hub.join({
    name: "Laptop",
    adapters: printingSecret(
      withEditingTurns(loaded.adapters, { file: "notes.md", content: `TOKEN=${OWNER_TOKEN}` }),
      OWNER_TOKEN,
    ),
  });
  yield* replayOn(hub, laptop, loaded, {
    ownerUserId: owner,
    ...(spaceId === undefined ? {} : { spaceId }),
  });
  const [threadId] = loaded.materialized.projectionThreadIds;
  assert.isDefined(threadId);
  yield* awaitUploaded(hub, threadId, 1);
  return { hub, laptop, owner, threadId: threadId as ThreadId, entryId: entry.id };
});
