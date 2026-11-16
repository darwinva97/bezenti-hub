// @effect-diagnostics nodeBuiltinImport:off -- the tests read and write files on disk.
import * as NodeFSP from "node:fs/promises";

import { assert, describe, it } from "@effect/vitest";
import {
  type AssetResource,
  CommandId,
  HUB_MACHINE_ENVIRONMENT_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { fetch as undiciFetch } from "undici";

import * as AssetSigner from "../assets/AssetSigner.ts";
import { addMember } from "../auth/UserAuth.testkit.ts";
import { issueThreadAssetUrl, type ThreadAssetResource } from "../assets/ThreadAssets.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeHub, seedProject, type Hub } from "./HubWithEnvironments.testkit.ts";
import { idleAdapters, moveThread, ownerIdOf } from "./HubWithEnvironments.scenarios.testkit.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");

/** The Hub's workspace calls (what `ws.ts` uses), over the Hub's own projection and Environments. */
const threadWorkspaceOf = (hub: Hub) =>
  ThreadWorkspace.make.pipe(
    Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
    Effect.provideContext(hub.server.services as never),
  ) as Effect.Effect<ThreadWorkspace.ThreadWorkspace["Service"]>;

/** As `ws.ts` runs it: the Hub's services, and the workspace paths its handlers get. */
const asWs =
  (hub: Hub) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(Layer.merge(WorkspacePaths.layer, AssetSigner.layer)),
      Effect.provideContext(hub.server.services as never),
    ) as Effect.Effect<A, E>;

/** The same files on both machines, each telling which machine it is on. */
const writeFiles = (root: string, machine: string) =>
  Effect.promise(async () => {
    await NodeFSP.mkdir(`${root}/site/img`, { recursive: true });
    await NodeFSP.writeFile(
      `${root}/site/index.html`,
      `<!doctype html><title>${machine}</title><img src="img/logo.png">`,
    );
    await NodeFSP.writeFile(`${root}/site/img/logo.png`, `PNG from ${machine}`);
    await NodeFSP.writeFile(`${root}/doc.pdf`, `%PDF from ${machine}`);
    await NodeFSP.writeFile(`${root}/notes.txt`, `notes from ${machine}\n`);
  });

/** A Thread of the Owner's on the Laptop; the Hub machine keeps an older copy at the same paths. */
const threadOnLaptop = Effect.fn(function* () {
  const hub = yield* makeHub();
  const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
  const projectId = ProjectId.make("project:assets");
  const { workspaceRoot: hubCheckout } = yield* seedProject(hub.server, {
    projectId,
    title: "Assets project",
    defaultModelSelection: null,
  });
  const threadId = ThreadId.make("thread:assets");
  yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:assets-thread"),
    threadId,
    projectId,
    title: "Assets",
    modelSelection: { instanceId, model: "claude-sonnet-4-6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeEnvironmentId: laptop.environmentId,
  });
  const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const laptopCheckout = Option.getOrThrow(
    yield* (yield* registry.get(laptop.environmentId)).workspace.paths.checkout(projectId),
  );
  yield* writeFiles(laptopCheckout, "the Laptop");
  yield* writeFiles(hubCheckout, "the Hub");
  const ownerId = yield* ownerIdOf(hub);
  const workspace = yield* threadWorkspaceOf(hub);
  /** `assets.createUrl` for a Thread's file, as the Owner asks for it. */
  const issue = (resource: ThreadAssetResource, viewer: UserId = ownerId) =>
    issueThreadAssetUrl({
      resource,
      viewer,
      threadWorkspace: workspace,
      localWorkspaceRoot: Effect.succeed(hubCheckout),
    }).pipe(asWs(hub));
  return { hub, laptop, threadId, projectId, hubCheckout, laptopCheckout, ownerId, issue };
});

interface Fetched {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

/** A browser's GET of an asset URL on the Hub. */
const get = (hub: Hub, relativeUrl: string, cookie?: string, range?: string) =>
  Effect.promise(async (): Promise<Fetched> => {
    const response = await undiciFetch(new URL(relativeUrl, hub.server.url), {
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(range === undefined ? {} : { range }),
      },
    });
    return {
      status: response.status,
      headers: response.headers as unknown as Headers,
      text: await response.text(),
    };
  });

const workspaceFile = (threadId: ThreadId, path: string): AssetResource & ThreadAssetResource => ({
  _tag: "workspace-file",
  threadId,
  path,
});
const mediaFile = (
  threadId: ThreadId,
  path: string,
  download = false,
): AssetResource & ThreadAssetResource => ({
  _tag: "media-file",
  threadId,
  path,
  ...(download ? { disposition: "attachment" as const } : {}),
});

