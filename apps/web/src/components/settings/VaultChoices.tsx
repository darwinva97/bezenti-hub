import { fetchInstallationUsers } from "@t3tools/client-runtime/spaces/space-directory";
import { threadSecretLines } from "@t3tools/client-runtime/vaults";
import type {
  EnvironmentId,
  InstallationUser,
  ProjectId,
  SpaceId,
  ThreadId,
  VaultChoices,
  VaultGroupId,
  VaultSubject,
  VaultGroupSummary,
  VaultThreadEnvironment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { PrimaryEnvironmentHttpClient } from "../../environments/primary/httpClient";
import { errorMessageOf } from "../../lib/errorMessage";
import { runPrimaryHttp } from "../../lib/runtime";
import { useCurrentSpace } from "../../state/currentSpace";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { settle } from "./vaultCommands";

// Spec 5 ticket 03: allowing Vaults (the Owner), a Space's defaults and a Project's choices (the
// Owner and the Space's Admins), and the names a Thread receives. Never values.

/** Shown before a Vault is allowed to a User: ADR 0004, nothing isolates a Space's processes. */
const USER_ALLOWANCE_RISK =
  "Only this User's turns, terminals and scripts receive it, but in a shared Sandbox other agents of the same Space can read a running process's environment.";
const UNDERSTOOD = "I understand other agents in a shared Sandbox can read it";

const subjectKey = (subject: VaultSubject) =>
  subject.kind === "space" ? `space:${subject.spaceId}` : `user:${subject.userId}`;

/** Whom one of the Owner's own Vaults is allowed to; the Owner adds and takes back. */
export function VaultAllowances(props: {
  readonly environmentId: EnvironmentId;
  readonly vault: VaultGroupSummary;
  readonly onChanged: () => Promise<void>;
}) {
  const { vault, environmentId } = props;
  const allow = useAtomCommand(serverEnvironment.allowVault, "allow a Vault");
  const spaces = useCurrentSpace((state) => state.view?.spaces ?? []);
  const [users, setUsers] = useState<ReadonlyArray<InstallationUser>>([]);
  const [choice, setChoice] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Installation's Users, whom the Owner may allow the Vault to.
  useEffect(() => {
    let cancelled = false;
    void runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(fetchInstallationUsers)))
      .then((list) => {
        if (!cancelled) setUsers(list.users.filter((user) => user.status !== "removed"));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const allowed = new Set(vault.allowances.map((allowance) => subjectKey(allowance.subject)));
  const options: ReadonlyArray<{
    readonly key: string;
    readonly subject: VaultSubject;
    readonly label: string;
  }> = [
    ...spaces.map((space) => ({
      key: `space:${space.id}`,
      subject: { kind: "space", spaceId: space.id } as const,
      label: `Space: ${space.name}`,
    })),
    ...users.map((user) => ({
      key: `user:${user.id}`,
      subject: { kind: "user", userId: user.id } as const,
      label: `User: ${user.displayName}`,
    })),
  ].filter((option) => !allowed.has(option.key));
  const allowItems = options.map((option) => ({ value: option.key, label: option.label }));
  // An option that dropped out (allowed elsewhere meanwhile) leaves the placeholder.
  const picked = options.find((option) => option.key === choice);
  const toUser = picked?.subject.kind === "user";

  const change = async (subject: VaultSubject, isAllowed: boolean) => {
    setPending(true);
    setError(null);
    try {
      await settle(
        allow({ environmentId, input: { vaultId: vault.id, subject, allowed: isAllowed } }),
      );
      setChoice("");
      setUnderstood(false);
      await props.onChanged();
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not change whom the Vault is allowed to."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 px-4 pb-4">
      <p className="text-xs font-medium">Allowed to</p>
      {vault.allowances.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nobody yet: no Space or User receives this Vault.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label={`Allowed to: ${vault.name}`}>
          {vault.allowances.map((allowance) => {
            const name = allowance.name ?? "(gone)";
            return (
              <li key={subjectKey(allowance.subject)} className="flex items-center gap-1">
                <Badge variant="outline" size="sm">
                  {allowance.subject.kind === "user" ? `User: ${name}` : `Space: ${name}`}
                </Badge>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending}
                  aria-label={`Take back ${vault.name} from ${name}`}
                  onClick={() => void change(allowance.subject, false)}
                >
                  Take back
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium">
          Allow to
          <Select
            disabled={pending}
            items={allowItems}
            value={picked === undefined ? null : choice}
            onValueChange={(value) => {
              setChoice(value ?? "");
              setUnderstood(false);
            }}
          >
            <SelectTrigger aria-label={`Allow ${vault.name} to`}>
              <SelectValue placeholder="Choose a Space or a User…" />
            </SelectTrigger>
            <SelectPopup>
              {allowItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <Button
          size="sm"
          disabled={pending || picked === undefined || (toUser && !understood)}
          aria-label={`Allow ${vault.name}`}
          onClick={() => {
            if (picked !== undefined) void change(picked.subject, true);
          }}
        >
          Allow
        </Button>
      </div>
      {toUser ? (
        <div className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/8 p-2">
          <p className="text-xs" role="note">
            {USER_ALLOWANCE_RISK}
          </p>
          <label className="flex items-center gap-2 text-xs font-medium">
            <Checkbox
              aria-label={UNDERSTOOD}
              checked={understood}
              onCheckedChange={(checked) => setUnderstood(checked === true)}
            />
            {UNDERSTOOD}
          </label>
        </div>
      ) : null}
      {error === null ? null : (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function useChoices(environmentId: EnvironmentId, spaceId: SpaceId | null, projectId?: ProjectId) {
  const read = useAtomCommand(serverEnvironment.vaultChoices, "read a Space's Vaults");
  const [loaded, setLoaded] = useState<{
    readonly spaceId: SpaceId;
    readonly choices: VaultChoices;
  } | null>(null);
  const [failed, setFailed] = useState<{
    readonly spaceId: SpaceId | null;
    readonly message: string;
  } | null>(null);
  // What another Space answered, or how it failed, is never shown for this one.
  const choices = loaded !== null && loaded.spaceId === spaceId ? loaded.choices : null;
  const error = failed !== null && failed.spaceId === spaceId ? failed.message : null;
  const setError = (message: string | null) =>
    setFailed(message === null ? null : { spaceId, message });
  const setChoices = (next: VaultChoices) => setLoaded({ spaceId: next.spaceId, choices: next });
  const load = useEffectEvent(async (space: SpaceId) =>
    settle(
      read({
        environmentId,
        input: projectId === undefined ? { spaceId: space } : { spaceId: space, projectId },
      }),
    ),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Space's (and Project's) Vault choices from the Hub when the Space changes.
  useEffect(() => {
    if (spaceId === null) return;
    let cancelled = false;
    void load(spaceId).then(
      (next) => {
        if (!cancelled) setLoaded({ spaceId, choices: next });
      },
      (cause: unknown) => {
        if (!cancelled) {
          setFailed({ spaceId, message: errorMessageOf(cause, "Could not read the Vaults.") });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [spaceId]);
  return { choices, setChoices, error, setError };
}

/**
 * Settings → Vaults → «Default groups»: which groups reaching a Space every Thread of it receives
 * (owned-resources 03). The Space's owner's `default` always; the others when chosen.
 */
export function SpaceDefaultVaults(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const view = useCurrentSpace((state) => state.view);
  const spaces = view?.spaces ?? [];
  const [spaceId, setSpaceId] = useState<SpaceId | null>(null);
  const shown = spaceId ?? spaces[0]?.id ?? null;
  const { choices, setChoices, error, setError } = useChoices(environmentId, shown);
  const save = useAtomCommand(serverEnvironment.setVaultSpaceDefaults, "set default Vaults");
  const [pending, setPending] = useState(false);
  if (spaces.length === 0) return null;
  const spaceItems = spaces.map((space) => ({ value: space.id as string, label: space.name }));
  const shownListed = spaces.some((space) => space.id === shown);
  const spaceName = spaces.find((space) => space.id === shown)?.name ?? "this Space";

  const setDefaults = async (vaultIds: ReadonlyArray<VaultGroupId>) => {
    if (shown === null) return;
    setPending(true);
    setError(null);
    try {
      setChoices(await settle(save({ environmentId, input: { spaceId: shown, vaultIds } })));
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not change the default Vaults."));
    } finally {
      setPending(false);
    }
  };
  const defaults = choices?.defaults ?? [];
  const byId = new Map((choices?.allowed ?? []).map((option) => [option.vaultId, option]));
  const ordered = [
    ...(choices?.fixedDefaults ?? []),
    ...defaults,
    ...(choices?.allowed ?? [])
      .map((option) => option.vaultId)
      .filter((id) => !defaults.includes(id) && !(choices?.fixedDefaults ?? []).includes(id)),
  ];

  return (
    <SettingsSection id="default-vaults" title="Default groups">
      <SettingsRow
        title="Every Thread of a Space receives its defaults"
        description="A Space's own default group always; other groups that reach it when chosen here. Projects add or remove groups among the ones reaching their Space. When two groups define the same name, a group allowed to you wins, then the Project's, then the defaults in this order."
        status={
          error === null ? null : (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          )
        }
        control={
          <div className="w-full sm:w-56">
            <Select
              items={spaceItems}
              value={shownListed ? shown : null}
              onValueChange={(value) => {
                if (value !== null) setSpaceId(value as SpaceId);
              }}
            >
              <SelectTrigger aria-label="Space for default Vaults">
                <SelectValue placeholder="Choose a Space" />
              </SelectTrigger>
              <SelectPopup>
                {spaceItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        }
      />
      {choices === null ? null : choices.allowed.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">No group reaches {spaceName} yet.</p>
      ) : (
        <ul
          className="flex flex-col divide-y divide-border/60"
          aria-label={`Default Vaults of ${spaceName}`}
        >
          {ordered.map((vaultId) => {
            const option = byId.get(vaultId);
            if (option === undefined) return null;
            const fixed = choices.fixedDefaults.includes(vaultId);
            const index = defaults.indexOf(vaultId);
            const isDefault = fixed || index >= 0;
            return (
              <li key={vaultId} className="flex items-center gap-3 px-4 py-2 text-sm">
                <label className="flex flex-1 items-center gap-2">
                  <Checkbox
                    aria-label={`Default: ${option.name}`}
                    checked={isDefault}
                    disabled={
                      fixed || pending || !choices.canChoose || (option.archived && !isDefault)
                    }
                    onCheckedChange={(checked) =>
                      void setDefaults(
                        checked === true
                          ? [...defaults, vaultId]
                          : defaults.filter((id) => id !== vaultId),
                      )
                    }
                  />
                  <span className="font-medium">{option.name}</span>
                  {option.ownerName === null ? null : (
                    <span className="text-xs text-muted-foreground">{option.ownerName}</span>
                  )}
                  <span className="truncate text-xs text-muted-foreground">
                    {option.names.join(", ") || "no secrets yet"}
                  </span>
                  {fixed ? (
                    <Badge size="sm" variant="outline">
                      Always
                    </Badge>
                  ) : null}
                  {option.archived ? (
                    <Badge size="sm" variant="outline">
                      Archived
                    </Badge>
                  ) : null}
                </label>
                {index > 0 && choices.canChoose ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={pending}
                    aria-label={`Move ${option.name} up`}
                    onClick={() => {
                      const next = [...defaults];
                      next.splice(index - 1, 0, ...next.splice(index, 1));
                      void setDefaults(next);
                    }}
                  >
                    Move up
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </SettingsSection>
  );
}

/** Project settings → «Vaults»: add or remove, for this Project, Vaults allowed to its Space. */
export function ProjectVaults(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly spaceId: SpaceId;
}) {
  const { environmentId, projectId, spaceId } = props;
  const { choices, setChoices, error, setError } = useChoices(environmentId, spaceId, projectId);
  const save = useAtomCommand(serverEnvironment.setVaultProjectChoice, "change a Project's Vaults");
  const [pending, setPending] = useState(false);
  if (choices === null) {
    return error === null ? null : (
      <SettingsSection title="Vaults">
        <SettingsRow
          title="Secrets this Project's Threads receive"
          status={
            <span className="text-destructive" role="alert">
              {error}
            </span>
          }
        />
      </SettingsSection>
    );
  }
  if (choices.allowed.length === 0) return null;
  const isDefault = (vaultId: VaultGroupId) =>
    choices.fixedDefaults.includes(vaultId) || choices.defaults.includes(vaultId);
  return (
    <SettingsSection title="Vaults">
      <SettingsRow
        title="Secrets this Project's Threads receive"
        description="Its Space's default groups, plus the ones you add here, minus the ones you remove. A group added here wins a name it shares with a default."
        status={
          error === null ? null : (
            <span className="text-destructive" role="alert">
              {error}
            </span>
          )
        }
      />
      <ul className="flex flex-col divide-y divide-border/60" aria-label="Project Vaults">
        {choices.allowed.map((option) => {
          const current =
            choices.projectChoices.find((choice) => choice.vaultId === option.vaultId)?.choice ??
            "inherit";
          const choiceItems = [
            {
              value: "inherit",
              label: isDefault(option.vaultId)
                ? "As the Space (default)"
                : "As the Space (not a default)",
            },
            { value: "add", label: "Add" },
            { value: "remove", label: "Remove" },
          ];
          return (
            <li key={option.vaultId} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="flex-1 font-medium">
                {option.name}
                {option.ownerName === null ? null : (
                  <span className="ms-2 text-xs font-normal text-muted-foreground">
                    {option.ownerName}
                  </span>
                )}
              </span>
              {choices.fixedDefaults.includes(option.vaultId) ? (
                <span className="text-xs text-muted-foreground">Always (its default group)</span>
              ) : (
                <div className="w-full sm:w-56">
                  <Select
                    disabled={pending || !choices.canChoose}
                    items={choiceItems}
                    value={current}
                    onValueChange={(value) => {
                      if (value === null) return;
                      const choice = value as "add" | "remove" | "inherit";
                      setPending(true);
                      setError(null);
                      void settle(
                        save({
                          environmentId,
                          input: { projectId, vaultId: option.vaultId, choice },
                        }),
                      )
                        .then(setChoices, (cause: unknown) =>
                          setError(errorMessageOf(cause, "Could not change the Project's Vaults.")),
                        )
                        .finally(() => setPending(false));
                    }}
                  >
                    <SelectTrigger aria-label={`${option.name} in this Project`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {choiceItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}

/** The Thread's «Secrets»: the names its turns receive for you, and which Vault wins each. */
export function ThreadSecrets(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const read = useAtomCommand(serverEnvironment.threadVaultEnvironment, "read a Thread's secrets");
  const [answer, setAnswer] = useState<{
    readonly threadId: ThreadId;
    readonly request: number;
    readonly shown: VaultThreadEnvironment | null;
    readonly error: string | null;
  } | null>(null);
  const latest = useRef(0);
  // Another Thread's answer, or one a newer request replaced, is never shown.
  const current = answer !== null && answer.threadId === props.threadId ? answer : null;
  const shown = current?.shown ?? null;
  const error = current?.error ?? null;
  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) return;
        const { threadId } = props;
        const request = ++latest.current;
        setAnswer(null);
        const settleWith = (next: {
          readonly shown: VaultThreadEnvironment | null;
          readonly error: string | null;
        }) => {
          if (request === latest.current) setAnswer({ threadId, request, ...next });
        };
        void settle(read({ environmentId: props.environmentId, input: { threadId } })).then(
          (loaded) => settleWith({ shown: loaded, error: null }),
          (cause: unknown) =>
            settleWith({
              shown: null,
              error: errorMessageOf(cause, "Could not read the Thread's secrets."),
            }),
        );
      }}
    >
      <PopoverTrigger
        render={
          <Button size="xs" variant="ghost-muted" aria-label="Secrets">
            <KeyRoundIcon aria-hidden />
            Secrets
          </Button>
        }
      />
      <PopoverPopup className="w-96">
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-medium">Secrets</p>
          <p className="text-xs text-muted-foreground">
            The environment variables your turns, terminals and scripts in this Thread receive, by
            group and whose Vault it is part of. Variables show their value; Secrets never do.
          </p>
          {error !== null ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : shown === null ? null : shown.variables.length === 0 ? (
            shown.aiCredential == null ? (
              <p className="text-xs text-muted-foreground">This Thread receives no secrets.</p>
            ) : null
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Secrets this Thread receives">
              {threadSecretLines(shown).map((line) => (
                <li key={line.name} className="flex flex-col">
                  <span>
                    <code className="font-mono text-xs">{line.name}</code>
                    {line.value === null ? null : (
                      <code
                        aria-label={`Value of ${line.name}`}
                        className="ms-1 rounded bg-muted px-1 font-mono text-xs break-all"
                      >
                        {line.value}
                      </code>
                    )}{" "}
                    <span className="text-xs text-muted-foreground">from {line.from}</span>
                  </span>
                  {line.winsOver === null ? null : (
                    <span className="text-xs text-muted-foreground">Wins over {line.winsOver}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {shown?.aiCredential == null ? null : (
            <p className="text-xs" aria-label="AI account credential">
              <code className="font-mono text-xs">{shown.aiCredential.name}</code>{" "}
              <span className="text-muted-foreground">
                AI account credential, from {shown.aiCredential.aiAccountName}: only the agent
                receives it, never terminals or scripts.
              </span>
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
