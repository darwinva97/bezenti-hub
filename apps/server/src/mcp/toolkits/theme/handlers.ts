// @effect-diagnostics-next-line nodeBuiltinImport:off -- one digest of a string already in memory.
import * as NodeCrypto from "node:crypto";

import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { themeCssProblem } from "@t3tools/shared/themeCss";
import {
  THEME_PROPOSAL_GUIDE,
  readThemeProposal,
  themeProposalProblem,
} from "@t3tools/shared/themeProposal";
import { BUILT_IN_THEME_IDS } from "@t3tools/shared/themePalettes";
import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { sealThemeProposal } from "./themeProposalSeal.ts";
import { ThemeToolkit } from "./tools.ts";

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * Nothing here writes: not the Hub's settings, not its themes folder, not any User's preferences.
 * A proposal is only the tool result; each viewer of the Thread applies it in their own browser.
 * CSS is checked here and again in the browser before Preview or Apply. The result carries only
 * its size and digest, sealed by the Hub: the CSS itself stays in this call's input.
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
      const colors = problem === null ? readThemeProposal(candidate) : undefined;
      if (colors === undefined) {
        return yield* refuse(problem ?? "Give a name of 1 to 48 characters.");
      }
      if (params.css === undefined) {
        return {
          themeProposal: colors,
          next: "Shown to the user as a card in this thread. Nothing changed yet: they apply it to their own appearance, and can undo it there.",
        };
      }
      const cssProblem = themeCssProblem(params.css);
      if (cssProblem !== null) return yield* refuse(`CSS not accepted. ${cssProblem}`);
      const themeProposal = {
        ...colors,
        css: {
          length: params.css.length,
          sha256: NodeCrypto.createHash("sha256").update(params.css, "utf8").digest("hex"),
        },
      };
      const themeProposalSeal = sealThemeProposal(themeProposal);
      if (themeProposalSeal === null) {
        return yield* refuse(
          "This server cannot take CSS in a proposal right now. Propose colors only.",
        );
      }
      return {
        themeProposal,
        themeProposalSeal,
        next: "Shown to the user as a card in this thread, marked as carrying custom CSS. Nothing changed yet: they apply it to their own appearance, and can undo it there.",
      };
    }),
  ),
});
