// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalTimers:off globalJsonInEffect:off - a client on the real port over the fake CLIProxyAPI.
/**
 * The AI gateway layer on a real port over the fake CLIProxyAPI, with Ada (Admin), Grace (Member)
 * and Linus (Guest) of Acme and Gus of Globex (shared by the gateway layer's and usage's tests).
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";

import {
  type AiAccountId,
  type AiAccountProvider,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";

import * as AuditLog from "../audit/AuditLog.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  addMember,
  bootstrapOwner,
  joinOrganization,
  makeAuthenticator,
  serveAuthHttp,
} from "../auth/UserAuth.testkit.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AiAccounts from "./AiAccounts.ts";
import * as AiGateway from "./AiGateway.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import * as AiGatewayKeyRevocation from "./AiGatewayKeyRevocation.ts";
import * as AiGatewayKeys from "./AiGatewayKeys.ts";
import * as AiGatewayProxy from "./AiGatewayProxy.ts";
import * as AiGatewayRoute from "./AiGatewayRoute.ts";
import * as AiUsage from "./AiUsage.ts";
import { fakeCliproxyRelease, fakeReleases, pinsOf } from "./AiGateway.testkit.ts";
import { cliproxyPlatformOf } from "./cliproxyRelease.ts";
import { CliproxyReleases } from "./CliproxyReleases.ts";

const os = HostProcess.Platform.defaultValue();
export const platform = cliproxyPlatformOf(os, HostProcess.Architecture.defaultValue());
export const posix = os === "linux" || os === "darwin";

export const PROMPT = "PROMPT-the-secret-plan-7f3a9";
/** The Hub's limits in these tests: a small body limit, so the size test sends little. */
const TEST_LIMITS: AiGatewayProxy.AiGatewayProxyLimits = {
  ...AiGatewayProxy.DEFAULT_AI_GATEWAY_PROXY_LIMITS,
  maxRequestBytes: 256 * 1024,
};
export const PROVIDER_KEYS = ["sk-ant-acme-claude-a-0123456789", "sk-ant-acme-claude-b-0123456789"];

