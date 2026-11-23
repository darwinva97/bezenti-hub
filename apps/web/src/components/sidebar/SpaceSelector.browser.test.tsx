import type { SpaceDirectoryView, SpaceSummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useCurrentSpace } from "../../state/currentSpace";
import { SidebarProvider } from "../ui/sidebar";
import { SpaceSelector } from "./SpaceSelector";

// The directory is set by the test; nothing is loaded from a Hub.
vi.mock("../../state/currentSpace", async (original) => ({
  ...(await original<typeof import("../../state/currentSpace")>()),
  loadSpaces: () => Promise.resolve(),
}));

const space = (id: string, name: string, extra: Partial<SpaceSummary> = {}): SpaceSummary => ({
  id: id as SpaceSummary["id"],
  kind: "organization",
  name,
  role: "admin",
  isOwn: false,
  canCreateThreads: true,
  canInvite: true,
  ...extra,
});

const view = (spaces: ReadonlyArray<SpaceSummary>): SpaceDirectoryView => ({
  userId: "adam" as SpaceDirectoryView["userId"],
  personalSpaceId: "personal:adam" as SpaceDirectoryView["personalSpaceId"],
  canCreateOrganization: false,
  spaces,
});

it("shows how many loans wait for the User beside each Space and on the selector (Grants 12)", async () => {
  useCurrentSpace.setState({
    environmentId: null,
    view: view([space("acme", "Acme", { pendingGrants: 2 }), space("globex", "Globex")]),
    currentSpaceId: "globex" as SpaceSummary["id"],
    loadFailed: false,
  });
  await using _screen = await render(
    <SidebarProvider defaultOpen>
      <SpaceSelector />
    </SidebarProvider>,
  );
  const trigger = page.getByRole("button", { name: "Switch Space" });
  await expect.element(trigger.getByLabelText("2 loans waiting for you")).toBeVisible();
  await trigger.click();
  await expect.element(page.getByRole("menuitemradio", { name: /Acme/ })).toBeVisible();
  await expect
    .element(page.getByRole("menuitemradio", { name: /Acme/ }).getByLabelText(/2 loans waiting/))
    .toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: /Loans waiting for you/ })).toBeVisible();
});

it("shows no count to whoever decides on no loan", async () => {
  useCurrentSpace.setState({
    environmentId: null,
    view: view([space("acme", "Acme", { role: "member" })]),
    currentSpaceId: "acme" as SpaceSummary["id"],
    loadFailed: false,
  });
  await using _screen = await render(
    <SidebarProvider defaultOpen>
      <SpaceSelector />
    </SidebarProvider>,
  );
  await expect.element(page.getByRole("button", { name: "Switch Space" })).toBeVisible();
  await expect.element(page.getByLabelText(/waiting for you/)).not.toBeInTheDocument();
});
