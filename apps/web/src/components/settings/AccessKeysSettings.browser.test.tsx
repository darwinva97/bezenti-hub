import type { AccessKey, AccessKeyAccountOption } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { expect, it, vi } from "vite-plus/test";
import { type Locator, page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AccessKeysSection } from "./AccessKeysSettings";

const hub = vi.hoisted(() => ({
  keys: [] as unknown[],
  accounts: [] as unknown[],
  subscription: false,
  created: [] as unknown[],
  revoked: [] as unknown[],
  updated: [] as unknown[],
}));

vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "env-primary",
}));
vi.mock("../../hubLinks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hubLinks")>()),
  readHubLinkOrigin: () => "https://hub.example",
}));
vi.mock("../../state/aiGateway", () => {
  const command = { permissionAtom: () => ({}) };
  return {
    aiGatewayEnvironment: {
      listAccessKeys: command,
      createAccessKey: command,
      revokeAccessKey: command,
      updateAccessKey: command,
      accessKeyModelOptions: command,
    },
  };
});
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({
  // The label tells the commands apart.
  useAtomCommand: (_command: unknown, label: string) => (target?: { readonly input?: unknown }) => {
    const success = (value: unknown) => Promise.resolve({ _tag: "Success", value });
    switch (label) {
      case "list the access keys":
        return success({
          keys: hub.keys,
          everyone: false,
          space: { canManage: true, subscription: hub.subscription },
        });
      case "read what a key may reach":
        return success({ accounts: hub.accounts });
      case "make an access key": {
        hub.created.push(target?.input);
        const input = target?.input as { readonly label: string; readonly models: string[] };
        return success({
          created: accessKey("key-new", input.label, { models: input.models }),
          key: Redacted.make("t3ak_test_not_a_real_key"),
        });
      }
      case "revoke an access key":
        hub.revoked.push(target?.input);
        return success({});
      case "change an access key":
        hub.updated.push(target?.input);
        return success({});
      default:
        return success({});
    }
  },
}));

/** A modal's inert layer takes pointer events in this frame: press it as a keyboard would. */
const press = (locator: Locator) => (locator.element() as HTMLElement).click();

const SPACE = "space-acme" as AccessKey["spaceId"];

function accessKey(keyId: string, label: string, shape: Partial<AccessKey> = {}): AccessKey {
  return {
    keyId,
    spaceId: SPACE,
    spaceName: "Acme",
    label,
    hint: "w9Xz",
    createdBy: "user-me" as AccessKey["createdBy"],
    createdByName: "Mia",
    createdAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    models: ["*"],
    accounts: null,
    reaches: null,
    limits: { total: null, day: null, week: null, month: null },
    ...shape,
  };
}

const account = (
  id: string,
  name: string,
  models: ReadonlyArray<string>,
  type: AccessKeyAccountOption["type"] = "api-key",
): AccessKeyAccountOption =>
  ({ id, name, provider: "claude", type, models }) as unknown as AccessKeyAccountOption;

function reset() {
  hub.keys = [];
  hub.subscription = false;
  hub.created = [];
  hub.revoked = [];
  hub.updated = [];
  hub.accounts = [
    account("acct-claude", "Claude team", [
      "claude-sonnet-4-5",
      "claude-opus-4-1",
      "claude-haiku-4",
    ]),
    account("acct-openai", "OpenAI", ["gpt-5", "gpt-5-mini"]),
  ];
}