export const hubWith = Effect.fn(function* (
  limits: Partial<AiGatewayProxy.AiGatewayProxyLimits> = {},
  options: { readonly usage?: AiUsage.AiUsageOptions } = {},
) {
  const server = yield* serveAuthHttp;
  const authenticator = yield* makeAuthenticator();
  const { created } = yield* bootstrapOwner(server, authenticator);
  const ownerCookie = created.cookie ?? "";
  const ownerId = UserId.make((created.body.user as { id: string }).id);
  const organization = Effect.fn(function* (name: string) {
    const made = yield* server.request("/api/spaces/organizations", {
      body: { name },
      cookie: ownerCookie,
    });
    return SpaceId.make(made.body.id as string);
  });
  const acmeId = yield* organization("Acme");
  const globexId = yield* organization("Globex");
  const cookies: Record<string, string> = {};
  const person = Effect.fn(function* (
    id: string,
    spaceId: SpaceId,
    role: "admin" | "member" | "guest",
  ) {
    cookies[id] = yield* addMember(server, { id, displayName: id });
    yield* joinOrganization(server, spaceId, id, role);
    if (role === "admin") {
      yield* server.sql`INSERT INTO user_passkeys (credential_id, user_id, public_key, sign_count,
          transports, rp_id, created_at)
        VALUES (${`${id}-key`}, ${id}, 'key', 0, '[]', '127.0.0.1', '2026-01-01T00:00:00.000Z')`;
    }
    return UserId.make(id);
  });
  const people = {
    admin: yield* person("ada", acmeId, "admin"),
    member: yield* person("grace", acmeId, "member"),
    guest: yield* person("linus", acmeId, "guest"),
    globexMember: yield* person("gus", globexId, "member"),
  };
  const directory = Context.get(server.services, SpaceDirectory.SpaceDirectory);
  yield* directory.membershipsChanged(Object.values(people));

  // The fake CLIProxyAPI as the Hub runs it.
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ai-gateway-route-"));
  const release = fakeCliproxyRelease(dir, "1.0.0");
  const stateDir = NodePath.join(dir, "state");
  const memory = NodePath.join(dir, "memory");
  NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const gateway = yield* AiGateway.make({
    placement: { _tag: "forced", enabled: true },
    os,
    stateDir,
    platform: platform!,
    pinned: pinsOf([release]),
    runtimeFolder: { directory: memory, inMemory: true },
    restartDelay: { initialMs: 100, maxMs: 200 },
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          ServerSecretStore.ServerSecretStore,
          Context.get(server.services, ServerSecretStore.ServerSecretStore),
        ),
        Layer.succeed(CliproxyReleases, fakeReleases({ releases: [release] }).service),
        Layer.succeed(
          AuditLog.AuditLog,
          AuditLog.AuditLog.of({ record: () => Effect.void, list: () => Effect.die("not used") }),
        ),
        FetchHttpClient.layer,
      ),
    ),
  );
  yield* gateway.changes.pipe(
    Stream.filter((status) => status.state === "running"),
    Stream.runHead,
  );
  const context = yield* Layer.build(
    AiGatewayProxy.layerWith({ ...TEST_LIMITS, ...limits }).pipe(
      // A User removed or leaving a Space: their keys are revoked, as on the Hub (ticket 10).
      Layer.provideMerge(AiGatewayKeyRevocation.layerUserChanges),
      Layer.provideMerge(AiGatewayKeys.layer),
      Layer.provideMerge(
        AiUsage.layerWith(options.usage ?? { retentionDays: 90, sweepEveryMs: 86_400_000 }),
      ),
      Layer.provideMerge(AiGatewayActivity.layer),
      Layer.provideMerge(AiAccounts.layer),
      Layer.provideMerge(AuditLog.layer),
      Layer.provideMerge(Layer.succeed(AiGateway.AiGateway, gateway)),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(Layer.succeedContext(server.services)),
    ),
  );
  const served = yield* HttpRouter.serve(AiGatewayRoute.layer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(Layer.succeedContext(Context.merge(server.services, context))),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.fresh,
    Layer.build,
  );
  const address = Context.get(served, HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
  const port = address.port;
  const accounts = Context.get(context, AiAccounts.AiAccounts);
  const keys = Context.get(context, AiGatewayKeys.AiGatewayKeys);
  const activity = Context.get(context, AiGatewayActivity.AiGatewayActivity);
  const usage = Context.get(context, AiUsage.AiUsage);
  // Each request the usage log took in, in order; `settled(n)` waits for the n-th (no polling).
  const written: Array<boolean> = [];
  const pullOutcomes = yield* Stream.toPull(yield* usage.outcomes);
  const settled = Effect.fn(function* (count: number) {
    while (written.length < count) {
      const chunk = yield* pullOutcomes;
      for (const outcome of chunk) written.push(outcome.written);
    }
  });
  const asOwner = CommandActor.actAs(ownerId);

  const account = Effect.fn(function* (
    name: string,
    provider: AiAccountProvider,
    allow: { readonly spaceIds?: ReadonlyArray<SpaceId>; readonly userIds?: ReadonlyArray<UserId> },
    extra: { readonly baseUrl?: string; readonly models?: ReadonlyArray<string> } = {},
  ) {
    const made = yield* accounts
      .create({
        name,
        provider: provider as never,
        apiKey: Redacted.make(`sk-test-${name.replaceAll(" ", "-")}-0123456789abcdef`),
        ...extra,
      })
      .pipe(asOwner);
    yield* accounts
      .allow({
        accountId: made.id,
        spaceIds: [...(allow.spaceIds ?? [])],
        userIds: [...(allow.userIds ?? [])],
      })
      .pipe(asOwner);
    return made.id;
  });

  let threads = 0;
  /** A Project in `spaceId` and a Thread of `ownerUserId` in it; the Thread's Space is its Project's. */
  const thread = Effect.fn(function* (
    ownerUserId: UserId,
    spaceId: SpaceId,
    aiAccountId?: AiAccountId,
  ) {
    threads += 1;
    const projectId = `project-${threads}`;
    const threadId = ThreadId.make(`thread-${threads}`);
    const at = "2026-11-01T00:00:00.000Z";
    yield* server.sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at,
        updated_at, space_id, owner_user_id)
      VALUES (${projectId}, ${projectId}, ${`/work/${projectId}`}, '[]', ${at}, ${at}, ${spaceId},
        ${ownerUserId})
    `;
    const modelSelection = {
      instanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
      ...(aiAccountId === undefined ? {} : { aiAccountId }),
    };
    yield* server.sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json, owner_user_id
      ) VALUES (
        ${threadId}, ${projectId}, ${threadId}, 'claudeAgent', 'full-access', 'default', ${at},
        ${at}, ${JSON.stringify({ lineage: { rootThreadId: threadId }, modelSelection })},
        ${ownerUserId}
      )
    `;
    const issued = yield* keys.issueForThread(threadId);
    return { threadId, projectId, key: Redacted.value(issued.key) };
  });

  /** What the fake CLIProxyAPI was asked, in order. */
  const upstream = () => {
    const file = NodePath.join(memory, "fake-ai-requests.jsonl");
    return NodeFS.existsSync(file)
      ? NodeFS.readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
          .map(
            (line) =>
              JSON.parse(line) as {
                readonly path: string;
                readonly search: string;
                readonly model: string;
                readonly authOk: boolean;
                readonly headerNames: ReadonlyArray<string>;
                readonly bodyKeys: ReadonlyArray<string>;
                /** The roles of its `messages` (or `input` items), in order. */
                readonly roles: ReadonlyArray<string>;
              },
          )
      : [];
  };
  const unknownUpstream = () => {
    const file = NodePath.join(memory, "fake-unknown.jsonl");
    return NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "";
  };
  const flag = (name: string, on = true) => {
    const file = NodePath.join(memory, name);
    if (on) NodeFS.writeFileSync(file, "1");
    else NodeFS.rmSync(file, { force: true });
  };

  return {
    server,
    /** The AI layers built over the Hub's services (to build a variant of one in a test). */
    context,
    ownerId,
    ownerCookie,
    cookies,
    acmeId,
    globexId,
    people,
    directory,
    accounts,
    keys,
    activity,
    usage,
    written,
    settled,
    asOwner,
    port,
    account,
    thread,
    upstream,
    memory,
    unknownUpstream,
    flag,
  };
});

