import type { AiAccountOwnerOption, AiAccountSummary, SpaceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { type Locator, page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AiAccountsSettingsPanel } from "./AiAccountsSettings";

const hub = vi.hoisted(() => ({
  accounts: [] as unknown[],
  owners: [] as unknown[],
  canManage: false,
  calls: [] as Array<{ readonly label: string; readonly input: unknown }>,
}));

vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "env-primary",
}));
vi.mock("../../state/aiGateway", () => {
  const command = { permissionAtom: () => ({}) };
  return {
    aiGatewayEnvironment: new Proxy({}, { get: () => command }),
  };
});
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({
  // The label tells the commands apart; every change is recorded, the list answers.
  useAtomCommand: (_command: unknown, label: string) => (target?: { readonly input?: unknown }) => {
    hub.calls.push({ label, input: target?.input });
    const value =
      label === "list the AI accounts" || label === "order the AI accounts"
        ? { accounts: hub.accounts, canManage: hub.canManage, owners: hub.owners }
        : label === "delete an AI account"
          ? { gateway: "running" }
          : {};
    return Promise.resolve({ _tag: "Success", value });
  },
}));
vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
vi.mock("./AccessKeysSettings", () => ({ AccessKeysSection: () => <p>access keys</p> }));
vi.mock("./AiUsageSettings", () => ({ AiUsageTab: () => <p>usage</p> }));
vi.mock("./LocalCliKeysSettings", () => ({ LocalCliKeysSection: () => <p>local keys</p> }));
vi.mock("./MigratedLoansReview", () => ({ MigratedLoansReview: () => null }));
vi.mock("./LendAiAccountDialog", () => ({ LendAiAccountDialog: () => <p>lend dialog</p> }));

/** A modal's inert layer takes pointer events in this frame: press it as a keyboard would. */
const press = (locator: Locator) => (locator.element() as HTMLElement).click();

const ME = { kind: "user", userId: "user-me" } as const;
const ACME = "space-acme" as SpaceId;

function account(
  id: string,
  name: string,
  shape: Partial<AiAccountSummary> & { readonly details?: Partial<AiAccountSummary["details"]> },
): AiAccountSummary {
  const { details, ...rest } = shape;
  return {
    id,
    name,
    type: "api-key",
    provider: "claude",
    priority: 1,
    status: "working",
    statusMessage: null,
    disabled: false,
    usableIn: [],
    owner: ME,
    canManage: true,
    ...rest,
    details:
      details === null
        ? null
        : {
            keyHint: "abcd",
            baseUrl: null,
            models: [],
            allowances: { spaceIds: [], userIds: [] },
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-01T00:00:00.000Z",
            ...details,
          },
  } as AiAccountSummary;
}

function reset(shape: { readonly canManage?: boolean } = {}) {
  hub.calls = [];
  hub.canManage = shape.canManage ?? false;
  hub.owners = [{ owner: ME, name: "Mia" }] satisfies ReadonlyArray<AiAccountOwnerOption>;
  hub.accounts = [
    account("acct-key", "Claude key", {}),
    account("acct-max", "Claude Max", {
      type: "subscription",
      priority: 2,
      status: "disabled",
      disabled: true,
      statusMessage: "Off until you check who it signed in as.",
      details: { keyHint: null, signedInAs: "mia@example.com" },
    }),
  ];
}

const callsOf = (label: string) =>
  hub.calls.filter((call) => call.label === label).map((call) => call.input);

it("lists each account as one dense row, and adds one in a dialog", async () => {
  reset();
  await using _screen = await render(<AiAccountsSettingsPanel scope={{ kind: "user" }} />);

  const key = page.getByRole("listitem", { name: "Claude key" });
  await expect.element(key).toBeVisible();
  await expect.element(key.getByText("Key ending in …abcd", { exact: false })).toBeVisible();
  const max = page.getByRole("listitem", { name: "Claude Max" });
  await expect
    .element(max.getByText("Signed in as mia@example.com", { exact: false }))
    .toBeVisible();
  await expect.element(max.getByText("Off until you check who it signed in as.")).toBeVisible();
  // No form is open on the page: adding waits behind its button.
  expect(page.getByRole("form", { name: "Add an API key" }).elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: /Import from CLIProxyAPI/ }).elements()).toHaveLength(0);

  await page.getByRole("button", { name: "Add AI account to Mine" }).click();
  const dialog = page.getByRole("dialog", { name: "Add one of your AI accounts" });
  await expect.element(dialog.getByRole("form", { name: "Add an API key" })).toBeVisible();
  await dialog.getByRole("textbox", { name: "AI account name" }).fill("Spare key");
  await dialog.getByRole("textbox", { name: "API key" }).fill("not-a-real-key");
  press(dialog.getByRole("button", { name: "Add AI account" }));
  await expect.poll(() => callsOf("add an AI account")).toHaveLength(1);
  expect(callsOf("add an AI account")[0]).toMatchObject({
    name: "Spare key",
    provider: "claude",
    owner: ME,
  });
  await expect.element(dialog).not.toBeInTheDocument();

  // The other kinds are in the same dialog.
  await page.getByRole("button", { name: "Add AI account to Mine" }).click();
  press(dialog.getByRole("button", { name: "Subscription" }));
  await expect.element(dialog.getByRole("region", { name: "Add subscription" })).toBeVisible();
  await expect
    .element(dialog.getByRole("note", { name: "Terms of service warning" }))
    .toBeVisible();
  press(dialog.getByRole("button", { name: "Vertex service account" }));
  await expect
    .element(dialog.getByRole("form", { name: "Import a Vertex service account" }))
    .toBeVisible();
});

