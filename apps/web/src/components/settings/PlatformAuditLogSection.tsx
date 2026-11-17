import {
  AUDIT_ACTION_LABELS,
  fetchAuditLog,
  fetchInstallationUsers,
} from "@t3tools/client-runtime/spaces/space-directory";
import {
  AuditAction,
  type AuditEntry,
  type AuditLogPage,
  type AuditLogQuery,
  type InstallationUser,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { useEffect, useRef, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { errorMessageOf as messageOf } from "../../lib/errorMessage";
import { runPrimaryHttp } from "../../lib/runtime";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer } from "./settingsLayout";

const ANY = "any";

interface Filters {
  readonly action: AuditAction | typeof ANY;
  readonly actorUserId: string;
  readonly spaceId: string;
}

const queryOf = (filters: Filters, before: string | null): AuditLogQuery => ({
  ...(filters.action === ANY ? {} : { action: filters.action }),
  ...(filters.actorUserId === ANY ? {} : { actorUserId: UserId.make(filters.actorUserId) }),
  ...(filters.spaceId === ANY ? {} : { spaceId: SpaceId.make(filters.spaceId) }),
  ...(before === null ? {} : { before }),
});

const fetchPage = (query: AuditLogQuery) =>
  runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(Effect.flatMap((client) => fetchAuditLog(client, query))),
  );

const labelOf = (space: AuditLogPage["spaces"][number] | undefined) =>
  space === undefined
    ? "Unknown Space"
    : `${space.name ?? "Unnamed Space"}${space.deleted ? " (deleted)" : ""}`;

const actorOf = (entry: AuditEntry) =>
  entry.actor.source === "cli"
    ? entry.actor.displayName === null
      ? "The Hub's shell"
      : `The Hub's shell, as ${entry.actor.displayName}`
    : entry.actor.source === "agent"
      ? `${entry.actor.displayName ?? "The Owner"}'s agent`
      : entry.actor.source === "system"
        ? "T3 Code"
        : (entry.actor.displayName ?? "Unknown User");

/** The Owner's audit log: who did what in the sensitive actions, newest first. */
export function PlatformAuditLogSection() {
  // Every Space the log names, deleted Organizations included, as the server lists them.
  const [spaces, setSpaces] = useState<AuditLogPage["spaces"]>([]);
  // The filters a response was asked for; one that arrives after they changed is dropped.
  const current = useRef<Filters | null>(null);
  const [users, setUsers] = useState<ReadonlyArray<InstallationUser>>([]);
  const [filters, setFilters] = useState<Filters>({ action: ANY, actorUserId: ANY, spaceId: ANY });
  const [entries, setEntries] = useState<ReadonlyArray<AuditEntry> | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Users to filter by from the server when its section opens
  useEffect(() => {
    let cancelled = false;
    void runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(fetchInstallationUsers)))
      .then((list) => {
        if (!cancelled) setUsers(list.users);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the first page from the server whenever the filters change
  useEffect(() => {
    let cancelled = false;
    void fetchPage(queryOf(filters, null)).then(
      (page) => {
        if (cancelled) return;
        current.current = filters;
        setEntries(page.entries);
        setSpaces(page.spaces);
        setNextCursor(page.nextCursor);
      },
      (cause: unknown) => {
        if (!cancelled) setError(messageOf(cause, "Could not load the audit log."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const changeFilters = (next: Filters) => {
    current.current = null;
    setFilters(next);
    setNextCursor(null);
    setEntries(null);
    setError(null);
  };

  const loadOlder = async () => {
    if (nextCursor === null || loadingMore) return;
    const askedFor = filters;
    setLoadingMore(true);
    try {
      const page = await fetchPage(queryOf(askedFor, nextCursor));
      if (current.current !== askedFor) return;
      setEntries((shown) => [...(shown ?? []), ...page.entries]);
      setSpaces(page.spaces);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      if (current.current === askedFor) setError(messageOf(cause, "Could not load older entries."));
    } finally {
      setLoadingMore(false);
    }
  };

  const userName = (userId: string) =>
    users.find((user) => user.id === userId)?.displayName ?? "Unknown User";
  const spaceName = (spaceId: string) => labelOf(spaces.find((space) => space.id === spaceId));

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Audit log</h2>
        <p className="text-sm text-muted-foreground">
          Invitations, Role changes, permanent deletions, Users turned off or removed, and the
          sign-ins you approved. Entries are kept for good.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Select
            value={filters.action}
            onValueChange={(value) =>
              changeFilters({
                ...filters,
                action: (value as Filters["action"] | null) ?? ANY,
              })
            }
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Filter by action">
              <SelectValue>
                {filters.action === ANY ? "Any action" : AUDIT_ACTION_LABELS[filters.action]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={ANY}>
                Any action
              </SelectItem>
              {AuditAction.literals.map((action) => (
                <SelectItem hideIndicator key={action} value={action}>
                  {AUDIT_ACTION_LABELS[action]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={filters.actorUserId}
            onValueChange={(value) =>
              changeFilters({
                ...filters,
                actorUserId: value ?? ANY,
              })
            }
          >
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Filter by User">
              <SelectValue>
                {filters.actorUserId === ANY ? "Anyone" : userName(filters.actorUserId)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={ANY}>
                Anyone
              </SelectItem>
              {users.map((user) => (
                <SelectItem hideIndicator key={user.id} value={user.id}>
                  {user.displayName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={filters.spaceId}
            onValueChange={(value) =>
              changeFilters({
                ...filters,
                spaceId: value ?? ANY,
              })
            }
          >
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Filter by Space">
              <SelectValue>
                {filters.spaceId === ANY ? "Any Space" : spaceName(filters.spaceId)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={ANY}>
                Any Space
              </SelectItem>
              {spaces.map((space) => (
                <SelectItem hideIndicator key={space.id} value={space.id}>
                  {labelOf(space)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        {entries === null ? (
          error === null ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : null
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ul className="flex flex-col divide-y" aria-label="Audit entries">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-0.5 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{AUDIT_ACTION_LABELS[entry.action]}</span>
                  {entry.target.name !== null ? <span>: {entry.target.name}</span> : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {[
                    actorOf(entry),
                    ...(entry.space === null ? [] : [entry.space.name ?? "Deleted Space"]),
                    DateTime.toDate(entry.at).toLocaleString(),
                  ].join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        )}
        {nextCursor !== null && entries !== null ? (
          <Button
            type="button"
            size="compact"
            variant="outline"
            disabled={loadingMore}
            onClick={() => void loadOlder()}
          >
            Load older entries
          </Button>
        ) : null}
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
      </div>
    </SettingsPageContainer>
  );
}
