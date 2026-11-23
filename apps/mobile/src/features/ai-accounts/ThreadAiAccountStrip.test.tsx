import { EnvironmentId, SpaceId, ThreadId, type ServerProvider } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    may: true,
    commands: {} as Record<string, ReturnType<typeof vi.fn>>,
  },
}));

vi.mock("react-native", async () => (await import("../vaults/testkit")).nativeMocks.reactNative());
vi.mock("../../components/ui/AppText", async () =>
  (await import("../vaults/testkit")).nativeMocks.appText(),
);
vi.mock("../../components/ui/Button", async () =>
  (await import("../vaults/testkit")).nativeMocks.button(),
);
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.may }));
vi.mock("../../state/aiGateway", () => ({
  aiGatewayEnvironment: {
    pickerAccounts: { id: "picker" },
    setThreadAccount: { id: "switch", permissionAtom: () => ({}) },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) => mocks.commands[command.id],
}));

import { ThreadAiAccountStrip } from "./ThreadAiAccountStrip";

const hub = EnvironmentId.make("hub");
const ok = (value: unknown) => Promise.resolve({ _tag: "Success", value });
const providers = [
  { instanceId: "claudeAgent", driver: "claudeAgent" },
] as unknown as ReadonlyArray<ServerProvider>;
const accounts = [
  { id: "a1", name: "Work Claude", type: "subscription", provider: "claude", models: null },
  { id: "a2", name: "Team Claude", type: "api-key", provider: "claude", models: null },
];
const modelSelection = {
  instanceId: "claudeAgent",
  model: "claude-sonnet-4-5",
  aiAccountId: "a2",
} as never;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const text = () => container?.textContent ?? "";
const byLabel = (label: string) =>
  container?.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const click = (label: string) => act(async () => byLabel(label)?.click());
const onChooseDraft = vi.fn();

const render = async (isDraft: boolean, applies = true) => {
  mocks.commands.picker = vi.fn(() =>
    ok({ applies, spaceName: "Acme", accounts: applies ? accounts : [] }),
  );
  await act(async () =>
    root?.render(
      <ThreadAiAccountStrip
        environmentId={hub}
        threadId={ThreadId.make("t1")}
        isDraft={isDraft}
        spaceId={SpaceId.make("space-acme")}
        modelSelection={modelSelection}
        providers={providers}
        structure={null}
        onChooseDraft={onChooseDraft}
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
  mocks.may = true;
  onChooseDraft.mockReset();
  mocks.commands.switch = vi.fn(() => ok({}));
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("the AI account strip on a mobile Thread", () => {
  it("shows the account the Thread chose and its model", async () => {
    await render(false);
    expect(text()).toContain("Team Claude · claude-sonnet-4-5");
    expect(byLabel("AI account in use: Team Claude")).not.toBeNull();
  });

  it("switches the account mid-Thread through the Hub", async () => {
    await render(false);
    await click("Change AI account");
    await click("Use AI account Work Claude");
    expect(mocks.commands.switch).toHaveBeenCalledWith({
      environmentId: hub,
      input: {
        threadId: "t1",
        aiAccountId: "a1",
        instanceId: "claudeAgent",
        model: "claude-sonnet-4-5",
      },
    });
  });

  it("puts a draft's choice in the draft instead of calling the Hub", async () => {
    await render(true);
    await click("Change AI account");
    await click("Use AI account Work Claude");
    expect(onChooseDraft).toHaveBeenCalledWith("a1");
    expect(mocks.commands.switch).not.toHaveBeenCalled();
  });

  it("offers no change without the command's grant", async () => {
    mocks.may = false;
    await render(false);
    expect(byLabel("Change AI account")).toBeNull();
  });

  it("shows nothing where AI accounts do not decide", async () => {
    await render(false, false);
    expect(text()).toBe("");
  });

  it("names a lent account «· from <lender>» with its cap use, in use and among the choices", async () => {
    const lent = {
      id: "a3",
      name: "Shared Claude",
      type: "api-key",
      provider: "claude",
      models: null,
      lentBy: {
        grantId: "g1",
        name: "Ana",
        caps: {
          tokens: { used: 40, amount: 100, period: "day", resetsAt: "2026-11-24T00:00:00.000Z" },
          requests: null,
        },
      },
    };
    mocks.commands.picker = vi.fn(() =>
      ok({ applies: true, spaceName: "Acme", accounts: [...accounts, lent] }),
    );
    await act(async () =>
      root?.render(
        <ThreadAiAccountStrip
          environmentId={hub}
          threadId={ThreadId.make("t1")}
          isDraft
          spaceId={SpaceId.make("space-acme")}
          modelSelection={{ ...(modelSelection as object), aiAccountId: "a3" } as never}
          providers={providers}
          structure={null}
          onChooseDraft={onChooseDraft}
        />,
      ),
    );
    await act(async () => {});
    expect(byLabel("AI account in use: Shared Claude")?.textContent).toContain(
      "Shared Claude · from Ana · 40%",
    );
    await click("Change AI account");
    expect(byLabel("Use AI account Shared Claude")?.textContent).toContain(
      "Shared Claude · from Ana · 40%",
    );
    expect(byLabel("Use AI account Work Claude")?.textContent).toBe("Work Claude");
  });
});