it("lists the keys first and makes a new one in a dialog that then shows it once", async () => {
  reset();
  hub.keys = [accessKey("key-1", "Partner Bob")];
  await using _screen = await render(<AccessKeysSection spaceId={SPACE} />);

  // The list is the page; the form waits behind «New access key».
  await expect.element(page.getByRole("listitem", { name: "Partner Bob" })).toBeVisible();
  expect(page.getByRole("form", { name: "Create an access key" }).elements()).toHaveLength(0);

  await page.getByRole("button", { name: "New access key" }).click();
  const dialog = page.getByRole("dialog", { name: "New access key" });
  await expect.element(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Who it is for" }).fill("Partner Ann");
  await dialog.getByRole("spinbutton", { name: "Per day tokens" }).fill("100000");
  // The models: a search, not a wall of checkboxes.
  await dialog.getByRole("combobox", { name: "Search models" }).fill("sonnet");
  await page.getByRole("option", { name: "claude-sonnet-4-5" }).click();
  await expect
    .element(dialog.getByRole("button", { name: "Remove claude-sonnet-4-5" }))
    .toBeVisible();
  press(dialog.getByRole("button", { name: "Create key" }));

  // The same dialog shows the key once, with its setup; only «Done» closes it.
  const reveal = page.getByRole("dialog", { name: "Copy «Partner Ann» now" });
  await expect.element(reveal).toBeVisible();
  await expect.element(reveal.getByLabelText("Key", { exact: true })).toBeInTheDocument();
  expect(hub.created).toEqual([
    {
      spaceId: SPACE,
      label: "Partner Ann",
      validity: { days: 30 },
      models: ["claude-sonnet-4-5"],
      limits: { total: null, day: 100000, week: null, month: null },
    },
  ]);
  await userEvent.keyboard("{Escape}");
  await expect.element(reveal).toBeVisible();
  press(reveal.getByRole("button", { name: "Done" }));
  await expect.element(reveal).not.toBeInTheDocument();
});

it("searches the models across families, adds a pattern and removes a chip", async () => {
  reset();
  await using _screen = await render(<AccessKeysSection spaceId={SPACE} />);
  await page.getByRole("button", { name: "New access key" }).click();
  const dialog = page.getByRole("dialog", { name: "New access key" });
  const search = dialog.getByRole("combobox", { name: "Search models" });

  await search.click();
  // Grouped by family.
  await expect.element(page.getByRole("group", { name: "claude-opus" })).toBeVisible();
  await expect.element(page.getByRole("group", { name: "gpt" })).toBeVisible();
  await search.fill("mini");
  await expect.element(page.getByRole("option", { name: "gpt-5-mini" })).toBeVisible();
  expect(page.getByRole("option", { name: "claude-opus-4-1" }).elements()).toHaveLength(0);
  await page.getByRole("option", { name: "gpt-5-mini" }).click();
  await expect.element(dialog.getByRole("button", { name: "Remove gpt-5-mini" })).toBeVisible();

  // A pattern the catalog does not list is offered from what was typed.
  await expect.element(search).toHaveValue("");
  await userEvent.keyboard("claude-sonnet-*");
  await page.getByRole("button", { name: "Add «claude-sonnet-*» as a pattern" }).click();
  await expect.element(search).toHaveValue("");
  // Closed, the chips are in reach again (the open list hides what was there when it opened).
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).toBeVisible();
  await expect
    .element(dialog.getByRole("button", { name: "Remove claude-sonnet-*" }))
    .toBeVisible();
  await expect.element(dialog.getByRole("button", { name: "Remove gpt-5-mini" })).toBeVisible();

  press(dialog.getByRole("button", { name: "Remove gpt-5-mini" }));
  await expect
    .element(dialog.getByRole("button", { name: "Remove gpt-5-mini" }))
    .not.toBeInTheDocument();

  await dialog.getByRole("textbox", { name: "Who it is for" }).fill("Partner Ann");
  press(dialog.getByRole("checkbox", { name: "No token limit" }));
  await expect.element(dialog.getByRole("checkbox", { name: "No token limit" })).toBeChecked();
  press(dialog.getByRole("button", { name: "Create key" }));
  await expect.element(page.getByRole("dialog", { name: "Copy «Partner Ann» now" })).toBeVisible();
  expect(hub.created).toEqual([
    expect.objectContaining({ models: ["claude-sonnet-*"], unlimited: true }),
  ]);
});

it("chooses accounts with the same picker, and says in one line that a subscription is reached", async () => {
  reset();
  hub.subscription = true;
  hub.accounts = [
    account("acct-claude", "Claude Max", ["claude-sonnet-4-5"], "subscription"),
    account("acct-openai", "OpenAI", ["gpt-5"]),
  ];
  await using _screen = await render(<AccessKeysSection spaceId={SPACE} />);
  await page.getByRole("button", { name: "New access key" }).click();
  const dialog = page.getByRole("dialog", { name: "New access key" });

  await expect.element(dialog.getByText("Reaches a subscription", { exact: false })).toBeVisible();
  press(dialog.getByRole("button", { name: "Choose accounts" }));
  await dialog.getByRole("combobox", { name: "Search AI accounts" }).fill("open");
  await page.getByRole("option", { name: "OpenAI" }).click();
  await expect.element(dialog.getByRole("button", { name: "Remove OpenAI" })).toBeVisible();
  // Only the OpenAI account is reached: no subscription, no warning; its models only.
  await expect.element(dialog.getByRole("note")).not.toBeInTheDocument();
  await dialog.getByRole("combobox", { name: "Search models" }).click();
  await expect.element(page.getByRole("option", { name: "gpt-5" })).toBeVisible();
  expect(page.getByRole("option", { name: "claude-sonnet-4-5" }).elements()).toHaveLength(0);
});

it("keeps Renew, Edit and Revoke in a key's menu, renews a key without limits, and revokes after a confirmation", async () => {
  reset();
  hub.keys = [accessKey("key-1", "Partner Bob")];
  await using _screen = await render(<AccessKeysSection spaceId={SPACE} />);

  await expect
    .element(page.getByRole("button", { name: "Copy setup for Partner Bob" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Actions for Partner Bob" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Renew Partner Bob" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Edit Partner Bob" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Renew Partner Bob" }).click();
  press(
    page
      .getByRole("dialog", { name: "Renew «Partner Bob»" })
      .getByRole("button", { name: "Renew key" }),
  );
  await expect.poll(() => hub.updated).toEqual([{ keyId: "key-1", validity: { days: 30 } }]);

  await page.getByRole("button", { name: "Actions for Partner Bob" }).click();
  await page.getByRole("menuitem", { name: "Revoke Partner Bob" }).click();
  press(page.getByRole("button", { name: "Revoke key" }));
  await expect.poll(() => hub.revoked).toEqual([{ keyId: "key-1" }]);
});
