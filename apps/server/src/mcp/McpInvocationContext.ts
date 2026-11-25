import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  type UserId,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type SpaceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { formatThreadLink, hostedThreadLink } from "@t3tools/shared/threadLinks";

const ALL_MCP_CAPABILITIES = [
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

export interface McpThreadCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** A delegated child task; its parent owns the work it hands back. */
  readonly subagent?: boolean;
}

export interface McpClientCaller {
  readonly sessionId: string;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  /** Narrower modes than it was approved with: an administrator's runtime-mode ceiling. */
  readonly narrowedTo?: ClientModes | undefined;
  /** An outside client's thread links open on this Hub origin, as Copy thread's do. */
  readonly hubOrigin?: string | undefined;
}

export interface ClientModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

const runtimeModeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const interactionModeRank: Record<ProviderInteractionMode, number> = { plan: 0, default: 1 };

/**
 * The modes a client caller's writes are capped at: what it was approved
 * with, narrowed by `narrowedTo`. A read-only client
 * never reaches a write (`McpToolAccess` refuses it first), so it maps to the
 * lowest runtime mode rather than to nothing.
 */
export const clientModeCeiling = (client: McpClientCaller | undefined): ClientModes => {
  const approved: ClientModes = {
    runtimeMode:
      client === undefined || client.access === "read-only" ? "approval-required" : client.access,
    interactionMode: "default",
  };
  const asked = client?.narrowedTo;
  if (asked === undefined) return approved;
  return {
    runtimeMode:
      runtimeModeRank[asked.runtimeMode] < runtimeModeRank[approved.runtimeMode]
        ? asked.runtimeMode
        : approved.runtimeMode,
    interactionMode:
      interactionModeRank[asked.interactionMode] < interactionModeRank[approved.interactionMode]
        ? asked.interactionMode
        : approved.interactionMode,
  };
};

/**
 * A client approved above an administrator's runtime-mode ceiling acts as if it had narrowed
 * itself to the ceiling, so what it starts and schedules is not refused for a mode it never chose.
 */
export const withRuntimeModeCeiling = (
  scope: McpInvocationScope,
  ceiling: RuntimeMode | undefined,
): McpInvocationScope => {
  if (ceiling === undefined || scope.client === undefined) return scope;
  const asked = scope.client.narrowedTo;
  return {
    ...scope,
    client: {
      ...scope.client,
      narrowedTo: {
        runtimeMode:
          asked !== undefined && runtimeModeRank[asked.runtimeMode] < runtimeModeRank[ceiling]
            ? asked.runtimeMode
            : ceiling,
        interactionMode: asked?.interactionMode ?? "default",
      },
    },
  };
};

/** Thread callers default to their own thread; client callers need thread for tools that act as the caller. */
export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  readonly requestNamespace: string;
  readonly thread: McpThreadCaller | undefined;
  readonly client: McpClientCaller | undefined;
  /**
   * The User the caller acts as: an agent's Thread owner, or the User who approved an outside
   * client. Reads and creations follow it, and `SpaceDirectory.principalOf` gives the same
   * principal WS and HTTP authorize by. None only before an Owner exists (or
   * for a Thread with no owner), which reads as the Owner.
   */
  readonly userId?: UserId;
  /**
   * The one Space an agent's credential reads in, when its Thread runs on a machine bound to that
   * Space (its Sandbox, a dedicated machine): every agent there can read the others' tokens.
   */
  readonly spaceLimit?: SpaceId;
  /**
   * The caller's Thread is a Makita task's (Makita ticket 05), set by the MCP door from its task
   * row: only `MAKITA_ALLOWED_TOOLS` are listed or callable.
   */
  readonly makita?: {
    readonly taskId: string;
    readonly configId: string;
    /** Ticket 10: its configuration may push branches, so `makita_push` is listed. */
    readonly push?: boolean;
    /** Ticket 13: its configuration may land, so `makita_request_merge` is listed. */
    readonly land?: boolean;
    /** Ticket 24: its configuration lists labels Makita may set, so `makita_label` is listed. */
    readonly label?: boolean;
    /** Ticket 26: its configuration may close issues, so `makita_close_issue` is listed. */
    readonly close?: boolean;
  };
}

