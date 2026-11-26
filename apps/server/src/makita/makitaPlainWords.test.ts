/**
 * Makita ticket 29: a comment in plain words is an order only when, without the mention, the
 * punctuation, emoji, accents and politeness, it is exactly one phrase of a short closed list.
 */
import { assert, it } from "@effect/vitest";

import { PLAIN_PHRASES, type PlainIntent, plainIntentOf } from "./makitaPlainWords.ts";

const LOGIN = "makita-bot";
const onIssue = (body: string) => plainIntentOf(body, { login: LOGIN, addressed: "mention" });
const onPull = (body: string) => plainIntentOf(body, { login: LOGIN, addressed: "pull" });

it("reads each intent in Spanish and English, any case, accents or none, with a mention at either end", () => {
  const cases: ReadonlyArray<readonly [string, PlainIntent]> = [
    ["@makita-bot para", "stop"],
    ["@Makita-Bot ¡PARA!", "stop"],
    ["para @makita-bot", "stop"],
    ["@makita-bot detente, por favor 🙏", "stop"],
    ["@makita-bot déjalo", "stop"],
    ["@makita-bot dejalo", "stop"],
    ["@makita-bot ya no", "stop"],
    ["@makita-bot Stop.", "stop"],
    ["@makita-bot stop now, thanks", "stop"],
    ["hey @makita-bot, cancel that!!", "stop"],
    ["@makita-bot abort 🛑", "stop"],
    ["@makita-bot reinténtalo", "retry"],
    ["@makita-bot inténtalo de nuevo", "retry"],
    ["@makita-bot try again please", "retry"],
    ["@makita-bot Retry!", "retry"],
    ["@makita-bot reábrelo", "reopen"],
    ["@makita-bot reopen it, please", "reopen"],
    ["@makita-bot dale", "approve"],
    ["@makita-bot OK", "approve"],
    ["@makita-bot ok 👍", "approve"],
    ["@makita-bot aprobado.", "approve"],
    ["@makita-bot súbelo", "approve"],
    ["LGTM @makita-bot", "approve"],
    ["@makita-bot go ahead", "approve"],
    ["@makita-bot mergéalo", "merge"],
    ["@makita-bot mergealo", "merge"],
    ["@makita-bot fusiónalo, gracias", "merge"],
    ["@makita-bot Merge it.", "merge"],
    ["@makita-bot\n\nmerge", "merge"],
  ];
  for (const [body, intent] of cases) {
    assert.equal(onIssue(body), intent, body);
  }
});

it("on Makita's own pull request no mention is needed", () => {
  assert.equal(onPull("para"), "stop");
  assert.equal(onPull("Stop!"), "stop");
  assert.equal(onPull("Merge it, thanks."), "merge");
  assert.equal(onPull("lgtm"), "approve");
  assert.equal(onPull("Makita, para"), "stop");
  assert.equal(onPull("@makita-bot para"), "stop");
});

it("on an issue a phrase without a mention says nothing to Makita", () => {
  for (const body of [
    "para",
    "stop",
    "ok",
    "merge it",
    "makita stop",
    "@makita-bot-two stop",
    "`@makita-bot ok`",
  ]) {
    assert.isUndefined(onIssue(body), body);
  }
});

it("a longer sentence that merely contains a listed word is not an order", () => {
  for (const body of [
    "@makita-bot no pares hasta que pase CI",
    "@makita-bot stop using tabs",
    "@makita-bot para qué sirve esto?",
    "@makita-bot ok, but also fix the signup",
    "@makita-bot could this be merged?",
    "@makita-bot ¿ya se podría mergear?",
    "@makita-bot don't merge yet",
    "@makita-bot no lo mergees todavía",
    "@makita-bot merge once CI passes",
    "@makita-bot try again tomorrow with the new key",
    "@makita-bot approved, push it",
    "@makita-bot",
    "@makita-bot 👍",
    "@makita-bot ...",
  ]) {
    assert.isUndefined(onIssue(body), body);
  }
});

it("quoted lines are ignored, and a comment that also speaks to someone else is not an order", () => {
  assert.isUndefined(onIssue("> @makita-bot stop"));
  assert.isUndefined(onIssue("> @makita-bot stop\n\nnot yet"));
  assert.isUndefined(onPull("> merge it"));
  assert.equal(onIssue("> some context\n@makita-bot stop"), "stop");
  assert.isUndefined(onIssue("@makita-bot @alice stop"));
  assert.isUndefined(onPull("@alice merge it"));
  assert.isUndefined(onPull("/makita stop"));
  // A command not on the first line is no command, and not words either.
  assert.isUndefined(onPull("Thanks!\n/makita merge"));
  assert.isUndefined(onIssue("@makita-bot thanks\n/makita stop"));
});

it("each phrase is written as it is matched and belongs to one list only", () => {
  const seen = new Map<string, PlainIntent>();
  for (const [intent, phrases] of Object.entries(PLAIN_PHRASES) as ReadonlyArray<
    readonly [PlainIntent, ReadonlyArray<string>]
  >) {
    for (const phrase of phrases) {
      assert.match(phrase, /^[a-z0-9]+(?: [a-z0-9]+)*$/u, phrase);
      assert.isUndefined(seen.get(phrase), `${phrase} is in ${seen.get(phrase)} and ${intent}`);
      seen.set(phrase, intent);
      assert.equal(onPull(phrase), intent, phrase);
    }
  }
  for (const left of ["si", "yes", "hazlo", "do it", "ship it", "never mind"]) {
    assert.isFalse(seen.has(left), left);
  }
});
