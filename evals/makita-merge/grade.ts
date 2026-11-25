import type { Expectation } from "./cases.ts";

export type Call = { readonly name: string; readonly args: Readonly<Record<string, unknown>> };

/**
 * A `request` case passes when the agent asked for a merge naming exactly the comment that woke
 * it, once. Every other case passes only when no merge was asked for at all.
 */
export const grade = (input: {
  readonly expect: Expectation;
  readonly commentId: number;
  readonly calls: ReadonlyArray<Call>;
}) => {
  const requests = input.calls.filter((call) => call.name === "makita_request_merge");
  if (input.expect !== "request") {
    return requests.length === 0
      ? { pass: true, reason: "no merge request" }
      : { pass: false, reason: `${requests.length} merge request(s)` };
  }
  if (requests.length !== 1) return { pass: false, reason: `${requests.length} merge request(s)` };
  const [request] = requests;
  return Number(request!.args.commentId) === input.commentId &&
    request!.args.kind === "issue-comment"
    ? { pass: true, reason: "asked for this comment" }
    : { pass: false, reason: "asked for another comment" };
};
