import { EnvironmentId, type Grant } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    mayChange: true,
    commands: {} as Record<string, ReturnType<typeof vi.fn>>,
    accept: null as unknown as Mock<(...args: unknown[]) => unknown>,
    reloadSpaces: null as unknown as Mock<(...args: unknown[]) => unknown>,
    confirm: null as unknown as Mock<(...args: unknown[]) => unknown>,
  },
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
vi.mock("../../components/ui/ListToggleRow", async () =>
  (await import("../vaults/testkit")).nativeMocks.toggleRow(),
);
vi.mock("../../components/ui/Dialog", () => ({
  confirm: (request: unknown) => mocks.confirm(request),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.mayChange }));
vi.mock("../../state/grants", () => ({
  grantsEnvironment: {
    listGiven: { id: "given" },
    listReceived: { id: "received" },
    reject: { id: "reject" },
    cancel: { id: "cancel" },
    end: { id: "end", permissionAtom: () => ({}) },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { id: string }) => mocks.commands[command.id],
}));
vi.mock("../../state/spaces", () => ({
  reloadSpaces: (connection: unknown) => mocks.reloadSpaces(connection),
}));
// Accepting goes over HTTP: the client stands in for the Hub's `/api/grants/accept`.
vi.mock("../../state/space-admin", () => ({
  callHub: (
    _connection: unknown,
    call: (client: unknown, headers: Record<string, string>) => unknown,
  ) => call({ grants: { accept: mocks.accept } }, { authorization: "Bearer session" }),
  reasonOf: (cause: unknown, fallback: string) =>
    cause instanceof Error && cause.message.length > 0 ? cause.message : fallback,
}));
vi.mock("./LoanUse", () => ({
  LoanUse: ({ grant }: { grant: Grant }) => <p>{`Use panel of ${grant.resource.name}`}</p>,
}));

import type { SavedRemoteConnection } from "../../lib/connection";
import { MACHINE_ON_WEB_NOTE } from "./acceptLoan";
import { LoansList } from "./LoansList";

const hub = EnvironmentId.make("hub");
const connection = { environmentId: hub } as unknown as SavedRemoteConnection;
const NONE = { cancel: false, revoke: false, decide: false, return: false, setLimits: false };

const loan = (
  over: { readonly id: string; readonly state: Grant["state"] } & Record<string, unknown>,
): Grant =>
  ({
    resource: { kind: "ai-account", id: "acc-1", name: "Team Claude" },
    lender: { kind: "user", id: "u-ana", name: "Ana" },
    target: { spaceId: "space-acme", kind: "organization", name: "Acme" },
    endReason: null,
    limits: { kind: "ai-account", tokens: null, requests: null },
    createdAt: "2026-11-01T00:00:00.000Z",
    decidedAt: null,
    endedAt: null,
    aiAccount: { provider: "claude", type: "subscription" },
    can: NONE,
    ...over,
  }) as unknown as Grant;

const ok = (value: unknown) => Promise.resolve({ _tag: "Success", value });
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const text = () => container?.textContent ?? "";
const byLabel = (label: string) =>
  container?.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const click = (label: string) => act(async () => byLabel(label)?.click());

