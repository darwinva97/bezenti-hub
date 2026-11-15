import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { THEME_PROPOSAL_GUIDE } from "@t3tools/shared/themeProposal";
import type * as AiError from "effect/ai/AiError";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { EnvironmentThemeService } from "../../../environmentTheme.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThemeHandlers from "./handlers.ts";
import { ThemeToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:theme");
const threadId = ThreadId.make("thread:theme");
const NIGHT = {
  name: "Night Terminal",
  appearance: "dark",
  canvas: "#0b0f0c",
  accent: "#3ddc84",
} as const;

const threadScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:theme",
  thread: {
    threadId,
    providerSessionId: "provider:theme",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

type ThemeToolName = "t3_theme_read" | "t3_theme_propose";
/** What the theme tools declare they need from each call. */
type CallServices =
  | McpInvocationContext.McpInvocationContext
  | ThreadManagement.ThreadManagementService;
type Call = (
  name: ThemeToolName,
  params: unknown,
) => Effect.Effect<unknown, AiError.AiError, CallServices>;

/** Runs the toolkit with Hub services that count any write: a proposal must make none. */
const withToolkit = <A, E>(
  scope: McpInvocationContext.McpInvocationScope,
  use: (call: Call) => Effect.Effect<A, E, CallServices>,
) =>
  Effect.gen(function* () {
    const writes = yield* Ref.make(0);
    const write = () =>
      Ref.update(writes, (count) => count + 1).pipe(Effect.andThen(Effect.die("wrote")));
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
      }),
      Layer.mock(Settings.ServerSettingsService)({ updateSettings: write }),
      Layer.mock(EnvironmentThemeService)({ current: write() }),
    );
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* ThemeToolkit;
      // Raw parameters on purpose: the cases include keys and values the schema must refuse.
      const call: Call = (name, params) =>
        toolkit.handle(name, params as never).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts): unknown => Array.from(parts).at(-1)?.result),
        );
      return yield* use(call);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ThemeHandlers.layer).pipe(
          Layer.provideMerge(dependencies),
        ),
      ),
    );
    expect(yield* Ref.get(writes)).toBe(0);
    return result;
  });

/**
 * How the toolkit refused a call: its parameters failed to decode (an error part, or a failed
 * effect) or the handler said no (a failure with a code). Undefined when it returned a proposal.
 */
const refusal = (effect: Effect.Effect<unknown, AiError.AiError, CallServices>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (Exit.isFailure(exit)) return "failed";
    const value = exit.value;
    if (typeof value === "object" && value !== null && "themeProposal" in value) return undefined;
    return typeof value === "object" && value !== null && "code" in value
      ? (value as { code: string; message: string })
      : "not decoded";
  });

it.effect("returns a proposal for colors and writes nothing on the Hub", () =>
  withToolkit(threadScope, (call) =>
    Effect.gen(function* () {
      const result = yield* call("t3_theme_propose", {
        ...NIGHT,
        name: " Night Terminal ",
        accent: "#3DDC84",
      });
      expect(result).toMatchObject({ themeProposal: NIGHT });
      expect((result as { next: string }).next).toContain("card");
    }),
  ),
);

it.effect("refuses CSS, per-role colors, unknown keys and anything but #rrggbb", () =>
  withToolkit(threadScope, (call) =>
    Effect.gen(function* () {
      for (const params of [
        { ...NIGHT, css: "[data-approval] { display: none }" },
        { ...NIGHT, colors: { text: "#0b0f0c" } },
        { ...NIGHT, variants: { light: { canvas: "#ffffff" } } },
        { ...NIGHT, canvas: "url(https://example.com/a)" },
        { ...NIGHT, accent: "green" },
        { ...NIGHT, appearance: "system" },
      ]) {
        expect(yield* refusal(call("t3_theme_propose", params))).toBeDefined();
      }
    }),
  ),
);

it.effect("refuses a hard-to-read pair and says why", () =>
  withToolkit(threadScope, (call) =>
    Effect.gen(function* () {
      expect(
        yield* refusal(call("t3_theme_propose", { ...NIGHT, canvas: "#f4f4f4" })),
      ).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("too light"),
      });
      expect(
        yield* refusal(call("t3_theme_propose", { ...NIGHT, accent: "#151a16" })),
      ).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("contrast"),
      });
    }),
  ),
);

it.effect("refuses a caller that is not an agent's own Thread", () =>
  withToolkit({ ...threadScope, thread: undefined }, (call) =>
    Effect.gen(function* () {
      expect(yield* refusal(call("t3_theme_propose", NIGHT))).toBeDefined();
    }),
  ),
);

it.effect("reads the colors-only guide and the built-in themes", () =>
  withToolkit(threadScope, (call) =>
    Effect.gen(function* () {
      expect(yield* call("t3_theme_read", {})).toEqual({
        builtIn: ["t3-chat", "grove", "ocean", "ember", "iris"],
        guide: THEME_PROPOSAL_GUIDE,
      });
    }),
  ),
);
