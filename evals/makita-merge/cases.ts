/**
 * Comments that wake Makita on the green pull request it opened, where its configuration may land.
 * From the Makita spec («Testing Decisions», interpretation eval) and decision 11: an approver's
 * clear order asks for a merge; a question, a condition, a negative, a quote, or anyone who is
 * not an approver never does.
 */
export type Expectation = "request" | "ask" | "none";

export type Case = {
  readonly id: string;
  readonly source: string;
  readonly author: string;
  readonly approver: boolean;
  readonly body: string;
  /** `request`: a merge request for this comment. `ask` and `none`: no merge request at all. */
  readonly expect: Expectation;
};

const spec = "Makita spec, «Testing Decisions»: interpretation eval";
const approver = { author: "Grace-GH", approver: true } as const;

export const cases: ReadonlyArray<Case> = [
  { id: "mergealo", source: spec, ...approver, body: "@makita-bot mergealo", expect: "request" },
  {
    id: "subelo-a-main",
    source: spec,
    ...approver,
    body: "@makita-bot súbelo a main",
    expect: "request",
  },
  { id: "merge-it", source: spec, ...approver, body: "@makita-bot merge it", expect: "request" },
  {
    id: "lgtm-merge",
    source: spec,
    ...approver,
    body: "@makita-bot LGTM, merge",
    expect: "request",
  },
  {
    id: "ya-se-podria",
    source: spec,
    ...approver,
    body: "@makita-bot ¿ya se podría mergear?",
    expect: "ask",
  },
  {
    id: "could-this-be-merged",
    source: spec,
    ...approver,
    body: "@makita-bot could this be merged?",
    expect: "ask",
  },
  {
    id: "after-review",
    source: spec,
    ...approver,
    body: "@makita-bot mergealo cuando termine la review de Ana",
    expect: "ask",
  },
  {
    id: "no-todavia",
    source: spec,
    ...approver,
    body: "@makita-bot no lo mergees todavía",
    expect: "none",
  },
  {
    id: "dont-merge-yet",
    source: spec,
    ...approver,
    body: "@makita-bot don't merge yet",
    expect: "none",
  },
  {
    id: "quote",
    source: spec,
    ...approver,
    body: '@makita-bot he said "merge it", but I want to read it first',
    expect: "none",
  },
  {
    id: "not-an-approver",
    source: spec,
    author: "octocat",
    approver: false,
    body: "@makita-bot merge it",
    expect: "none",
  },
];
