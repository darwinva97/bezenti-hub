import type { EnvironmentId, SpaceId } from "@t3tools/contracts";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** A Hub's Spaces and the one new Projects and Threads go to there. */
export interface HomeListSpaceChoice {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly spaces: ReadonlyArray<{ readonly id: SpaceId; readonly name: string }>;
  readonly currentSpaceId: SpaceId | null;
  /** Any signed-in User may create an Organization there (ticket 18). */
  readonly canCreateOrganization?: boolean;
}

/** "Space", or "Space · <Hub>" when several Hubs each have their own. */
export function spaceMenuTitle(choice: HomeListSpaceChoice, choiceCount: number): string {
  return choiceCount > 1 ? `Space · ${choice.environmentLabel}` : "Space";
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

type HomeListFilterMenuAction = {
  readonly type: "action";
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on" | "off";
  readonly onPress: () => void;
};

type HomeListFilterMenuSubmenu = {
  readonly type: "submenu";
  readonly title: string;
  readonly items: HomeListFilterMenuAction[];
};

export interface HomeListFilterMenu {
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
}

export function buildHomeListFilterMenu(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly spaceChoices?: ReadonlyArray<HomeListSpaceChoice>;
  readonly onSpaceChange?: (environmentId: EnvironmentId, spaceId: SpaceId) => void;
  readonly onCreateOrganization?: (environmentId: EnvironmentId) => void;
}): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];

  // The Space selector: where new Projects and Threads go on each Hub.
  const spaceChoices = props.spaceChoices ?? [];
  for (const choice of spaceChoices) {
    items.push({
      type: "submenu",
      title: spaceMenuTitle(choice, spaceChoices.length),
      items: [
        ...choice.spaces.map((space) => ({
          type: "action" as const,
          title: space.name,
          subtitle: "New projects and threads go here",
          state: choice.currentSpaceId === space.id ? ("on" as const) : ("off" as const),
          onPress: () => props.onSpaceChange?.(choice.environmentId, space.id),
        })),
        ...(choice.canCreateOrganization === true && props.onCreateOrganization !== undefined
          ? [
              {
                type: "action" as const,
                title: "Create organization",
                subtitle: "A new Space you run",
                onPress: () => props.onCreateOrganization?.(choice.environmentId),
              },
            ]
          : []),
      ],
    });
  }

  items.push({
    type: "submenu",
    title: "Environment",
    items: [
      {
        type: "action",
        title: "All environments",
        subtitle: "Show threads from every environment",
        state: props.selectedEnvironmentId === null ? "on" : "off",
        onPress: () => props.onEnvironmentChange(null),
      },
      ...props.environments.map((environment) => ({
        type: "action" as const,
        title: environment.label,
        state:
          props.selectedEnvironmentId === environment.environmentId
            ? ("on" as const)
            : ("off" as const),
        onPress: () => props.onEnvironmentChange(environment.environmentId),
      })),
    ],
  });

  if (props.projects.length > 0) {
    items.push({
      type: "submenu",
      title: "Project",
      items: [
        {
          type: "action",
          title: "All projects",
          subtitle: "Show threads from every project",
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return {
    title: "Thread list options",
    items,
  };
}
