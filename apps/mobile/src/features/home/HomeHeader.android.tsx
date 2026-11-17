import type { MenuAction } from "@react-native-menu/menu";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { ThreadListToolbar } from "./ThreadListToolbar";
import type { HomeHeaderProps } from "./HomeHeader.types";
import { spaceMenuTitle } from "./home-list-filter-menu";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

export function HomeHeader(props: HomeHeaderProps) {
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null || props.selectedProjectKey !== null;
  const spaceChoices = props.spaceChoices ?? [];
  const menuActions: MenuAction[] = [
    // Ids carry indexes, not ids, since environment and Space ids may contain ":".
    ...spaceChoices.map((choice, choiceIndex) => ({
      id: `space:${choiceIndex}`,
      title: spaceMenuTitle(choice, spaceChoices.length),
      subactions: [
        ...choice.spaces.map((space, spaceIndex) => ({
          id: `space:${choiceIndex}:${spaceIndex}`,
          title: space.name,
          state: checkedMenuState(choice.currentSpaceId === space.id),
        })),
        ...(choice.canCreateOrganization === true && props.onCreateOrganization !== undefined
          ? [{ id: `space:${choiceIndex}:create`, title: "Create organization" }]
          : []),
      ],
    })),
    {
      id: "environment",
      title: "Environment",
      subactions: [
        {
          id: "environment:all",
          title: "All environments",
          state: checkedMenuState(props.selectedEnvironmentId === null),
        },
        ...props.environments.map((environment) => ({
          id: `environment:${environment.environmentId}`,
          title: environment.label,
          state: checkedMenuState(props.selectedEnvironmentId === environment.environmentId),
        })),
      ],
    },
    ...(props.projects.length === 0
      ? []
      : ([
          {
            id: "project",
            title: "Project",
            subactions: [
              {
                id: "project:all",
                title: "All projects",
                state: checkedMenuState(props.selectedProjectKey === null),
              },
              ...props.projects.map((project) => ({
                id: `project:${project.key}`,
                title: project.label,
                state: checkedMenuState(props.selectedProjectKey === project.key),
              })),
            ],
          },
        ] satisfies MenuAction[])),
  ];
  const handleMenuAction = (event: { nativeEvent: { event: string } }) => {
    const id = event.nativeEvent.event;
    const createPick = /^space:(\d+):create$/u.exec(id);
    if (createPick) {
      const choice = spaceChoices[Number(createPick[1])];
      if (choice) props.onCreateOrganization?.(choice.environmentId);
      return;
    }
    const spacePick = /^space:(\d+):(\d+)$/u.exec(id);
    if (spacePick) {
      const choice = spaceChoices[Number(spacePick[1])];
      const space = choice?.spaces[Number(spacePick[2])];
      if (choice && space) props.onSpaceChange?.(choice.environmentId, space.id);
      return;
    }
    if (id === "environment:all") {
      props.onEnvironmentChange(null);
      return;
    }

    if (id.startsWith("environment:")) {
      const environmentId = id.slice("environment:".length);
      const environment = props.environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (environment) {
        props.onEnvironmentChange(environment.environmentId);
      }
      return;
    }

    if (id === "project:all") {
      props.onProjectChange(null);
      return;
    }

    if (id.startsWith("project:")) {
      const projectKey = id.slice("project:".length);
      if (props.projects.some((project) => project.key === projectKey)) {
        props.onProjectChange(projectKey);
      }
      return;
    }
  };

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <ThreadListToolbar
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        filterActions={menuActions}
        filterCustomized={hasCustomListOptions}
        onFilterSelect={(event) => handleMenuAction({ nativeEvent: { event } })}
        onOpenEnvironments={props.onOpenEnvironments}
      />
    </>
  );
}
