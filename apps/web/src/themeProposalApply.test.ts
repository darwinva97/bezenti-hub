import { readThemeProposal } from "@t3tools/shared/themeProposal";
import { describe, expect, it } from "vite-plus/test";

import { themeColorsMinimumContrast } from "./themePalette";
import {
  THEME_PROPOSAL_MIN_TEXT_CONTRAST,
  themeProposalDefinition,
  themeProposalReadable,
  themeProposalThemeId,
} from "./themeProposalApply";

const hex = (value: number) => value.toString(16).padStart(2, "0");
const grey = (level: number) => `#${hex(level)}${hex(level)}${hex(level)}`;

// Accents around the hue wheel at three lightnesses.
// Greys from black to white, then tinted canvases of common themes and saturated extremes.
const CANVASES = [
  ...[
    0, 12, 24, 40, 48, 56, 60, 64, 70, 80, 96, 104, 112, 118, 124, 140, 145, 150, 155, 160, 170,
    200, 230, 245, 255,
  ].map(grey),
  "#0b0f0c",
  "#1a1b26",
  "#002b36",
  "#282a36",
  "#2e1a47",
  "#3b0a0a",
  "#0a1f3b",
  "#003300",
  "#fdf6e3",
  "#eff1f5",
  "#ffe4e1",
  "#e0f7fa",
  "#c8e6c9",
  "#9fb3ff",
  "#ffd54f",
  "#ff8a80",
];
const ACCENTS = [
  "#ff0000",
  "#ff8800",
  "#ffee00",
  "#33cc33",
  "#00bbaa",
  "#0088ff",
  "#5533ff",
  "#cc00cc",
  "#7a0000",
  "#7a4200",
  "#6b6b00",
  "#145214",
  "#005a52",
  "#003d7a",
  "#26137a",
  "#5c005c",
  "#ff9999",
  "#ffcc88",
  "#ffff99",
  "#99ff99",
  "#99fff0",
  "#99ccff",
  "#bba8ff",
  "#ff99ff",
  "#3ddc84",
  "#7aa2f7",
  "#e0af68",
  "#f7768e",
];

describe("the derived palette of a proposal", () => {
  it("keeps every text role at 4.5:1 for every pair the proposal rules accept", () => {
    const unreadable: Array<string> = [];
    let accepted = 0;
    for (const appearance of ["light", "dark"] as const) {
      for (const canvas of CANVASES) {
        for (const accent of ACCENTS) {
          const proposal = readThemeProposal({ name: "Probe", appearance, canvas, accent });
          if (proposal === undefined) continue;
          accepted += 1;
          const contrast = themeColorsMinimumContrast(themeProposalDefinition(proposal).colors);
          if (contrast < THEME_PROPOSAL_MIN_TEXT_CONTRAST) {
            unreadable.push(`${appearance} ${canvas} ${accent}: ${contrast.toFixed(2)}`);
          }
        }
      }
    }
    expect(accepted).toBeGreaterThan(200);
    expect(unreadable).toEqual([]);
  });

  it("calls a palette with text the color of its canvas unreadable", () => {
    const night = {
      name: "Night",
      appearance: "dark",
      canvas: "#0b0f0c",
      accent: "#3ddc84",
    } as const;
    expect(themeProposalReadable(night)).toBe(true);
    const colors = themeProposalDefinition(night).colors;
    expect(themeColorsMinimumContrast({ ...colors, text: colors.canvas })).toBeLessThan(1.1);
  });

  it("maps one proposal to one theme id, and another proposal to another", () => {
    const night = {
      name: "Night",
      appearance: "dark",
      canvas: "#0b0f0c",
      accent: "#3ddc84",
    } as const;
    expect(themeProposalThemeId(night)).toBe(themeProposalThemeId({ ...night }));
    expect(themeProposalThemeId(night)).not.toBe(
      themeProposalThemeId({ ...night, accent: "#3ddc85" }),
    );
    expect(themeProposalThemeId(night)).toMatch(/^agent-[0-9a-z]+$/);
  });
});
