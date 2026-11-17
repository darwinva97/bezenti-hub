import { EnvironmentId, ThreadId, TurnItemId, VaultGroupId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    targets: [] as ReadonlyArray<{ id: string; name: string }>,
    answer: undefined as unknown as ReturnType<typeof vi.fn>,
  },
}));

vi.mock("react-native", async () => (await import("../vaults/testkit")).nativeMocks.reactNative());
vi.mock("../../components/ui/AppText", async () =>
  (await import("../vaults/testkit")).nativeMocks.appText(),
);
vi.mock("../../components/ui/Button", async () =>
  (await import("../vaults/testkit")).nativeMocks.button(),
);
vi.mock("../../components/ui/ListToggleRow", async () =>
  (await import("../vaults/testkit")).nativeMocks.toggleRow(),
);
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    answerSecretRequest: { id: "answer" },
    secretRequestVaultTargets: { id: "targets" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) =>
    command.id === "answer"
      ? mocks.answer
      : () => Promise.resolve({ _tag: "Success", value: { vaults: mocks.targets } }),
}));

import { SecretRequestCard } from "./SecretRequestCard";

const projected = {
  visibility: "local",
  item: {
    type: "secret_request",
    id: TurnItemId.make("item-1"),
    threadId: ThreadId.make("thread-1"),
    label: "GitHub token",
    reason: "To push",
    secretName: "GITHUB_TOKEN",
    secretStatus: "pending",
    delivery: "chat",
  },
} as never;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const text = () => container?.textContent ?? "";
const byLabel = (label: string) =>
  container?.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const type = async (label: string, value: string) => {
  const input = byLabel(label) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = (label: string) => act(async () => byLabel(label)?.click());
const render = async () => {
  await act(async () =>
    root?.render(
      <SecretRequestCard
        environmentId={EnvironmentId.make("hub")}
        projectedItem={projected}
        iconColor="#000"
      />,
    ),
  );
  await act(async () => {});
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.answer = vi.fn(() => Promise.resolve({ _tag: "Success", value: {} }));
  mocks.targets = [];
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("request_secret card on mobile", () => {
  it("offers no «Also save to Vault» to someone the Hub gives no Vault", async () => {
    await render();
    expect(text()).not.toContain("Also save to Vault");
  });

  it("saves to a Vault with the chosen name, only after the name and value pass", async () => {
    mocks.targets = [{ id: "vault-acme", name: "Acme" }];
    await render();
    await click("Also save to Vault");
    await type("GitHub token", "ghp_abcdefghijkl");
    await click("Save securely");
    expect(mocks.answer).toHaveBeenCalledTimes(1);
    expect(mocks.answer.mock.calls[0]![0]).toMatchObject({
      input: {
        answer: {
          type: "save",
          secret: "ghp_abcdefghijkl",
          saveToVault: { vaultId: VaultGroupId.make("vault-acme"), name: "GITHUB_TOKEN" },
        },
      },
    });
  });

  it("refuses a reserved name and a short value before calling the Hub", async () => {
    mocks.targets = [{ id: "vault-acme", name: "Acme" }];
    await render();
    await click("Also save to Vault");
    await type("Secret name", "T3_TOKEN");
    await type("GitHub token", "ghp_abcdefghijkl");
    expect((byLabel("Save securely") as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain("The Hub reserves this name.");
    await type("Secret name", "GITHUB_TOKEN");
    await type("GitHub token", "abc");
    expect((byLabel("Save securely") as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain("shorter than 6 characters");
    expect(mocks.answer).not.toHaveBeenCalled();
  });

  it("answers for this Thread only when the switch stays off", async () => {
    mocks.targets = [{ id: "vault-acme", name: "Acme" }];
    await render();
    await type("GitHub token", "ghp_abcdefghijkl");
    await click("Save securely");
    expect((mocks.answer.mock.calls[0]![0] as { input: { answer: object } }).input.answer).toEqual({
      type: "save",
      secret: "ghp_abcdefghijkl",
    });
  });
});