describe("Hub con Environments: a Thread's files served by URL (ticket 15)", () => {
  it.live("come from the Thread's machine, never from the Hub's copy at the same path", () =>
    Effect.gen(function* () {
      const { hub, threadId, hubCheckout, issue } = yield* threadOnLaptop();

      // An HTML preview, and the image it loads by a relative URL.
      const page = yield* issue(workspaceFile(threadId, `${hubCheckout}/site/index.html`));
      const html = yield* get(hub, page.relativeUrl, hub.owner);
      assert.equal(html.status, 200);
      assert.include(html.text, "the Laptop");
      assert.include(String(html.headers.get("content-type")), "text/html");
      assert.include(String(html.headers.get("content-security-policy")), "sandbox");
      const image = yield* get(
        hub,
        new URL("img/logo.png", `http://x${page.relativeUrl}`).pathname,
      );
      assert.equal(image.status, 200);
      assert.equal(image.text, "PNG from the Laptop");

      // A PDF (a media file, as the Files panel asks for one), by absolute and relative path.
      for (const path of [`${hubCheckout}/doc.pdf`, "doc.pdf"]) {
        const pdf = yield* issue(mediaFile(threadId, path));
        const fetched = yield* get(hub, pdf.relativeUrl, hub.owner);
        assert.equal(fetched.status, 200, path);
        assert.equal(fetched.text, "%PDF from the Laptop", path);
        assert.equal(fetched.headers.get("content-type"), "application/pdf");
      }

      // A download (any file), served as an attachment.
      const download = yield* issue(mediaFile(threadId, `${hubCheckout}/notes.txt`, true));
      const saved = yield* get(hub, download.relativeUrl, hub.owner);
      assert.equal(saved.status, 200);
      assert.equal(saved.text, "notes from the Laptop\n");
      assert.include(String(saved.headers.get("content-disposition")), "attachment");

      // A range of it, as a video or PDF viewer asks.
      const ranged = yield* get(hub, download.relativeUrl, hub.owner, "bytes=6-9");
      assert.equal(ranged.status, 206);
      assert.equal(ranged.text, "from");
    }).pipe(Effect.scoped),
  );

  it.live("refuse a path outside the Thread's workspace on its machine", () =>
    Effect.gen(function* () {
      const { threadId, issue } = yield* threadOnLaptop();
      const outside = yield* issue(mediaFile(threadId, "/etc/hostname")).pipe(Effect.flip);
      assert.equal(outside._tag, "AssetRemoteEnvironmentError");
      assert.include(outside.message, "Laptop");
      const climbing = yield* issue(mediaFile(threadId, "../secret.pdf")).pipe(Effect.flip);
      assert.equal(climbing._tag, "AssetRemoteEnvironmentError");
    }).pipe(Effect.scoped),
  );

  it.live("are served to the User they were issued to, for that Thread, while it stays put", () =>
    Effect.gen(function* () {
      const { hub, threadId, hubCheckout, issue } = yield* threadOnLaptop();
      const pdf = yield* issue(mediaFile(threadId, `${hubCheckout}/doc.pdf`));
      const page = yield* issue(workspaceFile(threadId, `${hubCheckout}/site/index.html`));

      // Another User signed in never gets it; an embed without a session gets it as the URL's own.
      const member = yield* addMember(hub.server);
      assert.equal((yield* get(hub, pdf.relativeUrl, member)).status, 404);
      assert.equal((yield* get(hub, pdf.relativeUrl)).status, 200);

      // The token names its Thread: another Thread's, or a path that climbs out, is refused.
      const [, , , token, name] = pdf.relativeUrl.split("/");
      const [payload, signature] = token!.split(".");
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
      const forged = Buffer.from(JSON.stringify({ ...claims, threadId: "thread:other" })).toString(
        "base64url",
      );
      assert.equal(
        (yield* get(hub, `/api/assets/${forged}.${signature}/${name}`, hub.owner)).status,
        404,
      );
      const base = page.relativeUrl.slice(0, page.relativeUrl.lastIndexOf("/"));
      assert.equal((yield* get(hub, `${base}/..%2Fdoc.pdf`, hub.owner)).status, 404);
      assert.equal((yield* get(hub, `${base}/.git%2Fconfig`, hub.owner)).status, 404);

      // Moved to another machine, or back to the Hub machine, the old URL serves nothing.
      const desktop = yield* hub.join({ name: "Desktop", adapters: idleAdapters(instanceId) });
      yield* moveThread(hub, threadId, desktop.environmentId);
      assert.equal((yield* get(hub, pdf.relativeUrl, hub.owner)).status, 404);
      yield* moveThread(hub, threadId, HUB_MACHINE_ENVIRONMENT_ID);
      const back = yield* get(hub, pdf.relativeUrl, hub.owner);
      assert.equal(back.status, 404);
      assert.notInclude(back.text, "the Hub");
    }).pipe(Effect.scoped),
  );

  it.live("say «environment offline» while the machine is away, at once", () =>
    Effect.gen(function* () {
      const { hub, laptop, threadId, hubCheckout, issue } = yield* threadOnLaptop();
      const pdf = yield* issue(mediaFile(threadId, `${hubCheckout}/doc.pdf`));
      yield* laptop.disconnect;
      const refused = yield* issue(mediaFile(threadId, `${hubCheckout}/doc.pdf`)).pipe(Effect.flip);
      assert.equal(refused._tag, "AssetRemoteEnvironmentError");
      assert.include(refused.message, "Environment offline");
      const started = yield* Clock.currentTimeMillis;
      const served = yield* get(hub, pdf.relativeUrl, hub.owner);
      assert.equal(served.status, 503);
      assert.include(served.text, "Environment offline");
      assert.isBelow((yield* Clock.currentTimeMillis) - started, 5_000);
    }).pipe(Effect.scoped),
  );

  it.live("never leave a byte of the machine's files on the Hub's disk", () =>
    Effect.gen(function* () {
      const { hub, threadId, hubCheckout, issue } = yield* threadOnLaptop();
      const download = yield* issue(mediaFile(threadId, `${hubCheckout}/notes.txt`, true));
      assert.equal((yield* get(hub, download.relativeUrl, hub.owner)).status, 200);
      const page = yield* issue(workspaceFile(threadId, `${hubCheckout}/site/index.html`));
      assert.equal((yield* get(hub, page.relativeUrl, hub.owner)).status, 200);
      const config = hub.service(ServerConfig.ServerConfig);
      const holding = yield* Effect.promise(async () => {
        const found: Array<string> = [];
        const entries = await NodeFSP.readdir(config.baseDir, {
          recursive: true,
          withFileTypes: true,
        });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const file = `${entry.parentPath}/${entry.name}`;
          // The Hub's own checkout is its copy, never the Laptop's.
          if (file.startsWith(hubCheckout)) continue;
          const bytes = await NodeFSP.readFile(file).catch(() => Buffer.alloc(0));
          if (bytes.includes("from the Laptop")) found.push(file);
        }
        return found;
      });
      assert.deepEqual(holding, []);
    }).pipe(Effect.scoped),
  );

  it.live("a Thread on the Hub machine is served from the Hub machine as before", () =>
    Effect.gen(function* () {
      const { hub, threadId, hubCheckout, issue } = yield* threadOnLaptop();
      yield* moveThread(hub, threadId, HUB_MACHINE_ENVIRONMENT_ID);
      const pdf = yield* issue(mediaFile(threadId, `${hubCheckout}/doc.pdf`));
      const fetched = yield* get(hub, pdf.relativeUrl, hub.owner);
      assert.equal(fetched.status, 200);
      assert.equal(fetched.text, "%PDF from the Hub");
    }).pipe(Effect.scoped),
  );

  it.live("a machine before contract 15 is asked to update, never served from the Hub", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const old = yield* hub.join({
        name: "Old laptop",
        adapters: idleAdapters(instanceId),
        executorContractVersion: 14,
      });
      const projectId = ProjectId.make("project:assets-old");
      const { workspaceRoot: hubCheckout } = yield* seedProject(hub.server, {
        projectId,
        title: "Assets project",
        defaultModelSelection: null,
      });
      yield* writeFiles(hubCheckout, "the Hub");
      const threadId = ThreadId.make("thread:assets-old");
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:assets-old"),
        threadId,
        projectId,
        title: "Old",
        modelSelection: { instanceId, model: "claude-sonnet-4-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeEnvironmentId: old.environmentId,
      });
      const refused = yield* issueThreadAssetUrl({
        resource: mediaFile(threadId, `${hubCheckout}/doc.pdf`),
        viewer: yield* ownerIdOf(hub),
        threadWorkspace: yield* threadWorkspaceOf(hub),
        localWorkspaceRoot: Effect.succeed(hubCheckout),
      }).pipe(asWs(hub), Effect.flip);
      assert.equal(refused._tag, "AssetRemoteEnvironmentError");
      assert.include(refused.message, "Old laptop needs an update");
    }).pipe(Effect.scoped),
  );
});
