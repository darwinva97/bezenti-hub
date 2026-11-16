import { describe, expect, it } from "vite-plus/test";

import { looksLikeCredential } from "./vaults.ts";

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
