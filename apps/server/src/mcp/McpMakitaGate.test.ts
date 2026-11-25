/**
 * Makita ticket 05: a Makita Thread's agent calls only its allow-list (its own `makita_*` tools,
 * its Thread's history, the background wait); everything else is an unknown tool to it, and no
 * other caller reaches the `makita_*` tools.
 */
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

const caller = (makita: boolean): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "provider:thread",
  thread: {
    threadId: ThreadId.make("thread:makita"),
    providerSessionId: "provider:thread",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "preview", "device", "pull-requests"]),
  issuedAt: 0,
  ...(makita ? { makita: { taskId: "mkt_1", configId: "mk_1" } } : {}),
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const NAMES = [
  "makita_comment",
  "makita_read_issue",
  "thread_history",
  "t3_background_wait",
  "t3_thread_launch",
  "create_threads",
  "request_secret",
  "list_secret_names",
  "watch_pull_request",
  "preview_open",
  "schedule_task",
] as const;
const probe = {
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext],
};
const ProbeToolkit = Toolkit.make(...NAMES.map((name) => Tool.make(name, probe)));
const ran = () => Effect.succeed({ ran: "ran" });
const layerProbeHandlers = McpToolAccess.toLayer(
  ProbeToolkit,
  Object.fromEntries(NAMES.map((name) => [name, McpToolAccess.reads(ran)])) as never,
);

const server = McpHttpServer.toolkitRegistration(ProbeToolkit, layerProbeHandlers).pipe(
  Layer.provideMerge(McpHttpServer.layerMakitaToolGate),
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(Layer.mock(ThreadManagement.ThreadManagementService)({})),
);

const reached = (scope: McpInvocationContext.McpInvocationScope, name: string) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((mcp) => mcp.callTool({ name, arguments: {} })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.exit,
    Effect.map((exit) => exit._tag === "Success" && JSON.stringify(exit).includes('\\"ran\\"')),
  );

it.effect("a Makita Thread reaches only its allow-list; nobody else reaches makita_*", () =>
  Effect.gen(function* () {
    const asMakita: Record<string, boolean> = {};
    const asOther: Record<string, boolean> = {};
    for (const name of NAMES) {
      asMakita[name] = yield* reached(caller(true), name);
      asOther[name] = yield* reached(caller(false), name);
    }
    expect(asMakita).toEqual({
      makita_comment: true,
      makita_read_issue: true,
      thread_history: true,
      t3_background_wait: true,
      t3_thread_launch: false,
      create_threads: false,
      request_secret: false,
      list_secret_names: false,
      watch_pull_request: false,
      preview_open: false,
      schedule_task: false,
    });
    expect(asOther).toEqual({
      makita_comment: false,
      makita_read_issue: false,
      thread_history: true,
      t3_background_wait: true,
      t3_thread_launch: true,
      create_threads: true,
      request_secret: true,
      list_secret_names: true,
      watch_pull_request: true,
      preview_open: true,
      schedule_task: true,
    });
    expect([...McpInvocationContext.MAKITA_ALLOWED_TOOLS].toSorted()).toEqual([
      "makita_comment",
      "makita_read_issue",
      "t3_background_wait",
      "thread_history",
    ]);
  }).pipe(Effect.provide(server)),
);
