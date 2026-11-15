import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { THEME_CSS_MAX_LENGTH } from "@t3tools/shared/themeCss";
import {
  THEME_PROPOSAL_HEX_PATTERN,
  THEME_PROPOSAL_NAME_MAX_LENGTH,
  THEME_PROPOSE_TOOL_NAME,
  THEME_READ_TOOL_NAME,
} from "@t3tools/shared/themeProposal";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const HexColor = Schema.String.check(Schema.isPattern(THEME_PROPOSAL_HEX_PATTERN));
const Appearance = Schema.Literals(["light", "dark"]);

const colorFields = {
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(THEME_PROPOSAL_NAME_MAX_LENGTH),
  ).annotate({ description: "Shown on the card and in the user's theme list." }),
  appearance: Appearance,
  canvas: HexColor.annotate({ description: "Background, #rrggbb." }),
  accent: HexColor.annotate({ description: "Accent, #rrggbb." }),
};

const ThemeProposalParams = Schema.Struct({
  ...colorFields,
  // Length and content are checked by the handler, so a refusal says what to change.
  css: Schema.optionalKey(
    Schema.String.annotate({
      description: `Optional CSS applied after the app's styles, at most ${THEME_CSS_MAX_LENGTH} characters. It cannot load anything: see t3_theme_read.`,
    }),
  ),
});

/** What the card gets: the CSS by size and SHA-256 only; the CSS stays in this call's input. */
const ThemeProposalResult = Schema.Struct({
  ...colorFields,
  css: Schema.optionalKey(Schema.Struct({ length: Schema.Number, sha256: Schema.String })),
});

/** The decoder strips unknown keys by default; a key outside these fails decoding instead. */
const OtherKeysRefused = Schema.Record(
  Schema.String.check(Schema.isPattern(/^(?!(?:name|appearance|canvas|accent|css)$)/)),
  Schema.Never.annotate({
    message:
      "Not accepted: a proposal takes only name, appearance, canvas, accent and css (no other colors).",
  }),
);

const ThemeReadTool = Tool.make(THEME_READ_TOOL_NAME, {
  ...shared,
  description:
    "Read how to propose a new look for T3 Code itself: colors, and the rules and selectors for CSS. Call before `t3_theme_propose`.",
  success: Schema.Struct({
    builtIn: Schema.Array(Schema.String),
    guide: Schema.String,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThemeProposeTool = Tool.make(THEME_PROPOSE_TOOL_NAME, {
  ...shared,
  description:
    "Propose a look for T3 Code itself, only when the user asks: colors, and optional CSS. Changes nothing: the user sees a card and applies it to their own appearance.",
  // Refused, not stripped, so an agent learns that per-role colors are not accepted.
  parameters: Schema.StructWithRest(ThemeProposalParams, [OtherKeysRefused]),
  success: Schema.Struct({
    themeProposal: ThemeProposalResult,
    themeProposalSeal: Schema.optionalKey(Schema.String),
    next: Schema.String,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const ThemeToolkit = Toolkit.make(ThemeReadTool, ThemeProposeTool);
