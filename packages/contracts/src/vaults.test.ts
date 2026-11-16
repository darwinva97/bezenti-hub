import { describe, expect, it } from "vite-plus/test";

import { looksLikeCredential } from "./vaults.ts";
import {
  parseTemplate,
  previewTemplate,
  renderTemplate,
  templateNames,
  templatePathNames,
} from "./vaultTemplates.ts";

describe("looksLikeCredential", () => {
  it.each([
    ["GITHUB_TOKEN", "abc"],
    ["DB_PASSWORD", undefined],
    ["APP_SECRET", "x"],
    ["SIGNING_KEY", "x"],
    ["GITLAB_PAT", "x"],
    ["SOMETHING", "ghp_0123456789abcdefghij"],
    ["SOMETHING", "github_pat_11ABCDEF"],
    ["SOMETHING", "glpat-abcdef"],
    ["SOMETHING", "sk-proj-abc"],
    ["SOMETHING", "xoxb-1234"],
    ["SOMETHING", "AKIAIOSFODNN7EXAMPLE"],
    ["SOMETHING", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc"],
    ["SOMETHING", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl"],
    ["SOMETHING", "q8Zr2LmX9vT4bN7kW1pY6cJ3"],
  ])("warns for %s = %s", (name, value) => {
    expect(looksLikeCredential(name, value)).toBe(true);
  });

  it.each([
    ["AWS_REGION", "eu-west-1"],
    ["KUBE_SERVER", "https://k3s.example.internal:6443/some/long/path?x=1"],
    ["CLUSTER_NAME", "production-cluster-europe"],
    ["KEYBOARD_LAYOUT", "es"],
    ["GREETING", "hello world, this is long enough text"],
    ["TOKENS_PER_MINUTE", "1000"],
    ["PORT", undefined],
    ["BUILD_ID", "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ])("does not warn for %s = %s", (name, value) => {
    expect(looksLikeCredential(name, value)).toBe(false);
  });
});

describe("Template entries", () => {
  const parsed = (text: string) => {
    const result = parseTemplate(text);
    if (result._tag !== "parsed") throw new Error(result.message);
    return result.parts;
  };

  it.each([
    ["{{ KUBE_SERVER", "never closed"],
    ["{{ kube_server }}", "does not name an entry"],
    ["{{ OTHER.VAULT }}", "does not name an entry"],
    ["{{ TOKEN | upper }}", "is not a filter"],
    ["{{ TOKEN | trim | path }}", "takes no other filter"],
    ["{{ if TOKEN }}", "does not name an entry"],
  ])("refuses %s", (text, message) => {
    const result = parseTemplate(text);
    expect(result._tag).toBe("invalid");
    expect(result._tag === "invalid" ? result.message : "").toContain(message);
  });

  it('renders each filter, `{{"{{"}}` as a literal and previews names only', () => {
    const parts = parsed(
      'u={{ USER }} p={{ PASS | urlencode }} b={{ PASS | base64 }} d={{ ENC | base64decode | trim }} j="{{ QUOTE | json }}" f={{ TOKEN | path }} {{"{{"}}x}}',
    );
    expect(templateNames(parts)).toEqual(["USER", "PASS", "ENC", "QUOTE", "TOKEN"]);
    expect([...templatePathNames(parts)]).toEqual(["TOKEN"]);
    const values: Record<string, { value: string; path?: string }> = {
      USER: { value: "ana" },
      PASS: { value: "p@ss wörd/1" },
      ENC: { value: btoa(" hola \n") },
      QUOTE: { value: 'a "b"\n' },
      TOKEN: { value: "t0k3n", path: "/dev/shm/t/TOKEN" },
    };
    expect(renderTemplate(parts, (name) => values[name]!)).toEqual({
      _tag: "rendered",
      text: `u=ana p=${encodeURIComponent("p@ss wörd/1")} b=cEBzcyB3w7ZyZC8x d=hola j="a \\"b\\"\\n" f=/dev/shm/t/TOKEN {{x}}`,
    });
    expect(previewTemplate(parts)).toBe(
      'u=[USER] p=[PASS] b=[PASS] d=[ENC] j="[QUOTE]" f=[TOKEN] {{x}}',
    );
  });

  it("fails on a value a filter cannot take, naming the input and never the value", () => {
    const parts = parsed("{{ ENC | base64decode }}");
    expect(renderTemplate(parts, () => ({ value: "not base64!" }))).toEqual({
      _tag: "failed",
      name: "ENC",
      filter: "base64decode",
    });
    expect(renderTemplate(parsed("{{ T | path }}"), () => ({ value: "x" }))).toEqual({
      _tag: "failed",
      name: "T",
      filter: "path",
    });
  });
});
