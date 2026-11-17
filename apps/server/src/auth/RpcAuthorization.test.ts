import {
  AuthSessionId,
  INSTALLATION_OWNER_ONLY_MESSAGE,
  INSTALLATION_RPC_METHODS,
  UserId,
  type AuthEnvironmentScope,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as CurrentPrincipal from "./CurrentPrincipal.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";
import { guardRpcPayload, RPC_SPACE_ACCESS, spaceAccessForRpcMethod } from "./RpcSpaceAccess.ts";
import { everything } from "../spaces/SpaceVisibility.ts";
import type * as SchemaAST from "effect/SchemaAST";
import { layerSeesEverything } from "../spaces/SpaceVisibility.testkit.ts";

/** Every field name a payload schema can carry, at any depth and in any union member. */
const payloadFields = (
  ast: SchemaAST.AST,
  into: Set<string> = new Set(),
  seen: Set<SchemaAST.AST> = new Set(),
): Set<string> => {
  if (seen.has(ast)) return into;
  seen.add(ast);
  switch (ast._tag) {
    case "Objects":
      for (const property of ast.propertySignatures) {
        into.add(String(property.name));
        payloadFields(property.type, into, seen);
      }
      break;
    case "Arrays":
      for (const element of [...ast.elements, ...ast.rest]) payloadFields(element, into, seen);
      break;
    case "Union":
      for (const member of ast.types) payloadFields(member, into, seen);
      break;
    case "Suspend":
      payloadFields(ast.thunk(), into, seen);
      break;
  }
  return into;
};

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("keeps triage, which seeds an agent that reads logs and the database, behind operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareTriage)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [WS_METHODS.terminalObserve, WS_METHODS.subscribeTerminalMetadata]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalClose,
      WS_METHODS.previewStopLocalServer,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("routes every RPC that reaches Projects or Threads through the visibility rule", () => {
    // A new read RPC that names a Thread or Project, or any orchestration RPC, must say here how
    // it keeps to what the session may see.
    const named = [...WsRpcGroup.requests.entries()].flatMap(([tag, rpc]) => {
      const fields = payloadFields(rpc.payloadSchema.ast);
      return tag.startsWith("orchestration.") ||
        ["threadId", "threadIds", "projectId", "projectIds"].some((field) => fields.has(field))
        ? [tag]
        : [];
    });
    expect(named.filter((tag) => spaceAccessForRpcMethod(tag) === undefined)).toEqual([]);
    for (const [tag, access] of Object.entries(RPC_SPACE_ACCESS)) {
      const fields = payloadFields(WsRpcGroup.requests.get(tag as never)!.payloadSchema.ast);
      if (access === "thread") expect([tag, fields.has("threadId")]).toEqual([tag, true]);
      if (access === "project") {
        expect([tag, fields.has("projectId") || fields.has("projectIds")]).toEqual([tag, true]);
      }
    }
  });

  it("says for every RPC how it keeps to what the session may see; one that does not is refused", () => {
    const tags = [...WsRpcGroup.requests.keys()];
    expect(tags.filter((tag) => spaceAccessForRpcMethod(tag) === undefined)).toEqual([]);
    // One working on a Hub folder names it.
    for (const [tag, access] of Object.entries(RPC_SPACE_ACCESS)) {
      if (access !== "readDirectory" && access !== "workDirectory") continue;
      const fields = payloadFields(WsRpcGroup.requests.get(tag as never)!.payloadSchema.ast);
      expect([tag, fields.has("cwd") || fields.has("paths")]).toEqual([tag, true]);
    }
  });

  it.effect("refuses an RPC that does not say, even for the Owner", () =>
    Effect.gen(function* () {
      const refused = yield* guardRpcPayload(
        "server.notListed",
        {},
        everything,
        {} as never,
        undefined,
      ).pipe(Effect.flip);
      expect(refused._tag).toBe("SpaceResourceNotFoundError");
    }),
  );

  it.effect(
    "keeps every RPC on the Installation as a whole to its Owner, whatever the scopes",
    () =>
      Effect.gen(function* () {
        const member = { all: false, spaceIds: [] } as const;
        for (const method of INSTALLATION_RPC_METHODS) {
          expect([method, spaceAccessForRpcMethod(method)]).toEqual([method, "installation"]);
          const refused = yield* guardRpcPayload(
            method,
            {},
            member,
            {} as never,
            UserId.make("member"),
          ).pipe(Effect.flip);
          expect([method, refused._tag, refused.message]).toEqual([
            method,
            "SpaceActionDeniedError",
            INSTALLATION_OWNER_ONLY_MESSAGE,
          ]);
          yield* guardRpcPayload(method, {}, everything, {} as never, UserId.make("owner"));
        }
        // The Hub's AI gateway: which CLIProxyAPI release runs, and its status, are the Owner's.
        for (const method of [
          WS_METHODS.aiGatewayStatus,
          WS_METHODS.aiGatewayCheckForUpdates,
          WS_METHODS.aiGatewayUpdate,
          WS_METHODS.aiGatewayRollback,
          WS_METHODS.aiGatewaySetEnabled,
        ]) {
          expect([method, spaceAccessForRpcMethod(method)]).toEqual([method, "installation"]);
          const refused = yield* guardRpcPayload(
            method,
            { version: "9.9.9" },
            member,
            {} as never,
            UserId.make("member"),
          ).pipe(Effect.flip);
          expect([method, refused.message]).toEqual([method, INSTALLATION_OWNER_ONLY_MESSAGE]);
        }
        // Owned-resources 08: any User manages AI accounts of their own (AiAccounts decides by
        // AccessPolicy `aiAccount.manage` on the account's owner), with a standard session's
        // access:write. Allowances are gone (Grants ticket 02): AI accounts are lent with Grants.
        for (const method of [
          WS_METHODS.aiAccountsCreate,
          WS_METHODS.aiAccountsUpdate,
          WS_METHODS.aiAccountsDelete,
          WS_METHODS.aiAccountsReorder,
          WS_METHODS.aiAccountsLoginStart,
          WS_METHODS.aiAccountsLoginComplete,
          WS_METHODS.aiAccountsImportVertex,
          WS_METHODS.aiAccountsImportCliproxy,
        ]) {
          expect([method, requiredScopeForRpcMethod(method)]).toEqual([
            method,
            AuthAccessWriteScope,
          ]);
          expect(typeof spaceAccessForRpcMethod(method)).toBe("object");
          yield* guardRpcPayload(
            method,
            { accountId: "acct", accountIds: [] },
            member,
            {} as never,
            UserId.make("member"),
          );
        }
        // An ACP agent's model provider is set on the Installation's provider instance, with
        // its secrets; the Project only says where the agent runs.
        for (const method of [
          WS_METHODS.serverSetAcpRegistryProvider,
          WS_METHODS.serverDisableAcpRegistryProvider,
        ]) {
          expect([method, spaceAccessForRpcMethod(method)]).toEqual([method, "installation"]);
        }
        // Only RPCs really of one session or one connection stay unscoped.
        const unscoped = Object.entries(RPC_SPACE_ACCESS).flatMap(([method, access]) =>
          typeof access === "object" ? [method] : [],
        );
        for (const method of [
          WS_METHODS.serverUpdateSettings,
          WS_METHODS.serverGetProcessDiagnostics,
          WS_METHODS.serverSignalProcess,
          WS_METHODS.serverPrepareTriage,
          WS_METHODS.providerAuthStart,
          WS_METHODS.deviceConfigure,
          WS_METHODS.deviceAction,
          WS_METHODS.agentSessionsScan,
          WS_METHODS.subscribeAuthAccess,
        ]) {
          expect(unscoped).not.toContain(method);
        }
      }),
  );

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

const scopeAuthorization = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  RpcAuthorization.layer.pipe(
    Layer.provide(layerSeesEverything),
    Layer.provide(
      CurrentPrincipal.layer({
        sessionId: AuthSessionId.make("rpc-authorization-test"),
        subject: "rpc-authorization-test",
        method: "browser-session-cookie",
        scopes,
      }),
    ),
  );

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            scopeAuthorization(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("local CLI keys (spec 4 ticket 10)", () => {
  const tested = [
    WS_METHODS.aiGatewayKeysList,
    WS_METHODS.aiGatewayKeysCreate,
    WS_METHODS.aiGatewayKeysRevoke,
  ] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const listed = { keys: [], everyone: false };

  it.effect(
    "lists with access:read; makes and revokes only with access:write, before the handler runs",
    () =>
      Effect.gen(function* () {
        const handled: Array<string> = [];
        const clientWith = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
          RpcTest.makeClient(group).pipe(
            Effect.provide(
              Layer.mergeAll(
                group.toLayerHandler(WS_METHODS.aiGatewayKeysList, () => Effect.succeed(listed)),
                group.toLayerHandler(WS_METHODS.aiGatewayKeysCreate, () =>
                  Effect.sync(() => handled.push("create")).pipe(Effect.andThen(Effect.never)),
                ),
                group.toLayerHandler(WS_METHODS.aiGatewayKeysRevoke, () =>
                  Effect.sync(() => handled.push("revoke")).pipe(Effect.andThen(Effect.never)),
                ),
                scopeAuthorization(scopes),
              ),
            ),
          );
        const reader = yield* clientWith([AuthAccessReadScope]);
        expect(yield* reader[WS_METHODS.aiGatewayKeysList]({})).toEqual(listed);
        expect(
          yield* reader[WS_METHODS.aiGatewayKeysCreate]({ name: "Laptop" }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthAccessWriteScope,
        });
        expect(
          yield* reader[WS_METHODS.aiGatewayKeysRevoke]({ keyId: "gk_1" }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthAccessWriteScope,
        });
        const noRead = yield* clientWith([AuthOrchestrationReadScope]);
        expect(yield* noRead[WS_METHODS.aiGatewayKeysList]({}).pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthAccessReadScope,
        });
        expect(handled).toEqual([]);
      }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            scopeAuthorization([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      yield* client[WS_METHODS.serverUpdateSettings]({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("codex_work"),
          instance: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              {
                name: "OPENAI_API_KEY",
                sensitive: true,
                value: {
                  provider: SecretProviderId.make("personal"),
                  reference: "op://Private/OpenAI/credential",
                },
              },
            ],
          },
        },
      });
      expect(handled).toBe(2);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers or secret providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            scopeAuthorization([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          scopeAuthorization([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(Layer.merge(handler, scopeAuthorization([AuthSourceControlWriteScope]))),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              scopeAuthorization([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }).pipe(Effect.scoped),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          scopeAuthorization([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          scopeAuthorization([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);
