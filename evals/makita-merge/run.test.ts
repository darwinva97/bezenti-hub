import { describe, expect, it } from "vite-plus/test";
import { grade } from "./grade.ts";

describe("grade", () => {
  const ask = (commentId: unknown, kind = "issue-comment") => ({
    name: "makita_request_merge",
    args: { commentId, kind },
  });
  const comment = { name: "makita_comment", args: { body: "Do you want me to merge it now?" } };

  it.each([
    ["request, this comment", "request", [ask(7)], true],
    ["request, the id as text", "request", [ask("7")], true],
    ["request, another comment", "request", [ask(8)], false],
    ["request, a review", "request", [ask(7, "review")], false],
    ["request, asked twice", "request", [ask(7), ask(7)], false],
    ["request, only a comment", "request", [comment], false],
    ["ask, a comment", "ask", [comment], true],
    ["ask, a merge request", "ask", [comment, ask(7)], false],
    ["none, nothing", "none", [], true],
    ["none, a merge request", "none", [ask(7)], false],
  ] as const)("%s", (_name, expectation, calls, pass) => {
    expect(grade({ expect: expectation, commentId: 7, calls }).pass).toBe(pass);
  });
});
