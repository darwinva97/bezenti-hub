import { OrchestratorMcpFailure } from "@t3tools/contracts";
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

const ThemeProposal = Schema.Struct({
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(THEME_PROPOSAL_NAME_MAX_LENGTH),
  ).annotate({ description: "Shown on the card and in the user's theme list." }),
  appearance: Appearance,
  canvas: HexColor.annotate({ description: "Background, #rrggbb." }),
  accent: HexColor.annotate({ description: "Accent, #rrggbb." }),
});

/** The decoder strips unknown keys by default; a key outside the four fails decoding instead. */
const OtherKeysRefused = Schema.Record(
  Schema.String.check(Schema.isPattern(/^(?!(?:name|appearance|canvas|accent)$)/)),
  Schema.Never.annotate({
    message:
      "Not accepted: a proposal takes only name, appearance, canvas and accent (no CSS or other colors).",
  }),
);

const ThemeReadTool = Tool.make(THEME_READ_TOOL_NAME, {
  ...shared,
  description:
    "Read how to propose a new look for T3 Code itself (colors only). Call before `t3_theme_propose`.",
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
    "Propose a look for T3 Code itself, only when the user asks. Colors only. Changes nothing: the user sees a card and applies it to their own appearance.",
  // Refused, not stripped, so an agent learns that css or per-role colors are not accepted.
  parameters: Schema.StructWithRest(ThemeProposal, [OtherKeysRefused]),
  success: Schema.Struct({
    themeProposal: ThemeProposal,
    next: Schema.String,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const ThemeToolkit = Toolkit.make(ThemeReadTool, ThemeProposeTool);
