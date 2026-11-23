import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  accessKeyAllowsAllModels,
  accessKeyModelAllowed,
  accessKeyModelEntryValid,
  AccessKeyModels,
} from "./accessKeys.ts";

describe("accessKeyModelAllowed", () => {
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>, string, boolean]> = [
    ["an exact name admits itself", ["claude-sonnet-5-5"], "claude-sonnet-5-5", true],
    ["without case", ["Claude-Sonnet-5-5"], "CLAUDE-sonnet-5-5", true],
    [
      "an exact name admits no dated version",
      ["claude-sonnet-5-5"],
      "claude-sonnet-5-5-20261001",
      false,
    ],
    [
      "a pattern admits a dated version",
      ["claude-sonnet-5-5*"],
      "claude-sonnet-5-5-20261001",
      true,
    ],
    ["a pattern admits its family", ["claude-sonnet-*"], "claude-sonnet-5-5", true],
    ["a pattern refuses another family", ["claude-sonnet-*"], "claude-opus-5-5", false],
    [
      "an account prefix is not compared",
      ["claude-sonnet-*"],
      "acct-abc123/claude-sonnet-5-5",
      true,
    ],
    ["nor is a pinned refused one", ["claude-sonnet-*"], "acct-abc123/claude-opus-5-5", false],
    ["a [1m] suffix is not compared", ["claude-sonnet-5-5"], "claude-sonnet-5-5[1m]", true],
    ["«All models» admits anything", ["*"], "gpt-5.5", true],
    ["any of several entries", ["gpt-5.5", "claude-haiku-*"], "claude-haiku-5", true],
    ["a `*` in the middle admits nothing", ["claude-*-5-5"], "claude-sonnet-5-5", false],
    ["two `*` admit nothing", ["claude**"], "claude-sonnet-5-5", false],
    ["an entry with a space admits nothing", ["claude sonnet"], "claude sonnet", false],
    ["an empty entry admits nothing", [""], "", false],
    ["an empty list admits nothing", [], "claude-sonnet-5-5", false],
  ];
  it.each(cases)("%s", (_name, entries, requested, allowed) => {
    expect(accessKeyModelAllowed(entries, requested)).toBe(allowed);
  });

  it("tells «All models» apart", () => {
    expect(accessKeyAllowsAllModels(["*"])).toBe(true);
    expect(accessKeyAllowsAllModels(["claude-*"])).toBe(false);
  });
});

describe("AccessKeyModels", () => {
  const decode = Schema.decodeUnknownOption(AccessKeyModels);
  it("takes 1 to 50 well-formed entries", () => {
    expect(decode(["*"])._tag).toBe("Some");
    expect(decode(["claude-sonnet-*", "gpt-5.5"])._tag).toBe("Some");
    expect(decode([])._tag).toBe("None");
    expect(decode(Array.from({ length: 51 }, (_, index) => `m-${index}`))._tag).toBe("None");
    expect(decode(["claude-*-5"])._tag).toBe("None");
    expect(decode(["a b"])._tag).toBe("None");
    expect(decode(["x".repeat(257)])._tag).toBe("None");
  });

  it("validates one entry the same way", () => {
    expect(accessKeyModelEntryValid("gemini-3-*")).toBe(true);
    expect(accessKeyModelEntryValid("*")).toBe(true);
    expect(accessKeyModelEntryValid("**")).toBe(false);
    expect(accessKeyModelEntryValid("a\tb")).toBe(false);
  });
});
