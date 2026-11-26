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

const caller = (
  makita: "comment" | "push" | "land" | "label" | "close" | null,
): McpInvocationContext.McpInvocationScope => ({
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
  ...(makita === null
    ? {}
    : {
        makita: {
          taskId: "mkt_1",
          configId: "mk_1",
          push: makita === "push" || makita === "land",
          land: makita === "land",
          label: makita === "label",
          // Ticket 26: a configuration that only comments may still close issues.
          close: makita === "close",
        },
      }),
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
  "makita_push",
  "makita_open_pull_request",
  "makita_ci_logs",
  "makita_request_merge",
  "makita_request_approval",
  "makita_search",
  "makita_label",
  "makita_close_issue",
  "merge_pull_request",
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
    const asPusher: Record<string, boolean> = {};
    const asLander: Record<string, boolean> = {};
    const asLabeler: Record<string, boolean> = {};
    const asCloser: Record<string, boolean> = {};
    const asOther: Record<string, boolean> = {};
    for (const name of NAMES) {
      asMakita[name] = yield* reached(caller("comment"), name);
      asPusher[name] = yield* reached(caller("push"), name);
      asLander[name] = yield* reached(caller("land"), name);
      asLabeler[name] = yield* reached(caller("label"), name);
      asCloser[name] = yield* reached(caller("close"), name);
      asOther[name] = yield* reached(caller(null), name);
    }
    // A scope that says land without push still gets no merge request.
    const landOnly = caller("comment");
    expect(
      yield* reached(
        { ...landOnly, makita: { ...landOnly.makita!, land: true } },
        "makita_request_merge",
      ),
    ).toBe(false);
    // Ticket 10: a configuration that only comments does not see makita_push. Ticket 12: nor
    // its pull request or the CI logs; nobody's agent has a merge tool.
    expect(asMakita).toEqual({
      makita_comment: true,
      makita_read_issue: true,
      makita_push: false,
      makita_open_pull_request: false,
      makita_ci_logs: false,
      makita_request_merge: false,
      makita_request_approval: false,
      // Ticket 23: every Makita Thread may search its own repository; 24: labels only when listed.
      makita_search: true,
      makita_label: false,
      makita_close_issue: false,
      merge_pull_request: false,
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
    expect(asPusher).toEqual({
      ...asMakita,
      makita_push: true,
      makita_open_pull_request: true,
      makita_ci_logs: true,
      // Ticket 29: only a pushing configuration has pushes that wait for an approver.
      makita_request_approval: true,
    });
    // Ticket 13: only a configuration that may land sees the merge request; still no merge tool.
    expect(asLander).toEqual({ ...asPusher, makita_request_merge: true });
    expect(asLabeler).toEqual({ ...asMakita, makita_label: true });
    // Ticket 26: only a configuration that may close issues sees the close request.
    expect(asCloser).toEqual({ ...asMakita, makita_close_issue: true });
    expect(asOther).toEqual({
      makita_comment: false,
      makita_read_issue: false,
      makita_push: false,
      makita_open_pull_request: false,
      makita_ci_logs: false,
      makita_request_merge: false,
      makita_request_approval: false,
      makita_search: false,
      makita_label: false,
      makita_close_issue: false,
      merge_pull_request: true,
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
      "makita_ci_logs",
      "makita_close_issue",
      "makita_comment",
      "makita_label",
      "makita_open_pull_request",
      "makita_push",
      "makita_read_issue",
      "makita_request_approval",
      "makita_request_merge",
      "makita_search",
      "t3_background_wait",
      "thread_history",
    ]);
  }).pipe(Effect.provide(server)),
);
