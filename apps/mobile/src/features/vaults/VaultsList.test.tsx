import { EnvironmentId, type VaultEntry, type VaultSummary } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    mayWrite: true,
    listeners: new Set<() => void>(),
    isOwner: false,
    commands: {} as Record<string, ReturnType<typeof vi.fn>>,
  },
}));

vi.mock("react-native", async () => (await import("./testkit")).nativeMocks.reactNative());
vi.mock("../../components/ui/AppText", async () =>
  (await import("./testkit")).nativeMocks.appText(),
);
vi.mock("../../components/ui/Button", async () => (await import("./testkit")).nativeMocks.button());
vi.mock("../../components/ui/ListSection", async () =>
  (await import("./testkit")).nativeMocks.listSection(),
);
vi.mock("@effect/atom-react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAtomValue: () =>
      useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => mocks.listeners.delete(listener);
        },
        () => mocks.mayWrite,
      ),
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    listVaults: { id: "list" },
    listVaultEntries: { id: "entries" },
    putVaultEntry: { id: "put", permissionAtom: () => ({}) },
    threadVaultEnvironment: { id: "thread" },
  },
}));
vi.mock("../../state/spaces", () => ({
  useSpaceSelections: () => new Map([["hub", { view: { isOwner: mocks.isOwner } }]]),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) => mocks.commands[command.id],
}));

import { ThreadSecrets } from "./ThreadSecrets";
import { VaultsList } from "./VaultsList";

const hub = EnvironmentId.make("hub");
const vault = (over: Partial<VaultSummary>) =>
  ({
    id: "vault-acme",
    name: "Acme",
    description: null,
    spaceId: "space-acme",
    spaceName: "Acme",
    isMain: false,
    archived: false,
    entryCount: 2,
    canEdit: false,
    canManage: false,
    allowances: [],
    ...over,
  }) as unknown as VaultSummary;
const entries = [
  {
    id: "e1",
    vaultId: "vault-acme",
    name: "GITHUB_TOKEN",
    description: "CI",
    kind: "own",
    broken: false,
    linkedFrom: null,
    unmasked: false,
  },
  {
    id: "e2",
    vaultId: "vault-acme",
    name: "OLD",
    description: null,
    kind: "link",
    broken: true,
    linkedFrom: null,
    unmasked: false,
  },
] as unknown as ReadonlyArray<VaultEntry>;

