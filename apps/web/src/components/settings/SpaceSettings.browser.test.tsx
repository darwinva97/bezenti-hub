import { SpaceId, UserId, type MemberList, type SpaceSummary } from "@t3tools/contracts";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
  useParams,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useCurrentSpace } from "../../state/currentSpace";
import { AppRouteModal } from "../AppRouteModal";
import { startMainAppLocationTracking } from "../sidebar/mainAppLocation";
import { SidebarProvider } from "../ui/sidebar";
import { SpaceSettingsPage } from "./SpaceSettingsPage";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

const memberList: MemberList = {
  members: [
    {
      userId: UserId.make("user-admin"),
      displayName: "Ada Admin",
      role: "admin",
      isYou: false,
      canChangeRole: false,
      canRemove: false,
      pendingAdmin: false,
      canIssueResetLink: false,
      managedByKeycloak: false,
      keycloakGroup: null,
    },
    {
      userId: UserId.make("user-me"),
      displayName: "Mia Member",
      role: "member",
      isYou: true,
      canChangeRole: false,
      canRemove: false,
      pendingAdmin: false,
      canIssueResetLink: false,
      managedByKeycloak: false,
      keycloakGroup: null,
    },
  ],
  assignableRoles: [],
  canLeave: true,
};

/** What the member list answers; a test swaps it and puts it back. */
let served: MemberList = memberList;

vi.mock("../../lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/runtime")>()),
  runPrimaryHttp: () => Promise.resolve(served),
}));

const ACME = SpaceId.make("space-acme");

function organization(canInvite: boolean): SpaceSummary {
  return {
    id: ACME,
    kind: "organization",
    name: "Acme",
    role: canInvite ? "admin" : "member",
    isOwn: false,
    canCreateThreads: true,
    canInvite,
  };
}

/** Makes the Space the only one the viewer has, until the returned handle is disposed. */
function showSpace(space: SpaceSummary): Disposable {
  useCurrentSpace.setState({
    view: {
      userId: UserId.make("user-me"),
      spaces: [space],
      personalSpaceId: SpaceId.make("space-personal"),
      canCreateOrganization: false,
      isOwner: false,
    },
    currentSpaceId: space.id,
  });
  return {
    [Symbol.dispose]: () => useCurrentSpace.setState({ view: null, currentSpaceId: null }),
  };
}

function Frame() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SidebarProvider defaultOpen>
      <AppRouteModal label="Space settings">
        <SettingsSidebarNav pathname={pathname} />
        <Outlet />
      </AppRouteModal>
    </SidebarProvider>
  );
}

function SectionPage() {
  const { spaceId, section } = useParams({ strict: false });
  return <SpaceSettingsPage spaceId={spaceId ?? ""} section={section ?? ""} />;
}

function createFrameRouter(initialEntry: string) {
  const root = createRootRoute({ component: Outlet });
  const opener = createRoute({
    getParentRoute: () => root,
    path: "/opener",
    component: () => <p>Opener</p>,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: Frame,
  });
  const section = createRoute({
    getParentRoute: () => settings,
    path: "/space/$spaceId/$section",
    component: SectionPage,
  });
  return createRouter({
    routeTree: root.addChildren([opener, settings.addChildren([section])]),
    history: createMemoryHistory({ initialEntries: ["/opener", initialEntry] }),
    disableGlobalCatchBoundary: true,
  });
}

