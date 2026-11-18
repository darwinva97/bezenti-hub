import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { GrantOfferSurface } from "./GrantOfferSurface";

const offer = vi.hoisted(() => ({
  account: { hasPasskey: false, hasPassword: true, totpEnrolled: false } as Record<string, boolean>,
  claims: [] as Array<{ readonly input: unknown; readonly stepUp: unknown }>,
  wsClaims: [] as Array<unknown>,
  navigations: [] as Array<unknown>,
}));

vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "env-primary",
  useEnvironment: () => ({ connection: { phase: "connected" } }),
}));
vi.mock("./grantOfferLink", () => ({
  takeGrantOfferToken: () => "link-token",
  forgetGrantOfferToken: () => {},
}));
vi.mock("../../state/grants", () => ({ grantsEnvironment: { readOffer: {}, claimOffer: {} } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (_command: unknown, label: string) => (target?: { readonly input?: unknown }) => {
    if (label === "apply a lending link") {
      offer.wsClaims.push(target?.input);
      return Promise.resolve({ _tag: "Success", value: {} });
    }
    return Promise.resolve({
      _tag: "Success",
      value: {
        status: "valid",
        resource: { kind: "environment", name: "Ana's box" },
        lender: { kind: "user", name: "Ana" },
        limits: {
          kind: "environment",
          cpus: 2,
          memoryBytes: 4 * 1024 ** 3,
          pids: 4096,
          diskBytes: 20 * 1024 ** 3,
        },
        expiresAt: "2026-11-25T00:00:00.000Z",
        spaces: [
          { spaceId: "org-acme", kind: "organization", name: "Acme", alreadyGranted: false },
        ],
      },
    });
  },
}));
vi.mock("../../environments/primary/userAccounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary/userAccounts")>()),
  fetchAccount: () => Promise.resolve(offer.account),
}));
vi.mock("../../environments/primary/grants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary/grants")>()),
  claimGrantOffer: (input: unknown, stepUp: unknown) => {
    offer.claims.push({ input, stepUp });
    return Promise.resolve({});
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => (to: unknown) => {
    offer.navigations.push(to);
    return Promise.resolve();
  },
}));

const chooseAcme = async () => {
  await page.getByRole("combobox", { name: "Lend it to" }).click();
  await page.getByRole("option", { name: /Acme/ }).click();
};

// Grants ticket 15: a machine's lending link is applied with the decider's strong factor.
it("tells an account with no passkey or authenticator app to add one, and keeps Accept off", async () => {
  offer.account = { hasPasskey: false, hasPassword: true, totpEnrolled: false };
  offer.navigations = [];
  await using _screen = await render(<GrantOfferSurface signedIn />);
  await expect.element(page.getByText(/Ana lends you Ana's box/)).toBeVisible();
  await expect
    .element(page.getByText(/Ana controls this machine and can see everything that runs on it/))
    .toBeVisible();
  await chooseAcme();
  await expect
    .element(
      page.getByText(
        /To accept a machine, add a passkey or an authenticator app to your account first./,
      ),
    )
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Confirm and accept" })).toBeDisabled();
  await expect.element(page.getByText("Current password")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Open Settings → Account" }).click();
  expect(offer.navigations).toEqual([
    { to: "/settings/user/$section", params: { section: "account" } },
  ]);
});

it("applies a machine's link over HTTP with the passkey, never over the socket", async () => {
  offer.account = { hasPasskey: true, hasPassword: true, totpEnrolled: false };
  offer.claims = [];
  offer.wsClaims = [];
  await using _screen = await render(<GrantOfferSurface signedIn />);
  await chooseAcme();
  await expect.element(page.getByText(/You will confirm it's you with your passkey/)).toBeVisible();
  const accept = page.getByRole("button", { name: "Confirm and accept" });
  await expect.element(accept).toBeEnabled();
  await accept.click();
  await expect
    .element(page.getByText(/Lent to Acme: its Threads can run in a Sandbox/))
    .toBeVisible();
  expect(offer.claims).toEqual([
    { input: { token: "link-token", spaceId: "org-acme" }, stepUp: { method: "passkey" } },
  ]);
  expect(offer.wsClaims).toEqual([]);
});
