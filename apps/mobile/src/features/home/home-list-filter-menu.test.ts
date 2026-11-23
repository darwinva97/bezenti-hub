import type { SpaceSelection } from "@t3tools/client-runtime/spaces/space-selection";
import { EnvironmentId, SpaceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHomeListFilterMenu, spaceChoiceOf } from "./home-list-filter-menu";

const hub = { environmentId: EnvironmentId.make("hub"), environmentLabel: "Hub" };
const acme = SpaceId.make("space-acme");
const personal = SpaceId.make("space-personal");

const selection = (pending: { readonly acme?: number; readonly personal?: number }) =>
  ({
    view: {
      spaces: [
        {
          id: acme,
          kind: "organization",
          name: "Acme",
          ...(pending.acme === undefined ? {} : { pendingGrants: pending.acme }),
        },
        {
          id: personal,
          kind: "personal",
          name: "Personal",
          ...(pending.personal === undefined ? {} : { pendingGrants: pending.personal }),
        },
      ],
      canCreateOrganization: false,
    },
    currentSpaceId: acme,
    loadFailed: false,
  }) as unknown as SpaceSelection;

const spaceTitles = (choice: ReturnType<typeof spaceChoiceOf>) => {
  const menu = buildHomeListFilterMenu({
    environments: [],
    projects: [],
    selectedEnvironmentId: null,
    selectedProjectKey: null,
    onEnvironmentChange: () => undefined,
    onProjectChange: () => undefined,
    spaceChoices: choice === null ? [] : [choice],
  });
  const spaces = menu.items[0];
  return spaces?.type === "submenu" ? spaces.items.map((item) => item.title) : [];
};

describe("the Space selector on mobile", () => {
  it("shows beside each Space the loans waiting there for the viewer", () => {
    expect(spaceTitles(spaceChoiceOf(hub, selection({ acme: 2, personal: 1 })))).toEqual([
      "Acme · 2 loans waiting",
      "Personal · 1 loan waiting",
    ]);
  });

  it("shows no count where the directory gives none (the viewer does not decide there)", () => {
    expect(spaceTitles(spaceChoiceOf(hub, selection({ personal: 0 })))).toEqual([
      "Acme",
      "Personal",
    ]);
  });

  it("lists nothing for a Hub without a directory", () => {
    expect(spaceChoiceOf(hub, undefined)).toBeNull();
  });
});