export const hub = hubWith();
export type Hub = Effect.Success<typeof hub>;

export interface Answer {
  readonly status: number;
  readonly text: string;
  readonly headers: Headers;
  readonly json: Record<string, unknown> | null;
}

/** A request to the gateway on its real port, as an agent or a CLI sends it. */
export const call = (
  setup: Hub,
  path: string,
  init: {
    readonly key?: string;
    readonly keyHeader?: "authorization" | "x-api-key" | "x-goog-api-key";
    readonly body?: unknown;
    readonly rawBody?: string;
    readonly method?: string;
    readonly headers?: Record<string, string>;
  } = {},
) =>
  Effect.promise(async (): Promise<Answer> => {
    const keyHeader = init.keyHeader ?? "authorization";
    const response = await fetch(`http://127.0.0.1:${setup.port}${path}`, {
      method:
        init.method ?? (init.body === undefined && init.rawBody === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(init.key === undefined
          ? {}
          : { [keyHeader]: keyHeader === "authorization" ? `Bearer ${init.key}` : init.key }),
        ...init.headers,
      },
      ...(init.body === undefined
        ? init.rawBody === undefined
          ? {}
          : { body: init.rawBody as string }
        : { body: JSON.stringify(init.body) }),
    });
    // An answer the gateway cut ends early: what came is the text.
    let text = "";
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      // Cut off.
    }
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { status: response.status, text, headers: response.headers, json };
  });

/** A request with its path sent byte for byte (no client normalization of `..` or `%2F`). */
export const rawCall = (setup: Hub, path: string, key: string, method = "POST") =>
  Effect.promise(
    () =>
      new Promise<{ readonly status: number; readonly text: string }>((resolve, reject) => {
        const request = NodeHttp.request(
          {
            host: "127.0.0.1",
            port: setup.port,
            method,
            path,
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          },
          (response) => {
            let text = "";
            response.on("data", (chunk) => (text += String(chunk)));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }));
      }),
  );

export const messages = (model = "claude-sonnet-5-5", extra: Record<string, unknown> = {}) => ({
  model,
  max_tokens: 64,
  messages: [{ role: "user", content: PROMPT }],
  ...extra,
});

export const upstreamModels = (setup: Hub) => setup.upstream().map((request) => request.model);

/** Acme: Claude A then Claude B (priority 1, 2) and an OpenRouter; Globex: its own Claude. */
export const acmeSetup = Effect.fn(function* (setup: Hub) {
  const claudeA = yield* setup.account("Acme Claude A", "claude", { spaceIds: [setup.acmeId] });
  const claudeB = yield* setup.account("Acme Claude B", "claude", { spaceIds: [setup.acmeId] });
  const globexClaude = yield* setup.account("Globex Claude", "claude", {
    spaceIds: [setup.globexId],
  });
  const router = yield* setup.account(
    "Acme OpenRouter",
    "openai-compatible",
    { spaceIds: [setup.acmeId] },
    { baseUrl: "https://openrouter.example/api/v1", models: ["deepseek-chat"] },
  );
  const globexRouter = yield* setup.account(
    "Globex OpenRouter",
    "openai-compatible",
    { spaceIds: [setup.globexId] },
    { baseUrl: "https://openrouter.example/api/v1", models: ["globex-secret-model"] },
  );
  const graceGemini = yield* setup.account("Grace Gemini", "gemini", {
    userIds: [setup.people.member],
  });
  return { claudeA, claudeB, globexClaude, router, globexRouter, graceGemini };
});
