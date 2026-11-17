import { SecretRequestError, ThreadId, TurnItemId, VaultGroupId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
  secretRequestVaultNameProblem,
  secretRequestVaultValueProblem,
} from "./secretRequest.ts";

describe("secretRequestDisplay", () => {
  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
  });
});

describe("secretRequestPrivacyNote", () => {
  it("does not promise to hide a value that the agent's commands can read", () => {
    expect(secretRequestPrivacyNote({})).toBe("Stored securely, never shown to the agent");
    expect(secretRequestPrivacyNote({ delivery: "file" })).not.toContain("never shown");
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});

describe("«Also save to Vault»", () => {
  const item = { id: TurnItemId.make("turn-item:1"), threadId: ThreadId.make("thread-1") };
  const vaultId = VaultGroupId.make("vault-acme");

  it("sends the Vault and the trimmed name with the answer", () => {
    expect(
      secretRequestAnswerInput(item, {
        type: "save",
        secret: " sk_live_1 ",
        saveToVault: { vaultId, name: " STRIPE_KEY " },
      }),
    ).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "save", secret: "sk_live_1", saveToVault: { vaultId, name: "STRIPE_KEY" } },
    });
  });

  it("refuses names the Hub would refuse from a card", () => {
    expect(secretRequestVaultNameProblem("STRIPE_KEY")).toBeNull();
    expect(secretRequestVaultNameProblem("")).not.toBeNull();
    expect(secretRequestVaultNameProblem("1KEY")).not.toBeNull();
    expect(secretRequestVaultNameProblem("T3CODE_TOKEN")).not.toBeNull();
    expect(secretRequestVaultNameProblem("GIT_SSH_COMMAND")).not.toBeNull();
    expect(
      secretRequestAnswerInput(item, {
        type: "save",
        secret: "sk_live_1",
        saveToVault: { vaultId, name: "PATH" },
      }),
    ).toBeNull();
  });
});

describe("secretRequestVaultValueProblem", () => {
  it("refuses saving a value too short to be masked, and says where it can go", () => {
    expect(secretRequestVaultValueProblem("")).toBeNull();
    expect(secretRequestVaultValueProblem("123456")).toBeNull();
    expect(secretRequestVaultValueProblem("1234")).toContain("Settings → Vaults");
  });
});
