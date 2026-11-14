import {
  type ActiveEnvironmentView,
  activeEnvironmentOf,
  makeHubEnvironmentsPoller,
} from "@t3tools/client-runtime/environment/hub-environments";
import {
  type EnvironmentId,
  type HubEnvironmentSummary,
  type ProviderInstanceId,
  previewThreadPlacement,
  type UserId,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { fetchHubEnvironments } from "./hubEnvironments";

export {
  type ActiveEnvironmentView,
  type ThreadEnvironmentState,
  ENVIRONMENT_STATUS_LABELS,
  NEEDS_ENVIRONMENT_LABEL,
  PAUSED_OFFLINE_LABEL,
  SANDBOX_FAILED_LABEL,
  SANDBOX_RETRY_LABEL,
  SANDBOX_STARTING_LABEL,
  activeEnvironmentLabel,
  activeEnvironmentStatusLabel,
  activeEnvironmentOf,
  environmentStatusLabel,
  environmentUnavailableReason,
  noPlacementReason,
  placeableEnvironments,
  providersOnEnvironment,
  shownEnvironmentStatus,
  threadEnvironmentState,
} from "@t3tools/client-runtime/environment/hub-environments";

// One list for every component that shows where Threads run, fetched while any of them is mounted.
const poller = makeHubEnvironmentsPoller({ fetch: fetchHubEnvironments });

/** The Environments the signed-in User may see, the Hub machine first; kept fresh while mounted. */
export function useHubEnvironments(): ReadonlyArray<HubEnvironmentSummary> {
  return useSyncExternalStore(poller.subscribe, poller.snapshot, poller.snapshot);
}

/**
 * One Thread's Active environment, kept live. Re-renders only when its name or status changes,
 * not on every heartbeat of every machine, since each sidebar row asks.
 */
export function useActiveEnvironment(
  environmentId: EnvironmentId | null | undefined,
): ActiveEnvironmentView | null {
  const read = () => JSON.stringify(activeEnvironmentOf(poller.snapshot(), environmentId));
  const key = useSyncExternalStore(poller.subscribe, read, read);
  return JSON.parse(key) as ActiveEnvironmentView | null;
}

/**
 * What a machine offers Threads (its kind, name and providers), kept live like
 * `useActiveEnvironment`: a heartbeat that changes nothing of it re-renders nothing.
 */
export function useEnvironmentOffer(
  environmentId: EnvironmentId | null | undefined,
): Pick<HubEnvironmentSummary, "kind" | "name" | "providers"> | null {
  const read = () => {
    const found = poller.snapshot().find((environment) => environment.id === environmentId);
    return found === undefined
      ? "null"
      : JSON.stringify({ kind: found.kind, name: found.name, providers: found.providers });
  };
  const key = useSyncExternalStore(poller.subscribe, read, read);
  return JSON.parse(key) as Pick<HubEnvironmentSummary, "kind" | "name" | "providers"> | null;
}

/** Whether the list has been read (and the last read did not fail). */
export function useHubEnvironmentsReady(): boolean {
  const read = () => poller.status() === "ready";
  return useSyncExternalStore(poller.subscribe, read, read);
}

/** Why the Hub runs no Sandboxes, from the same list; null while it runs them. */
export function useSandboxesUnavailable(): string | null {
  return useSyncExternalStore(
    poller.subscribe,
    poller.sandboxesUnavailable,
    poller.sandboxesUnavailable,
  );
}

/** Reads the list now, as after asking the Hub to start a Sandbox. */
export function refreshHubEnvironments(): void {
  poller.refresh();
}

/** The last list, for event handlers (a menu being built); empty until something mounted it. */
export function readHubEnvironments(): ReadonlyArray<HubEnvironmentSummary> {
  return poller.snapshot();
}

/** Whether the User sees more machines than the Hub machine, so a Thread's machine is news. */
export function useHasJoinedEnvironments(): boolean {
  const read = () => poller.snapshot().length > 1;
  return useSyncExternalStore(poller.subscribe, read, read);
}

/**
 * Where the Hub will start a new Thread nobody placed (`previewThreadPlacement`), among the
 * `placeableEnvironments` of its Space. The Hub machine is listed only while it runs Threads.
 * A null provider asks where it runs before one is chosen. Null: nowhere.
 */
export function previewDefaultEnvironment(input: {
  readonly environments: ReadonlyArray<HubEnvironmentSummary>;
  readonly preferredEnvironmentId: EnvironmentId | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly userId: UserId | null;
  /** Why the Hub runs no Sandboxes (its list says); a Sandbox then takes nothing, as on the Hub. */
  readonly sandboxesUnavailable?: string | null;
}): EnvironmentId | null {
  const preferred = input.environments.find(
    (environment) => environment.id === input.preferredEnvironmentId,
  );
  const spaceSandbox = input.environments.find((environment) => environment.kind === "sandbox");
  return previewThreadPlacement({
    preferred:
      preferred === undefined
        ? undefined
        : {
            ...preferred,
            // A machine dedicated to the Space is used like its Sandbox (`placeableEnvironments`
            // already kept only the Space's own); the Hub checks `environment.use` either way.
            usable:
              preferred.kind === "hub" ||
              preferred.kind === "sandbox" ||
              preferred.mode === "dedicated" ||
              preferred.ownerUserId === input.userId,
          },
    providerInstanceId: input.providerInstanceId,
    hubMachine: input.environments.some((environment) => environment.kind === "hub"),
    spaceSandbox,
    sandboxesRun: input.sandboxesUnavailable == null,
  });
}

// The Environment chosen for each new Thread, until it is sent.
const choices = new Map<string, EnvironmentId>();
const choiceListeners = new Set<() => void>();

export function chooseHubEnvironment(draftThreadId: string, environmentId: EnvironmentId | null) {
  if (environmentId === null) choices.delete(draftThreadId);
  else choices.set(draftThreadId, environmentId);
  for (const listener of choiceListeners) listener();
}

/** The Environment the User picked for a new Thread; undefined lets the Hub choose. */
export function readHubEnvironmentChoice(draftThreadId: string): EnvironmentId | undefined {
  return choices.get(draftThreadId);
}

const subscribeChoices = (listener: () => void) => {
  choiceListeners.add(listener);
  return () => {
    choiceListeners.delete(listener);
  };
};

export function useHubEnvironmentChoice(draftThreadId: string): EnvironmentId | undefined {
  return useSyncExternalStore(
    subscribeChoices,
    () => choices.get(draftThreadId),
    () => choices.get(draftThreadId),
  );
}