const ok = (value: unknown) => Promise.resolve({ _tag: "Success", value });
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const setup = async (summary: VaultSummary) => {
  mocks.commands.list = vi.fn(() => ok({ vaults: [summary] }));
  mocks.commands.entries = vi.fn(() => ok({ entries }));
  mocks.commands.put = vi.fn(() => ok({ entry: entries[0], warnings: [] }));
  await act(async () => root?.render(<VaultsList environmentId={hub} />));
  await act(async () => {});
};
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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.mayWrite = true;
  mocks.isOwner = false;
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("Settings → Vaults on mobile", () => {
  it("shows names and badges, and no edit control, to a Member", async () => {
    await setup(vault({ canEdit: false }));
    expect(text()).toContain("GITHUB_TOKEN");
    expect(text()).toContain("broken");
    expect(text()).not.toContain("Replace value");
    expect(text()).not.toContain("Add secret");
  });

  it("hides the edit controls from an Admin whose session lacks the write grant", async () => {
    mocks.mayWrite = false;
    await act(async () => mocks.listeners.forEach((listener) => listener()));
    expect(text()).not.toContain("Replace value");
    expect(text()).not.toContain("Add secret");
  });

  it("never offers Reveal or the master key backup, not even to the Owner", async () => {
    mocks.isOwner = true;
    await setup(
      vault({
        canEdit: true,
        canManage: true,
        isMain: true,
        spaceId: null,
        spaceName: null,
      }),
    );
    expect(text()).not.toMatch(/\breveal/i);
    expect(text()).not.toMatch(/Download master key/i);
    expect(text()).toContain("Replace value");
  });

  it("lets an Admin replace a value (hidden input, cleared after) without ever showing it", async () => {
    await setup(vault({ canEdit: true }));
    await click("Replace value of GITHUB_TOKEN");
    expect(byLabel("New value for GITHUB_TOKEN")?.getAttribute("data-secure")).toBe("true");
    await type("New value for GITHUB_TOKEN", "s3cr3t-value-123");
    await click("Save new value for GITHUB_TOKEN");
    expect(mocks.commands.put).toHaveBeenCalledTimes(1);
    const call = mocks.commands.put!.mock.calls[0]![0] as {
      input: { vaultId: string; entryId: string; name: string; value: Redacted.Redacted<string> };
    };
    expect(call.input).toMatchObject({
      vaultId: "vault-acme",
      entryId: "e1",
      name: "GITHUB_TOKEN",
    });
    expect(Redacted.value(call.input.value)).toBe("s3cr3t-value-123");
    expect(text()).toContain("GITHUB_TOKEN saved.");
    expect(text()).not.toContain("s3cr3t-value-123");
    expect(byLabel("New value for GITHUB_TOKEN")).toBeNull();
  });

  it("does not replace a Secret link and refuses names the Hub reserves before calling", async () => {
    await setup(vault({ canEdit: true }));
    expect(byLabel("Replace value of OLD")).toBeNull();
    await click("Add secret");
    await type("Secret name", "T3_TOKEN");
    await type("Secret value", "abcdefgh");
    expect((byLabel("Save secret") as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain("The Hub reserves this name.");
    expect(mocks.commands.put).not.toHaveBeenCalled();
  });

  it("offers the Owner no Replace on a name that changes how tools run", async () => {
    mocks.isOwner = true;
    const dangerous = { ...entries[0], id: "e3", name: "NODE_OPTIONS" } as unknown as VaultEntry;
    mocks.commands.list = vi.fn(() => ok({ vaults: [vault({ canEdit: true })] }));
    mocks.commands.entries = vi.fn(() => ok({ entries: [entries[0], dangerous] }));
    mocks.commands.put = vi.fn(() => ok({ entry: entries[0], warnings: [] }));
    await act(async () => root?.render(<VaultsList environmentId={hub} />));
    await act(async () => {});
    expect(byLabel("Replace value of GITHUB_TOKEN")).not.toBeNull();
    expect(byLabel("Replace value of NODE_OPTIONS")).toBeNull();
  });

  it("closes an open Replace form when the write grant goes away", async () => {
    await setup(vault({ canEdit: true }));
    await click("Replace value of GITHUB_TOKEN");
    expect(byLabel("New value for GITHUB_TOKEN")).not.toBeNull();
    mocks.mayWrite = false;
    await act(async () => mocks.listeners.forEach((listener) => listener()));
    expect(byLabel("New value for GITHUB_TOKEN")).toBeNull();
  });

  it("shows the server's refusal and keeps the typed value out of the page", async () => {
    await setup(vault({ canEdit: true }));
    mocks.commands.put = vi.fn(() =>
      Promise.resolve({
        _tag: "Failure",
        cause: { _tag: "VaultError", message: "Only the Owner does that." },
      }),
    );
    await click("Replace value of GITHUB_TOKEN");
    await type("New value for GITHUB_TOKEN", "hunter2hunter2");
    await click("Save new value for GITHUB_TOKEN");
    expect(text()).not.toContain("hunter2hunter2");
  });
});

describe("a Thread's Secrets panel on mobile", () => {
  it("lists names, the winning Vault and whom it beats, never a value", async () => {
    mocks.commands.thread = vi.fn(() =>
      ok({
        threadId: "t1",
        variables: [
          {
            name: "TOKEN",
            vaultName: "Mine",
            source: "user",
            shadowed: [{ vaultId: "v", vaultName: "Acme", source: "space" }],
          },
        ],
      }),
    );
    await act(async () =>
      root?.render(<ThreadSecrets environmentId={hub} threadId={"t1" as never} />),
    );
    await click("Secrets");
    await act(async () => {});
    expect(text()).toContain("TOKEN from Mine (yours)");
    expect(text()).toContain("Wins over Acme (Space default)");
  });
});