it("shows a Member the list without Admin actions, and leaves Invitations out", async () => {
  using _space = showSpace(organization(false));
  const router = createFrameRouter(`/settings/space/${ACME}/members`);
  const stopTracking = startMainAppLocationTracking(router);
  // The frame needs its own route tree, which the shared test router does not have.
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await expect.element(page.getByText("Ada Admin")).toBeVisible();
    await expect.element(page.getByText("Mia Member", { exact: false })).toBeVisible();
    expect(page.getByRole("button", { name: /^Remove/ }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: /reset link/i }).elements()).toHaveLength(0);
    expect(page.getByRole("combobox", { name: /^Role for/ }).elements()).toHaveLength(0);
    // Who cannot invite has no Invitations section; everyone has General and Members.
    expect(page.getByRole("treeitem", { name: "Invitations" }).elements()).toHaveLength(0);
    await expect.element(page.getByRole("treeitem", { name: "General" })).toBeVisible();
    await expect
      .element(page.getByRole("treeitem", { name: "Members" }))
      .toHaveAttribute("aria-current", "page");
  } finally {
    stopTracking();
  }
});

it("lets a Member leave from General, and an Admin reach Invitations", async () => {
  using _space = showSpace(organization(true));
  const router = createFrameRouter(`/settings/space/${ACME}/general`);
  const stopTracking = startMainAppLocationTracking(router);
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await expect.element(page.getByRole("button", { name: "Leave organization" })).toBeVisible();
    // Only the Owner archives, restores or deletes.
    expect(page.getByRole("button", { name: /Archive organization/ }).elements()).toHaveLength(0);
    await expect.element(page.getByRole("treeitem", { name: "Invitations" })).toBeVisible();
  } finally {
    stopTracking();
  }
});

it("makes the Space it opens the current one", async () => {
  const personal: SpaceSummary = {
    id: SpaceId.make("space-personal"),
    kind: "personal",
    name: "Mia",
    role: null,
    isOwn: true,
    canCreateThreads: true,
    canInvite: false,
  };
  using _space = showSpace(personal);
  useCurrentSpace.setState((state) => ({
    view: state.view === null ? null : { ...state.view, spaces: [personal, organization(true)] },
  }));
  const router = createFrameRouter(`/settings/space/${ACME}/members`);
  const stopTracking = startMainAppLocationTracking(router);
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await expect.element(page.getByText("Ada Admin")).toBeVisible();
    await vi.waitFor(() => expect(useCurrentSpace.getState().currentSpaceId).toBe(ACME));
  } finally {
    stopTracking();
  }
});

/** Keycloak sign-in, ticket 05: an Admin's view where a group manages Mia's Membership. */
const managedList: MemberList = {
  members: [
    { ...memberList.members[0]!, isYou: true },
    {
      ...memberList.members[1]!,
      isYou: false,
      managedByKeycloak: true,
      keycloakGroup: "bezenti",
    },
  ],
  assignableRoles: ["member", "guest"],
  canLeave: true,
};

it("shows who a Keycloak group manages, with Role and remove held back and why", async () => {
  served = managedList;
  using _space = showSpace(organization(true));
  const router = createFrameRouter(`/settings/space/${ACME}/members`);
  const stopTracking = startMainAppLocationTracking(router);
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await expect.element(page.getByText("Managed by Keycloak (group bezenti)")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Remove Mia Member" })).toBeDisabled();
    await expect
      .element(page.getByRole("combobox", { name: "Role for Mia Member" }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Remove Mia Member" }))
      .toHaveAccessibleDescription(/Keycloak group/);
  } finally {
    stopTracking();
    served = memberList;
  }
});

it("tells a Member a Keycloak group put in that they leave by leaving the group", async () => {
  served = {
    ...memberList,
    members: [
      memberList.members[0]!,
      { ...memberList.members[1]!, managedByKeycloak: true, keycloakGroup: "bezenti" },
    ],
    canLeave: false,
  };
  using _space = showSpace(organization(false));
  const router = createFrameRouter(`/settings/space/${ACME}/general`);
  const stopTracking = startMainAppLocationTracking(router);
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  try {
    await expect.element(page.getByRole("button", { name: "Leave organization" })).toBeDisabled();
    await expect.element(page.getByText(/you leave it by leaving the group/)).toBeVisible();
  } finally {
    stopTracking();
    served = memberList;
  }
});
