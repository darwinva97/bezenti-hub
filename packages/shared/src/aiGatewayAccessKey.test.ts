import { describe, expect, it } from "vite-plus/test";

import {
  ACCESS_KEY_PLACEHOLDER,
  accessKeySetup,
  claudeCodeModels,
  codexModel,
  sendsKeyInClear,
} from "./aiGatewayAccessKey.ts";

// A made-up key of the right shape: never a real one.
const KEY = "t3ak_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

describe("accessKeySetup", () => {
  it("points Claude Code at the Hub's Anthropic shape with the key as its auth token", () => {
    const setup = accessKeySetup("https://hub.example.com", KEY);
    expect(JSON.parse(setup.claudeCode)).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "https://hub.example.com/api/ai/anthropic",
        ANTHROPIC_AUTH_TOKEN: KEY,
      },
    });
  });

  it("gives Codex a provider on the Hub's OpenAI shape, the key only in the shell line", () => {
    const setup = accessKeySetup("https://hub.example.com", KEY);
    expect(setup.codex).toContain('model_provider = "t3"');
    expect(setup.codex).toContain("[model_providers.t3]");
    expect(setup.codex).toContain('base_url = "https://hub.example.com/api/ai/openai/v1"');
    expect(setup.codex).toContain('env_key = "T3_AI_GATEWAY_KEY"');
    expect(setup.codex).toContain('wire_api = "responses"');
    expect(setup.codex).not.toContain(KEY);
    expect(setup.codexShell).toBe(`export T3_AI_GATEWAY_KEY='${KEY}'`);
  });

  it("names each API shape's base URL for other clients", () => {
    const setup = accessKeySetup("https://hub.example.com", KEY);
    expect(setup.other).toContain("https://hub.example.com/api/ai/openai/v1");
    expect(setup.other).toContain("https://hub.example.com/api/ai/anthropic");
    expect(setup.other).toContain("https://hub.example.com/api/ai/gemini");
    expect(setup.other).toContain(KEY);
  });

  it("uses a placeholder once the key is no longer shown", () => {
    const setup = accessKeySetup("http://127.0.0.1:4310", null);
    for (const text of [setup.claudeCode, setup.codexShell, setup.other]) {
      expect(text).toContain(ACCESS_KEY_PLACEHOLDER);
      expect(text).not.toContain("t3ak_");
    }
  });
});

describe("pinned models (access-keys ticket 02)", () => {
  it("pins each Claude Code alias to its family, and the main model to Sonnet", () => {
    const setup = accessKeySetup("https://hub.example.com", KEY, [
      "claude-haiku-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(JSON.parse(setup.claudeCode).env).toMatchObject({
      ANTHROPIC_MODEL: "claude-sonnet-5-5",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5",
    });
  });

  it("without Haiku or Opus, those aliases take the first allowed model, Claude first", () => {
    expect(claudeCodeModels(["gpt-5.5", "claude-sonnet-5-5"])).toEqual({
      main: "claude-sonnet-5-5",
      opus: "claude-sonnet-5-5",
      sonnet: "claude-sonnet-5-5",
      haiku: "claude-sonnet-5-5",
    });
    expect(claudeCodeModels(["claude-opus-5-5"])).toEqual({
      main: "claude-opus-5-5",
      opus: "claude-opus-5-5",
      sonnet: "claude-opus-5-5",
      haiku: "claude-opus-5-5",
    });
    expect(claudeCodeModels([])).toBeNull();
  });

  it("gives Codex an OpenAI model when the key may use one, and pins nothing without models", () => {
    expect(codexModel(["claude-sonnet-5-5", "gpt-5.5"])).toBe("gpt-5.5");
    expect(codexModel(["gemini-3-pro"])).toBe("gemini-3-pro");
    const pinned = accessKeySetup("https://hub.example.com", KEY, ["gpt-5.5"]);
    expect(pinned.codex).toContain('model = "gpt-5.5"');
    const unpinned = accessKeySetup("https://hub.example.com", KEY);
    expect(unpinned.codex).not.toContain("model = ");
    expect(JSON.parse(unpinned.claudeCode).env.ANTHROPIC_MODEL).toBeUndefined();
  });
});

describe("sendsKeyInClear", () => {
  it("warns for plain http to another machine only", () => {
    expect(sendsKeyInClear("http://hub.example.com")).toBe(true);
    expect(sendsKeyInClear("http://192.168.1.20:4310")).toBe(true);
    expect(sendsKeyInClear("https://hub.example.com")).toBe(false);
    expect(sendsKeyInClear("http://127.0.0.1:4310")).toBe(false);
    expect(sendsKeyInClear("http://localhost:4310")).toBe(false);
    expect(sendsKeyInClear("http://[::1]:4310")).toBe(false);
    expect(sendsKeyInClear("not a url")).toBe(false);
  });
});