const render = async (lists: {
  readonly given?: ReadonlyArray<Grant>;
  readonly received?: ReadonlyArray<Grant>;
}) => {
  mocks.commands.given = vi.fn(() => ok({ grants: lists.given ?? [] }));
  mocks.commands.received = vi.fn(() => ok({ grants: lists.received ?? [] }));
  await act(async () => root?.render(<LoansList connection={connection} />));
  await act(async () => {});
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.mayChange = true;
  mocks.commands = {
    reject: vi.fn(() => ok({})),
    cancel: vi.fn(() => ok({})),
    end: vi.fn(() => ok({})),
  };
  mocks.accept = vi.fn(() => Promise.resolve({}));
  mocks.reloadSpaces = vi.fn(() => Promise.resolve());
  mocks.confirm = vi.fn();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("Settings → Loans on mobile", () => {
  it("sorts what the User's Spaces received into waiting, borrowed and ended", async () => {
    await render({
      received: [
        loan({ id: "g-wait", state: "pending", can: { ...NONE, decide: true } }),
        loan({
          id: "g-use",
          state: "active",
          resource: { kind: "ai-account", id: "acc-2", name: "Shared Codex" },
          can: { ...NONE, return: true },
        }),
        loan({
          id: "g-end",
          state: "ended",
          endReason: "revoked",
          endedAt: "2026-11-20T10:00:00.000Z",
          resource: { kind: "ai-account", id: "acc-3", name: "Old key" },
        }),
      ],
    });
    expect(byLabel("Waiting for you")?.textContent).toContain("Team Claude for Acme");
    expect(byLabel("Borrowed by your Spaces")?.textContent).toContain("Shared Codex in Acme");
    expect(byLabel("Ended loans to your Spaces")?.textContent).toContain("(taken back)");
    // What the lender sees, and a subscription's terms, as web says them.
    expect(byLabel("Waiting: Team Claude")?.textContent).toContain(
      "Ana sees how much each person here uses it, never prompts or Threads.",
    );
    expect(text()).toContain("The terms of claude forbid sharing this account");
  });

  it("lists a pending loan as waiting only where the User decides", async () => {
    await render({ received: [loan({ id: "g-wait", state: "pending", can: NONE })] });
    expect(byLabel("Waiting for you")).toBeNull();
    expect(byLabel("Accept Team Claude")).toBeNull();
  });

  it("accepts an AI account over HTTP without a strong factor and refreshes the Spaces' counts", async () => {
    const waiting = loan({ id: "g-wait", state: "pending", can: { ...NONE, decide: true } });
    await render({ received: [waiting] });
    await click("Accept Team Claude");
    expect(mocks.accept).toHaveBeenCalledWith({
      headers: { authorization: "Bearer session" },
      payload: { grantId: "g-wait" },
    });
    expect(mocks.reloadSpaces).toHaveBeenCalledWith(connection);
    expect(mocks.commands.received).toHaveBeenCalledTimes(2);
  });

  it("accepts a Vault group as a Space default unless the User turns it off", async () => {
    const group = loan({
      id: "g-group",
      state: "pending",
      resource: { kind: "vault-group", id: "vault-1", name: "CI secrets" },
      limits: { kind: "vault-group" },
      can: { ...NONE, decide: true },
    });
    await render({ received: [group] });
    await click("Accept CI secrets");
    expect(text()).toContain("Ana can change what it holds at any time.");
    expect(byLabel("Also use it as a default of Acme")?.getAttribute("aria-checked")).toBe("true");
    await click("Also use it as a default of Acme");
    await click("Confirm accepting CI secrets");
    expect(mocks.accept).toHaveBeenCalledWith({
      headers: { authorization: "Bearer session" },
      payload: { grantId: "g-group", useAsDefault: false },
    });
  });

  it("never accepts a machine on mobile: it says to accept it on web or desktop", async () => {
    const machine = loan({
      id: "g-machine",
      state: "pending",
      resource: { kind: "environment", id: "env-1", name: "Ana's box" },
      limits: {
        kind: "environment",
        cpus: 2,
        memoryBytes: 4 * 1024 ** 3,
        pids: 4096,
        diskBytes: 20 * 1024 ** 3,
      },
      can: { ...NONE, decide: true },
    });
    await render({ received: [machine] });
    expect(byLabel("Accept Ana's box")).toBeNull();
    expect(text()).toContain(MACHINE_ON_WEB_NOTE);
    expect(text()).toContain("Ana controls this machine and can see everything that runs on it");
    // Rejecting needs no strong factor.
    await click("Reject Ana's box");
    expect(mocks.commands.reject).toHaveBeenCalledWith({
      environmentId: hub,
      input: { grantId: "g-machine" },
    });
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it("warns before giving a loan back, and ends it once confirmed", async () => {
    await render({
      received: [loan({ id: "g-use", state: "active", can: { ...NONE, return: true } })],
    });
    await click("Give back Team Claude");
    const request = mocks.confirm.mock.calls[0]?.[0] as {
      title: string;
      message: string;
      onConfirm: () => void;
    };
    expect(request.title).toBe("Give back Team Claude?");
    expect(request.message).toContain("The Threads of Acme that use it are refused");
    expect(mocks.commands.end).not.toHaveBeenCalled();
    await act(async () => request.onConfirm());
    expect(mocks.commands.end).toHaveBeenCalledWith({
      environmentId: hub,
      input: { grantId: "g-use" },
    });
  });

  it("opens an AI account loan's use from its row", async () => {
    await render({ received: [loan({ id: "g-use", state: "active" })] });
    await click("Use of Team Claude");
    expect(text()).toContain("Use panel of Team Claude");
  });

  it("shows what the User lent, with take back, cancel and the Secrets to rotate", async () => {
    await render({
      given: [
        loan({ id: "g-lent", state: "active", can: { ...NONE, revoke: true } }),
        loan({
          id: "g-link",
          state: "offered",
          target: null,
          offer: { expiresAt: "2026-11-30T10:00:00.000Z", status: "open" },
          can: { ...NONE, cancel: true },
        }),
        loan({
          id: "g-group",
          state: "ended",
          endReason: "revoked",
          resource: { kind: "vault-group", id: "vault-1", name: "CI secrets" },
          limits: { kind: "vault-group" },
          vaultGroup: { toRotate: [{ entryId: "e1", name: "GITHUB_TOKEN" }] },
        }),
      ],
    });
    expect(byLabel("Team Claude is lent to")?.textContent).toContain("lent to 1 · 1 open link");
    expect(text()).toContain("Rotate these Secrets in Vaults: GITHUB_TOKEN.");
    await click("Cancel Team Claude lent to Lending link");
    expect(mocks.commands.cancel).toHaveBeenCalledWith({
      environmentId: hub,
      input: { grantId: "g-link" },
    });
    await click("Take back Team Claude lent to Acme");
    const request = mocks.confirm.mock.calls[0]?.[0] as { title: string; message: string };
    expect(request.title).toBe("Take back Team Claude?");
    expect(request.message).toContain("The Threads of Acme that use it are refused");
  });

  it("offers no change without the command's permission", async () => {
    mocks.mayChange = false;
    await render({
      received: [
        loan({ id: "g-wait", state: "pending", can: { ...NONE, decide: true } }),
        loan({ id: "g-use", state: "active", can: { ...NONE, return: true } }),
      ],
    });
    expect(byLabel("Accept Team Claude")).toBeNull();
    expect(byLabel("Give back Team Claude")).toBeNull();
  });

  it("shows the Hub's reason when a change is refused", async () => {
    mocks.accept = vi.fn(() => Promise.reject(new Error("This loan is no longer waiting.")));
    await render({
      received: [loan({ id: "g-wait", state: "pending", can: { ...NONE, decide: true } })],
    });
    await click("Accept Team Claude");
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      "This loan is no longer waiting.",
    );
    expect(mocks.reloadSpaces).not.toHaveBeenCalled();
  });
});