/**
 * What the agent of a Makita Thread reaches (spec «Amenazas de prompt injection»): its own
 * `makita_*` tools, its own Thread's history and the background wait. Nothing that launches,
 * changes or reads other things of the Hub.
 */
export const MAKITA_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "makita_read_issue",
  "makita_comment",
  "makita_push",
  "makita_open_pull_request",
  "makita_ci_logs",
  "makita_request_merge",
  "makita_search",
  "makita_label",
  "makita_close_issue",
  "thread_history",
  "t3_background_wait",
]);

/**
 * Ticket 10: listed only when the Makita Thread's configuration may push branches; ticket 12 adds
 * its pull request and the CI logs.
 */
const MAKITA_PUSH_TOOLS: ReadonlySet<string> = new Set([
  "makita_push",
  "makita_open_pull_request",
  "makita_ci_logs",
]);

/** Ticket 13: listed only when the configuration may push and land. */
const MAKITA_LAND_TOOLS: ReadonlySet<string> = new Set(["makita_request_merge"]);

/** Ticket 24: listed only when the configuration lists labels Makita may set. */
const MAKITA_LABEL_TOOLS: ReadonlySet<string> = new Set(["makita_label"]);
/** Ticket 26: listed only when the configuration may close issues. */
const MAKITA_CLOSE_TOOLS: ReadonlySet<string> = new Set(["makita_close_issue"]);

/** Whether `tool` is listed and callable for this caller. */
export const toolAllowedFor = (scope: McpInvocationScope | undefined, tool: string): boolean =>
  scope?.makita === undefined
    ? !tool.startsWith("makita_")
    : MAKITA_ALLOWED_TOOLS.has(tool) &&
      (scope.makita.push === true || !MAKITA_PUSH_TOOLS.has(tool)) &&
      ((scope.makita.push === true && scope.makita.land === true) ||
        !MAKITA_LAND_TOOLS.has(tool)) &&
      (scope.makita.label === true || !MAKITA_LABEL_TOOLS.has(tool)) &&
      (scope.makita.close === true || !MAKITA_CLOSE_TOOLS.has(tool));

/**
 * T3 Code renders `t3-thread://` links as thread chips. Other MCP clients cannot open them, so
 * they get the Hub link Copy thread copies, which opens the thread in either app or a browser.
 */
export const threadLinkFor = (
  scope: Pick<McpInvocationScope, "environmentId" | "client">,
  threadId: ThreadId,
): string => {
  const hubOrigin = scope.client?.hubOrigin;
  const ref = { environmentId: scope.environmentId, threadId };
  return hubOrigin === undefined ? formatThreadLink(ref) : hostedThreadLink(ref, hubOrigin);
};

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/**
 * `McpSchema.EnabledWhen` for tools a delegated child must not see or call.
 * EnabledWhen only receives the MCP client profile, so read the T3 caller from the request fiber.
 */
export const hiddenFromSubagents = (): boolean => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, McpInvocationContext);
  return scope?.thread?.subagent !== true;
};

export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    ...(invocation.thread === undefined
      ? {}
      : {
          threadId: invocation.thread.threadId,
          providerSessionId: invocation.thread.providerSessionId,
          providerInstanceId: invocation.thread.providerInstanceId,
        }),
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation) => invocation.capabilities.has(capability),
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

export const requireThreadMcpCapability = <const C extends "preview" | "device">(
  capability: C,
): Effect.Effect<McpThreadInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation): invocation is McpThreadInvocationScope =>
        invocation.capabilities.has(capability) && invocation.thread !== undefined,
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

const threadCallerRequired = (operation: string) =>
  new OrchestratorMcpFailure({
    code: "thread_credential_required",
    message: `${operation} acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.`,
  });

export type McpThreadInvocationScope = McpInvocationScope & { readonly thread: McpThreadCaller };

export const requireThreadScope = (scope: McpInvocationScope, operation: string) =>
  scope.thread === undefined
    ? Effect.fail(threadCallerRequired(operation))
    : Effect.succeed(scope as McpThreadInvocationScope);
