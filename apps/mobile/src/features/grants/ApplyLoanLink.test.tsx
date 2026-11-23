import { EnvironmentId, type GrantOfferPreview } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: { commands: {} as Record<string, ReturnType<typeof vi.fn>> },
}));

vi.mock("react-native", async () => (await import("../vaults/testkit")).nativeMocks.reactNative());
vi.mock("../../components/ui/AppText", async () =>
  (await import("../vaults/testkit")).nativeMocks.appText(),
);
vi.mock("../../components/ui/Button", async () =>
  (await import("../vaults/testkit")).nativeMocks.button(),
);
vi.mock("../../components/ui/ListSection", async () =>
  (await import("../vaults/testkit")).nativeMocks.listSection(),
);
vi.mock("../../components/ui/ListChoiceRow", async () =>
  (await import("../vaults/testkit")).nativeMocks.choiceRow(),
);
vi.mock("../../state/grants", () => ({
  grantsEnvironment: { readOffer: { id: "read" }, claimOffer: { id: "claim" } },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) => mocks.commands[command.id],
}));

import { ApplyLoanLink } from "./ApplyLoanLink";

const hub = EnvironmentId.make("hub");
const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";
const LINK = `https://hub.example.test/grants/offer#token=${TOKEN}`;

const offer = (over: Partial<Extract<GrantOfferPreview, { status: "valid" }>> = {}) =>
  ({
    status: "valid",
    resource: {
      kind: "ai-account",
      name: "Team Claude",
      aiAccount: { provider: "claude", type: "subscription" },
    },
    lender: { kind: "user", name: "Ana" },
    limits: {
      kind: "ai-account",
      tokens: { amount: 100000, period: "day" },
      requests: null,
    },
    expiresAt: "2026-11-30T10:00:00.000Z",
    spaces: [
      { spaceId: "space-acme", kind: "organization", name: "Acme", alreadyGranted: false },
      { spaceId: "space-beta", kind: "organization", name: "Beta", alreadyGranted: true },
    ],
    ...over,
  }) as GrantOfferPreview;

const ok = (value: unknown) => Promise.resolve({ _tag: "Success", value });
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const text = () => container?.textContent ?? "";
const byLabel = (label: string) =>
  container?.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const click = (label: string) => act(async () => byLabel(label)?.click());
const type = async (label: string, value: string) => {
  const input = byLabel(label) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const readLink = async (link: string, preview: GrantOfferPreview) => {
  mocks.commands.read = vi.fn(() => ok(preview));
  await act(async () => root?.render(<ApplyLoanLink environmentId={hub} />));
  await type("Lending link", link);
  await click("Read link");
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.commands = { claim: vi.fn(() => ok({})) };
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("applying a lending link on mobile", () => {
  it("reads a pasted link and shows what is lent, by whom, its limits and warnings", async () => {
    await readLink(LINK, offer());
    expect(mocks.commands.read).toHaveBeenCalledWith({
      environmentId: hub,
      input: { token: TOKEN },
    });
    expect(byLabel("Ana lends you Team Claude")).not.toBeNull();
    expect(text()).toContain("100,000 tokens a day");
    expect(text()).toContain(
      "Ana sees how much each person in the Space uses it, never prompts or Threads",
    );
    expect(text()).toContain("The terms of claude forbid sharing this account");
    // The token stays in memory only: the field is cleared once read.
    expect((byLabel("Lending link") as HTMLInputElement).value).toBe("");
  });

  it("applies it to the Space the User picks, not to one it is already lent to", async () => {
    await readLink(LINK, offer());
    expect((byLabel("Beta (already lent there)") as HTMLButtonElement).disabled).toBe(true);
    expect((byLabel("Accept the loan") as HTMLButtonElement).disabled).toBe(true);
    await click("Acme");
    await click("Accept the loan");
    expect(mocks.commands.claim).toHaveBeenCalledWith({
      environmentId: hub,
      input: { token: TOKEN, spaceId: "space-acme" },
    });
    expect(text()).toContain("Lent to Acme: its Threads can use it now.");
  });

  it("refuses what is not a lending link without asking the Hub", async () => {
    mocks.commands.read = vi.fn();
    await act(async () => root?.render(<ApplyLoanLink environmentId={hub} />));
    await type("Lending link", "https://hub.example.test/settings");
    await click("Read link");
    expect(mocks.commands.read).not.toHaveBeenCalled();
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "That is not a lending link",
    );
  });

  it("says a used, expired or cancelled link no longer works", async () => {
    await readLink(LINK, { status: "invalid" });
    expect(text()).toContain("This lending link no longer works.");
    expect(byLabel("Accept the loan")).toBeNull();
  });

  it("sends a machine's link to web or desktop, where the strong factor is asked", async () => {
    await readLink(
      LINK,
      offer({
        resource: { kind: "environment", name: "Ana's box" },
        limits: {
          kind: "environment",
          cpus: 2,
          memoryBytes: 4 * 1024 ** 3,
          pids: 4096,
          diskBytes: 20 * 1024 ** 3,
        },
      }),
    );
    expect(text()).toContain("Ana controls this machine and can see everything that runs on it");
    expect(text()).toContain("open the link on the web or desktop app");
    expect(byLabel("Acme")).toBeNull();
    expect(byLabel("Accept the loan")).toBeNull();
    expect(mocks.commands.claim).not.toHaveBeenCalled();
  });
});
