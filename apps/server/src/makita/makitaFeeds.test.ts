/**
 * Makita ticket 09: what in a comment speaks to Makita. A mention is `@login` as a whole word
 * outside a quote; a command is a first line that is exactly `/makita stop` or `/makita retry`.
 */
import { assert, it } from "@effect/vitest";

import { decideConversation } from "./makitaConversation.ts";
import { commandOf, decideComment, type FeedComment, mentions } from "./makitaFeeds.ts";

const MAKITA = { id: 99, login: "makita-bot" };
const CONFIG = {
  configId: "mk_a",
  callerIds: new Set([1]),
  ignore: new Set(["other-bot"]),
  active: true,
  mention: true,
};
const AT = "2026-11-26T10:00:00Z";
const commentOf = (
  body: string,
  over: { readonly author?: FeedComment["author"]; readonly edited?: boolean } = {},
): FeedComment => ({
  eventKey: "gh:issue-comment:500",
  id: 500,
  number: 12,
  kind: "issue",
  body,
  author: over.author === undefined ? { login: "octocat", id: 1 } : over.author,
  createdAt: AT,
  updatedAt: over.edited === true ? "2026-11-26T10:05:00Z" : AT,
});
const onIssue = (
  body: string,
  tasks: { readonly live: string | null; readonly failed: string | null },
  over?: Parameters<typeof commentOf>[1],
) => decideComment({ comment: commentOf(body, over), configs: [CONFIG], makita: MAKITA, tasks });
const outcomeOf = (decision: ReturnType<typeof decideComment>) =>
  decision === undefined ? undefined : [decision.outcome, decision.detail];

it("Makita ticket 29: a stop or retry in plain words on an issue is the command, under its rules", () => {
  const live = { live: "mk_a", failed: null };
  const none = { live: null, failed: null };
  const failed = { live: null, failed: "mk_a" };
  const cases: ReadonlyArray<
    readonly [string, Parameters<typeof onIssue>[1], ReturnType<typeof outcomeOf>]
  > = [
    ["@makita-bot para", live, ["queued", "stop"]],
    ["¡Detente! @makita-bot", live, ["queued", "stop"]],
    ["@makita-bot stop", none, ["command", "nothing-to-stop"]],
    // A longer sentence is conversation, as any mention.
    ["@makita-bot stop using tabs", live, ["queued", "mention"]],
    ["@makita-bot no pares hasta que pase CI", live, ["queued", "mention"]],
    // Not addressed to Makita: nothing at all.
    ["para", live, undefined],
    ["> @makita-bot para", live, undefined],
    // A retry only where the newest task failed; elsewhere it is the plain mention it was.
    ["@makita-bot reinténtalo", failed, ["queued", "retry"]],
    ["@makita-bot try again", live, ["queued", "mention"]],
    ["@makita-bot try again", none, ["queued", "mention"]],
  ];
  for (const [body, tasks, expected] of cases) {
    assert.deepEqual(outcomeOf(onIssue(body, tasks)), expected, body);
  }
  // Strangers, bots, Makita itself and edits: as for the commands.
  assert.deepEqual(
    outcomeOf(onIssue("@makita-bot para", live, { author: { login: "mallory", id: 2 } })),
    ["ignored-not-allowed", null],
  );
  assert.deepEqual(
    outcomeOf(
      onIssue("@makita-bot para", live, { author: { login: "dependabot", id: 3, type: "Bot" } }),
    ),
    ["ignored-bot", null],
  );
  assert.deepEqual(
    outcomeOf(onIssue("@makita-bot para", live, { author: { login: "other-bot", id: 4 } })),
    ["ignored-bot", null],
  );
  assert.deepEqual(
    outcomeOf(onIssue("@makita-bot para", live, { author: { login: "makita-bot", id: 99 } })),
    ["ignored-self", null],
  );
  assert.deepEqual(outcomeOf(onIssue("@makita-bot para", live, { edited: true })), [
    "ignored-edited",
    null,
  ]);
});

it("Makita ticket 29: on Makita's own pull request «para» stops without a mention; longer words are conversation", () => {
  const onPull = (body: string, author: FeedComment["author"] = { login: "octocat", id: 1 }) =>
    outcomeOf(
      decideConversation({
        comment: { ...commentOf(body, { author }), number: 77, kind: "pull" },
        config: CONFIG,
        makita: MAKITA,
      }),
    );
  assert.deepEqual(onPull("Para."), ["queued", "stop"]);
  assert.deepEqual(onPull("stop it, thanks"), ["queued", "stop"]);
  assert.deepEqual(onPull("stop using tabs"), ["queued", "conversation"]);
  assert.deepEqual(onPull("try again"), ["queued", "conversation"]);
  assert.deepEqual(onPull("para", { login: "mallory", id: 2 }), ["ignored-not-allowed", null]);
  assert.isUndefined(onPull("para", { login: "makita-bot", id: 99 }));
});

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
    // Ticket 29: inline code is not a mention on GitHub, nor here.
    "An approver can reply `@makita-bot ok` (or `/makita ok`) to send it.",
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
