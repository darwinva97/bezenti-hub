import {
  EventId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { themeProposalFromToolItem } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";

import * as ThemeProposalSeal from "../mcp/toolkits/theme/themeProposalSeal.ts";
import { projectDomainEventForWire, projectTurnItemForWire } from "./WireProjection.ts";

const NIGHT = {
  name: "Night Terminal",
  appearance: "dark",
  canvas: "#0b0f0c",
  accent: "#3ddc84",
} as const;
const CSS_META = { length: 120, sha256: "c".repeat(64) };
const PROPOSAL = { ...NIGHT, css: CSS_META };

const THREAD = ThreadId.make("thread-1");
const toolItem = (
  output: unknown,
  toolName = "mcp__t3-code__t3_theme_propose",
  threadId: ThreadId = THREAD,
) =>
  ({
    id: TurnItemId.make("theme-1"),
    type: "dynamic_tool",
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "t3_theme_propose",
    toolName,
    input: { ...NIGHT, css: "x" },
    output,
    startedAt: DateTime.makeUnsafe("2026-11-15T00:00:00.000Z"),
    completedAt: DateTime.makeUnsafe("2026-11-15T00:00:01.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-11-15T00:00:01.000Z"),
  }) as OrchestrationV2TurnItem;

const wireProposal = (item: OrchestrationV2TurnItem) => {
  const projected = projectTurnItemForWire(item);
  return projected.type === "dynamic_tool" ? themeProposalFromToolItem(projected) : undefined;
};

describe("theme proposal cards on the wire", () => {
  ThemeProposalSeal.installThemeProposalSealKey(new Uint8Array(32).fill(3));
  const seal = ThemeProposalSeal.sealThemeProposal(PROPOSAL, THREAD)!;

  it("keeps a proposal's CSS when the Hub sealed it, through every projection", () => {
    const item = toolItem({
      structuredContent: { themeProposal: PROPOSAL, themeProposalSeal: seal, next: "card" },
    });
    expect(wireProposal(item)).toEqual(PROPOSAL);
    // Projecting the projected item again keeps it: the seal travels with the compact output.
    expect(wireProposal(projectTurnItemForWire(item))).toEqual(PROPOSAL);
    const event = {
      type: "turn-item.updated",
      eventId: EventId.make("event-1"),
      payload: item,
    } as unknown as OrchestrationV2DomainEvent;
    const projected = projectDomainEventForWire(event);
    expect(
      projected.type === "turn-item.updated" && projected.payload.type === "dynamic_tool"
        ? themeProposalFromToolItem(projected.payload)
        : undefined,
    ).toEqual(PROPOSAL);
  });

  it("drops the CSS of a card no Hub sealed, whatever server or name it claims", () => {
    const otherCss = ThemeProposalSeal.sealThemeProposal(
      { ...NIGHT, css: { ...CSS_META, sha256: "d".repeat(64) } },
      THREAD,
    );
    for (const forged of [undefined, "x".repeat(43), otherCss, seal.slice(1) + "A"]) {
      for (const toolName of [
        "mcp__t3-code__t3_theme_propose",
        "t3_theme_propose",
        "t3-code.t3_theme_propose",
        "t3-code-thread_t3_theme_propose",
      ]) {
        const item = toolItem({ themeProposal: PROPOSAL, themeProposalSeal: forged }, toolName);
        expect(wireProposal(item)).toEqual(NIGHT);
      }
    }
  });

  it("drops the CSS of a sealed result replayed into another Thread", () => {
    const replayed = toolItem(
      { themeProposal: PROPOSAL, themeProposalSeal: seal },
      "mcp__t3-code__t3_theme_propose",
      ThreadId.make("thread-2"),
    );
    expect(wireProposal(replayed)).toEqual(NIGHT);
  });

  it("drops every CSS while the Hub has no key", () => {
    ThemeProposalSeal.installThemeProposalSealKey(null);
    try {
      expect(wireProposal(toolItem({ themeProposal: PROPOSAL, themeProposalSeal: seal }))).toEqual(
        NIGHT,
      );
    } finally {
      ThemeProposalSeal.installThemeProposalSealKey(new Uint8Array(32).fill(3));
    }
  });
});
