/**
 * Makita ticket 09: what in a comment speaks to Makita. A mention is `@login` as a whole word
 * outside a quote; a command is a first line that is exactly `/makita stop` or `/makita retry`.
 */
import { assert, it } from "@effect/vitest";

import { commandOf, mentions } from "./makitaFeeds.ts";

it("finds a mention only as a whole word, any case, outside quoted lines", () => {
  for (const body of [
    "@makita-bot look",
    "hey @Makita-Bot, look",
    "(@makita-bot)",
    "first line\n@makita-bot: second",
  ]) {
    assert.isTrue(mentions(body, "makita-bot"), body);
  }
  for (const body of [
    "makita-bot look",
    "@makita-bot-two look",
    "mail me at someone@makita-bot",
    "> @makita-bot said this before",
    "see github.com/@makita-bot",
  ]) {
    assert.isFalse(mentions(body, "makita-bot"), body);
  }
  assert.isFalse(mentions("@makita-bot", ""));
});

it("reads a command only from an exact first line", () => {
  assert.equal(commandOf("/makita stop"), "stop");
  assert.equal(commandOf("  /MAKITA Stop  \nthanks"), "stop");
  assert.equal(commandOf("/makita retry"), "retry");
  for (const body of ["please /makita stop", "/makita stop now", "hi\n/makita stop", "/makita"]) {
    assert.isUndefined(commandOf(body), body);
  }
});