it("orders, enables, manages and deletes an account from its row", async () => {
  reset();
  await using _screen = await render(<AiAccountsSettingsPanel scope={{ kind: "user" }} />);

  await expect.element(page.getByRole("button", { name: "Move Claude key up" })).toBeDisabled();
  await page.getByRole("button", { name: "Move Claude key down" }).click();
  await expect
    .poll(() => callsOf("order the AI accounts"))
    .toEqual([{ accountIds: ["acct-max", "acct-key"], owner: ME }]);

  // A disabled one says so and turns on from its row.
  await page.getByRole("button", { name: "Enable Claude Max" }).click();
  await expect
    .poll(() => callsOf("change an AI account"))
    .toEqual([{ accountId: "acct-max", disabled: false }]);

  // Changing it is in «Manage…».
  await page.getByRole("button", { name: "Actions for Claude key" }).click();
  await page.getByRole("menuitem", { name: "Manage Claude key" }).click();
  const manage = page.getByRole("dialog", { name: "Claude key" });
  await expect
    .element(manage.getByRole("form", { name: "Replace credential of Claude key" }))
    .toBeVisible();
  await manage.getByRole("textbox", { name: "Name of Claude key" }).fill("Claude main");
  press(manage.getByRole("button", { name: "Save changes" }));
  await expect
    .poll(() => callsOf("change an AI account").at(-1))
    .toEqual({ accountId: "acct-key", name: "Claude main" });
  // Saved (the list is read again): it closes like any dialog.
  await expect.element(manage.getByRole("button", { name: "Save changes" })).toBeEnabled();
  press(manage.getByRole("button", { name: "Close" }));
  await expect.element(manage).not.toBeInTheDocument();

  // Deleting asks first.
  await page.getByRole("button", { name: "Actions for Claude key" }).click();
  await page.getByRole("menuitem", { name: "Delete Claude key" }).click();
  await expect
    .element(page.getByRole("alertdialog", { name: "Delete «Claude key»?" }))
    .toBeVisible();
  expect(callsOf("delete an AI account")).toHaveLength(0);
  press(page.getByRole("button", { name: "Confirm delete Claude key" }));
  await expect.poll(() => callsOf("delete an AI account")).toEqual([{ accountId: "acct-key" }]);
});

it("gives the Owner the import in a dialog, and shows others' accounts without actions", async () => {
  reset({ canManage: true });
  hub.accounts = [
    ...hub.accounts,
    account("acct-otto", "Otto's key", {
      owner: { kind: "user", userId: "user-otto" } as AiAccountSummary["owner"] & object,
      canManage: false,
      details: null,
    }),
  ];
  await using _screen = await render(<AiAccountsSettingsPanel scope={{ kind: "user" }} />);

  await page.getByRole("button", { name: /Import from CLIProxyAPI/ }).click();
  const dialog = page.getByRole("dialog", { name: "Import from CLIProxyAPI" });
  await expect
    .element(dialog.getByRole("button", { name: "Choose CLIProxyAPI auth files" }))
    .toBeVisible();
  press(dialog.getByRole("button", { name: "Cancel" }));
  await expect.element(dialog).not.toBeInTheDocument();

  // «Other people's AI accounts» is the Owner's view: name, provider and status only.
  await expect.element(page.getByRole("listitem", { name: "Otto's key" })).toBeVisible();
  expect(page.getByRole("button", { name: "Actions for Otto's key" }).elements()).toHaveLength(0);
});

it("lists an Organization's accounts alone in its Space settings", async () => {
  reset();
  hub.owners = [
    { owner: ME, name: "Mia" },
    { owner: { kind: "organization", spaceId: ACME }, name: "Acme" },
  ];
  hub.accounts = [
    ...hub.accounts,
    account("acct-acme", "Acme team key", { owner: { kind: "organization", spaceId: ACME } }),
  ];
  await using _screen = await render(
    <AiAccountsSettingsPanel scope={{ kind: "organization", spaceId: ACME }} />,
  );

  await expect.element(page.getByRole("listitem", { name: "Acme team key" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add AI account to Acme" })).toBeVisible();
  expect(page.getByRole("listitem", { name: "Claude key" }).elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "Local CLI keys" }).elements()).toHaveLength(0);
});
