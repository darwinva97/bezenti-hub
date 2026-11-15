import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  THEME_PROPOSAL_GUIDE,
  readThemeProposal,
  themeProposalProblem,
} from "@t3tools/shared/themeProposal";
import { BUILT_IN_THEME_IDS } from "@t3tools/shared/themePalettes";
import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ThemeToolkit } from "./tools.ts";

/**
 * Nothing here writes: not the Hub's settings, not its themes folder, not any User's preferences.
 * A proposal is only the tool result; each viewer of the Thread applies it in their own browser.
 */
export const layer = McpToolAccess.toLayer(ThemeToolkit, {
  t3_theme_read: McpToolAccess.reads(() =>
    Effect.succeed({ builtIn: [...BUILT_IN_THEME_IDS], guide: THEME_PROPOSAL_GUIDE }),
  ),
  t3_theme_propose: McpToolAccess.actsAsCaller((params) =>
    Effect.gen(function* () {
      const candidate = {
        name: params.name.trim(),
        appearance: params.appearance,
        canvas: params.canvas.toLowerCase(),
        accent: params.accent.toLowerCase(),
      };
      const problem = themeProposalProblem(candidate);
      const themeProposal = problem === null ? readThemeProposal(candidate) : undefined;
      if (themeProposal === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: problem ?? "Give a name of 1 to 48 characters.",
        });
      }
      return {
        themeProposal,
        next: "Shown to the user as a card in this thread. Nothing changed yet: they apply it to their own appearance, and can undo it there.",
      };
    }),
  ),
});
