import { describe, expect, it } from "vite-plus/test";

import {
  readThemeProposal,
  themeProposalProblem,
  themeProposalsEqual,
  type ThemeProposal,
} from "./themeProposal.ts";
import { compactDynamicToolOutput, themeProposalFromToolItem } from "./toolOutput.ts";

const NIGHT: ThemeProposal = {
  name: "Night Terminal",
  appearance: "dark",
  canvas: "#0b0f0c",
  accent: "#3ddc84",
};

describe("theme proposals", () => {
  it("reads a proposal, normalizing name and hex case and dropping unknown fields", () => {
    expect(
      readThemeProposal({
        ...NIGHT,
        name: "  Night Terminal ",
        accent: "#3DDC84",
        css: "body { display: none }",
        colors: { text: "#000000" },
      }),
    ).toEqual(NIGHT);
  });

  it.each([
    ["no name", { ...NIGHT, name: "   " }],
    ["a long name", { ...NIGHT, name: "x".repeat(49) }],
    ["a short hex", { ...NIGHT, canvas: "#000" }],
    ["a named color", { ...NIGHT, accent: "green" }],
    ["a css function", { ...NIGHT, canvas: "url(https://example.com/a)" }],
    ["another appearance", { ...NIGHT, appearance: "system" }],
    ["a light canvas for dark", { ...NIGHT, canvas: "#f5f5f5" }],
    ["a dark canvas for light", { ...NIGHT, appearance: "light" }],
    ["an accent that vanishes on the canvas", { ...NIGHT, accent: "#151a16" }],
  ])("refuses %s", (_case, value) => {
    expect(readThemeProposal(value)).toBeUndefined();
  });

  it("says why a proposal is hard to read", () => {
    expect(themeProposalProblem(NIGHT)).toBeNull();
    expect(themeProposalProblem({ ...NIGHT, canvas: "#ffffff" })).toContain("too light");
    expect(themeProposalProblem({ ...NIGHT, accent: "#1a1f1b" })).toContain("contrast");
  });

  it("compares proposals by value", () => {
    expect(themeProposalsEqual(NIGHT, { ...NIGHT })).toBe(true);
    expect(themeProposalsEqual(NIGHT, { ...NIGHT, accent: "#3ddc85" })).toBe(false);
  });

  it("reads a proposal's CSS size and digest, and drops a malformed one to colors only", () => {
    const css = { length: 120, sha256: "a".repeat(64) };
    expect(readThemeProposal({ ...NIGHT, css })).toEqual({ ...NIGHT, css });
    for (const bad of [
      { length: 0, sha256: "a".repeat(64) },
      { length: 50_001, sha256: "a".repeat(64) },
      { length: 1.5, sha256: "a".repeat(64) },
      { length: 120, sha256: "A".repeat(64) },
      { length: 120, sha256: "a".repeat(63) },
      "body { display: none }",
    ]) {
      expect(readThemeProposal({ ...NIGHT, css: bad })).toEqual(NIGHT);
    }
    expect(themeProposalsEqual({ ...NIGHT, css }, NIGHT)).toBe(false);
    expect(themeProposalsEqual({ ...NIGHT, css }, { ...NIGHT, css: { ...css } })).toBe(true);
  });

  it("keeps the Hub's seal next to a proposal in the compacted output, and nothing else", () => {
    const css = { length: 120, sha256: "b".repeat(64) };
    const seal = "s".repeat(43);
    const compacted = compactDynamicToolOutput({
      structuredContent: { themeProposal: { ...NIGHT, css }, themeProposalSeal: seal, next: "x" },
    });
    expect(compacted).toEqual({ themeProposal: { ...NIGHT, css }, themeProposalSeal: seal });
    expect(
      compactDynamicToolOutput({ themeProposal: NIGHT, themeProposalSeal: "not a seal" }),
    ).toEqual({ themeProposal: NIGHT });
    expect(compactDynamicToolOutput({ themeProposalSeal: seal })).toBeUndefined();
  });

  it("keeps a proposal through the compacted tool output, only for t3_theme_propose", () => {
    const output = { structuredContent: { themeProposal: NIGHT, next: "shown as a card" } };
    expect(compactDynamicToolOutput(output)?.themeProposal).toEqual(NIGHT);
    const compacted = compactDynamicToolOutput(output);
    expect(themeProposalFromToolItem({ toolName: "t3_theme_propose", output: compacted })).toEqual(
      NIGHT,
    );
    expect(
      themeProposalFromToolItem({ toolName: "mcp__t3-code__t3_theme_propose", output }),
    ).toEqual(NIGHT);
    expect(themeProposalFromToolItem({ toolName: "other_tool", output })).toBeUndefined();
    expect(
      themeProposalFromToolItem({
        toolName: "t3_theme_propose",
        output: { ...output, isError: true },
      }),
    ).toBeUndefined();
  });
});
