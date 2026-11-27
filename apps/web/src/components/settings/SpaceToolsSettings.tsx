import { spaceLabel } from "@t3tools/client-runtime/grants-view";
import {
  commandLineOf,
  emptyMcpForm,
  mcpConfigOf,
  mcpFormOf,
  type SpaceMcpForm,
  sourceText,
} from "@t3tools/client-runtime/space-tools-view";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GrantTarget,
  SpaceId,
  SpaceMcpSearchResult,
  SpaceMcpSource,
  SpaceMcpSummary,
  SpaceSkillFiles,
  SpaceSkillSummary,
  SpaceToolsList,
} from "@t3tools/contracts";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { giveGrant } from "../../environments/primary/grants";
import { errorMessageOf } from "../../lib/errorMessage";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { grantsEnvironment } from "../../state/grants";
import { spaceToolsEnvironment } from "../../state/spaceTools";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { InfoTip } from "./InfoTip";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsSpace } from "./useSettingsSpace";

type Tool =
  | { readonly kind: "mcp"; readonly row: SpaceMcpSummary }
  | { readonly kind: "skill"; readonly row: SpaceSkillSummary };

const refOf = (tool: Tool) =>
  tool.kind === "mcp"
    ? ({ kind: "mcp", id: tool.row.id } as const)
    : ({ kind: "skill", id: tool.row.id } as const);

const failureText = (result: AtomCommandResult<unknown, unknown>, fallback: string) =>
  result._tag === "Success" ? null : errorMessageOf(squashAtomCommandFailure(result), fallback);

/** Space settings → MCP servers & Skills. */
export function SpaceToolsSection() {
  const space = useSettingsSpace();
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {space === null || environmentId === null ? null : (
        <SpaceToolsPanel environmentId={environmentId} spaceId={space.id} />
      )}
    </SettingsPageContainer>
  );
}

function SpaceToolsPanel({
  environmentId,
  spaceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
}) {
  const list = useAtomCommand(spaceToolsEnvironment.list, "list MCP servers and Skills");
  const setEnabled = useAtomCommand(spaceToolsEnvironment.setEnabled, "turn it on or off");
  const remove = useAtomCommand(spaceToolsEnvironment.remove, "delete it");
  const [listed, setListed] = useState<SpaceToolsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editingMcp, setEditingMcp] = useState<SpaceMcpSummary | "new" | null>(null);
  const [editingSkill, setEditingSkill] = useState<SpaceSkillSummary | "new" | null>(null);
  const [lending, setLending] = useState<Tool | null>(null);
  const [deleting, setDeleting] = useState<Tool | null>(null);

  const show = (result: Awaited<ReturnType<typeof list>>) => {
    if (result._tag === "Success") {
      setListed(result.value);
      setError(null);
    } else {
      setError(failureText(result, "Could not read them."));
    }
  };
  const applyFirst = useEffectEvent(show);
  const loadFirst = useEffectEvent((target: EnvironmentId, space: SpaceId) =>
    list({ environmentId: target, input: { spaceId: space } }),
  );
  const reload = async () => show(await list({ environmentId, input: { spaceId } }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Space's MCP servers and Skills from the Hub when the section opens.
  useEffect(() => {
    let cancelled = false;
    void loadFirst(environmentId, spaceId).then((result) => {
      if (!cancelled) applyFirst(result);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, spaceId]);

  const act = async (run: () => Promise<AtomCommandResult<unknown, unknown>>, fallback: string) => {
    setPending(true);
    const result = await run();
    setPending(false);
    const problem = failureText(result, fallback);
    if (problem === null) await reload();
    else setError(problem);
    return problem === null;
  };

  const canManage = listed?.canManage === true;
  const rowsOf = (tools: ReadonlyArray<Tool>, label: string) =>
    tools.length === 0 ? (
      <p className="px-4 py-3 text-sm text-muted-foreground">{`No ${label} yet.`}</p>
    ) : (
      <ul aria-label={label} className="divide-y divide-border/50">
        {tools.map((tool) => (
          <ToolRow
            key={tool.row.id}
            tool={tool}
            disabled={pending}
            onEdit={
              canManage && tool.row.lent === undefined
                ? () => (tool.kind === "mcp" ? setEditingMcp(tool.row) : setEditingSkill(tool.row))
                : null
            }
            onToggle={
              canManage && tool.row.lent === undefined
                ? () =>
                    void act(
                      () =>
                        setEnabled({
                          environmentId,
                          input: { tool: refOf(tool), enabled: !tool.row.enabled },
                        }),
                      "Could not change it.",
                    )
                : null
            }
            onLend={canManage && tool.row.lent === undefined ? () => setLending(tool) : null}
            onDelete={canManage && tool.row.lent === undefined ? () => setDeleting(tool) : null}
          />
        ))}
      </ul>
    );

  return (
    <>
      <SettingsSection
        id="mcp-servers"
        title="MCP servers"
        titleAction={
          <InfoTip label="About MCP servers">
            {
              "Every Thread of this Space gets these MCP servers. Put tokens in the Vault and write ${NAME} where they go: each Thread fills them in from what it receives, and a server missing one is left out of that Thread."
            }
          </InfoTip>
        }
        headerAction={
          canManage ? (
            <Button size="xs" onClick={() => setEditingMcp("new")}>
              <PlusIcon />
              Add MCP server
            </Button>
          ) : null
        }
      >
        {error === null ? null : (
          <p className="px-4 py-3 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        {listed === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
        ) : (
          rowsOf(
            listed.mcps.map((row) => ({ kind: "mcp", row })),
            "MCP servers",
          )
        )}
      </SettingsSection>
      <SettingsSection
        id="skills"
        title="Skills"
        titleAction={
          <InfoTip label="About Skills">
            Claude receives this Space's Skills in every Thread, shown as space:name. A Skill holds
            no Secrets; it may list the Vault names it expects.
          </InfoTip>
        }
        headerAction={
          canManage ? (
            <Button size="xs" onClick={() => setEditingSkill("new")}>
              <PlusIcon />
              Add Skill
            </Button>
          ) : null
        }
      >
        {listed === null
          ? null
          : rowsOf(
              listed.skills.map((row) => ({ kind: "skill", row })),
              "Skills",
            )}
      </SettingsSection>
      {editingMcp === null ? null : (
        <McpDialog
          environmentId={environmentId}
          spaceId={spaceId}
          editing={editingMcp === "new" ? null : editingMcp}
          onClose={() => setEditingMcp(null)}
          onSaved={() => {
            setEditingMcp(null);
            void reload();
          }}
        />
      )}
      {editingSkill === null ? null : (
        <SkillDialog
          environmentId={environmentId}
          spaceId={spaceId}
          editing={editingSkill === "new" ? null : editingSkill}
          onClose={() => setEditingSkill(null)}
          onSaved={() => {
            setEditingSkill(null);
            void reload();
          }}
        />
      )}
      {lending === null ? null : (
        <LendToolDialog
          environmentId={environmentId}
          tool={lending}
          onClose={() => setLending(null)}
        />
      )}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleting(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete «{deleting?.row.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              This Space's Threads stop receiving it from their next turn, and every Space it is
              lent to loses it. To stop it for a while, turn it off instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pending || deleting === null}
              onClick={() => {
                if (deleting === null) return;
                void act(
                  () => remove({ environmentId, input: { tool: refOf(deleting) } }),
                  "Could not delete it.",
                ).then(() => setDeleting(null));
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function ToolRow(props: {
  readonly tool: Tool;
  readonly disabled: boolean;
  readonly onEdit: (() => void) | null;
  readonly onToggle: (() => void) | null;
  readonly onLend: (() => void) | null;
  readonly onDelete: (() => void) | null;
}) {
  const { tool } = props;
  const { row } = tool;
  const detail =
    tool.kind === "mcp"
      ? tool.row.transport === "stdio"
        ? "Runs a command"
        : "Over HTTP"
      : tool.row.description;
  const expects =
    tool.kind === "skill" && tool.row.expects.length > 0
      ? `Expects ${tool.row.expects.join(", ")}`
      : null;
  const hasMenu = props.onEdit !== null || props.onLend !== null || props.onDelete !== null;
  return (
    <li
      aria-label={row.name}
      className="flex flex-col gap-2 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:gap-4 sm:px-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium">{row.name}</span>
          {row.enabled ? null : (
            <Badge variant="secondary" size="sm">
              Off
            </Badge>
          )}
          {row.lent === undefined ? null : (
            <Badge variant="info" size="sm">
              {`Lent by ${row.lent.lenderName}`}
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{detail}</span>
        {tool.kind === "mcp" && tool.row.source !== undefined ? (
          <span className="text-xs text-muted-foreground">{sourceText(tool.row.source)}</span>
        ) : null}
        {expects === null ? null : <span className="text-xs text-muted-foreground">{expects}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {props.onToggle === null ? null : (
          <Button
            size="xs"
            variant="outline"
            disabled={props.disabled}
            aria-label={`${row.enabled ? "Turn off" : "Turn on"} ${row.name}`}
            onClick={props.onToggle}
          >
            {row.enabled ? "Turn off" : "Turn on"}
          </Button>
        )}
        {hasMenu ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={`Actions for ${row.name}`}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end" sideOffset={6}>
              {props.onEdit === null ? null : <MenuItem onClick={props.onEdit}>Edit…</MenuItem>}
              {props.onLend === null ? null : <MenuItem onClick={props.onLend}>Lend…</MenuItem>}
              {props.onDelete === null ? null : (
                <MenuItem variant="destructive" onClick={props.onDelete}>
                  Delete…
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
    </li>
  );
}

function McpDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly editing: SpaceMcpSummary | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const getMcp = useAtomCommand(spaceToolsEnvironment.getMcp, "read the MCP server");
  const putMcp = useAtomCommand(spaceToolsEnvironment.putMcp, "save the MCP server");
  const [name, setName] = useState(props.editing?.name ?? "");
  const [form, setForm] = useState<SpaceMcpForm | null>(
    props.editing === null ? emptyMcpForm : null,
  );
  const [source, setSource] = useState<SpaceMcpSource | null>(null);
  const [needs, setNeeds] = useState<ReadonlyArray<string>>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const choose = (result: SpaceMcpSearchResult) => {
    setName(result.name);
    setForm(mcpFormOf(result.config));
    setSource(result.source);
    setNeeds(result.secrets);
    setError(null);
  };
  const draft = form === null ? null : mcpConfigOf(form);

  const editingId = props.editing?.id ?? null;
  const readFirst = useEffectEvent((id: SpaceMcpSummary["id"]) =>
    getMcp({ environmentId: props.environmentId, input: { id } }),
  );
  const applyRead = useEffectEvent((result: Awaited<ReturnType<typeof getMcp>>) => {
    if (result._tag === "Success") setForm(mcpFormOf(result.value.config));
    else setError(failureText(result, "Could not read its settings."));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's settings (with references) from the Hub when the dialog opens.
  useEffect(() => {
    if (editingId === null) return;
    let cancelled = false;
    void readFirst(editingId).then((result) => {
      if (!cancelled) applyRead(result);
    });
    return () => {
      cancelled = true;
    };
  }, [editingId]);

  const save = async () => {
    if (form === null) return;
    const config = mcpConfigOf(form);
    if ("error" in config) {
      setError(config.error);
      return;
    }
    setPending(true);
    const result = await putMcp({
      environmentId: props.environmentId,
      input: {
        spaceId: props.spaceId,
        ...(props.editing === null ? {} : { id: props.editing.id }),
        name: name.trim(),
        config: config.config,
        ...(props.editing === null && source !== null ? { source } : {}),
      },
    });
    setPending(false);
    const problem = failureText(result, "Could not save it.");
    if (problem === null) props.onSaved();
    else setError(problem);
  };

  const field = (key: keyof SpaceMcpForm, value: string) =>
    setForm((current) => (current === null ? current : { ...current, [key]: value }));

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {props.editing === null ? "Add MCP server" : `Edit ${props.editing.name}`}
            </DialogTitle>
            <DialogDescription>
              Never paste a token: put it in this Space's Vault and write {"${NAME}"} where it goes.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {form === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <div className="flex flex-col gap-3">
                {props.editing === null ? (
                  <McpRegistrySearch
                    environmentId={props.environmentId}
                    spaceId={props.spaceId}
                    onChoose={choose}
                  />
                ) : null}
                {source === null ? null : (
                  <p className="text-xs text-muted-foreground">
                    {`${sourceText(source)}. Check every field: nothing is saved or run until you save.`}
                    {needs.length === 0
                      ? null
                      : ` It needs ${needs.join(", ")} in a Vault group this Space receives.`}
                  </p>
                )}
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Name
                  <Input
                    value={name}
                    placeholder="github"
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <ToggleGroup
                  aria-label="How it connects"
                  value={[form.transport]}
                  onValueChange={(next) => {
                    const value = next[0];
                    if (value === "stdio" || value === "http") field("transport", value);
                  }}
                >
                  <Toggle value="stdio">Command</Toggle>
                  <Toggle value="http">URL</Toggle>
                </ToggleGroup>
                {form.transport === "stdio" ? (
                  <>
                    <label className="flex flex-col gap-1 text-xs font-medium">
                      Command
                      <Input
                        value={form.command}
                        placeholder="npx"
                        onChange={(event) => field("command", event.target.value)}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium">
                      Arguments, one per line
                      <Textarea
                        value={form.args}
                        onChange={(event) => field("args", event.target.value)}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium">
                      Environment variables, NAME=value
                      <Textarea
                        value={form.env}
                        placeholder={"GITHUB_TOKEN=${GITHUB_TOKEN}"}
                        onChange={(event) => field("env", event.target.value)}
                      />
                    </label>
                    {draft !== null &&
                    "config" in draft &&
                    draft.config.transport === "stdio" &&
                    draft.config.command !== "" ? (
                      <code className="rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">
                        {commandLineOf(draft.config)}
                      </code>
                    ) : null}
                    <p className="text-xs text-warning-foreground">
                      This command runs on the machine of every Thread of this Space.
                    </p>
                  </>
                ) : (
                  <>
                    <label className="flex flex-col gap-1 text-xs font-medium">
                      URL
                      <Input
                        value={form.url}
                        placeholder="https://example.com/mcp"
                        onChange={(event) => field("url", event.target.value)}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium">
                      Headers, Name: value
                      <Textarea
                        value={form.headers}
                        onChange={(event) => field("headers", event.target.value)}
                      />
                    </label>
                  </>
                )}
                {error === null ? null : (
                  <p className="text-xs text-destructive" role="alert">
                    {error}
                  </p>
                )}
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || form === null || name.trim() === ""}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** The MCP Registry, searched by the Hub; choosing a result only fills in the form. */
function McpRegistrySearch(props: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly onChoose: (result: SpaceMcpSearchResult) => void;
}) {
  const searchMcp = useAtomCommand(spaceToolsEnvironment.searchMcp, "search the MCP Registry");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<SpaceMcpSearchResult> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const search = async () => {
    const text = query.trim();
    if (text.length < 2) return;
    setSearching(true);
    const result = await searchMcp({
      environmentId: props.environmentId,
      input: { spaceId: props.spaceId, query: text },
    });
    setSearching(false);
    if (result._tag === "Success") {
      setResults(result.value.results);
      setProblem(null);
    } else {
      setResults(null);
      setProblem(failureText(result, "Could not search the MCP Registry."));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Input
            aria-label="Search the MCP Registry"
            value={query}
            placeholder="Search the MCP Registry"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void search();
            }}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={searching || query.trim().length < 2}
          onClick={() => void search()}
        >
          Search
        </Button>
      </div>
      {problem === null ? null : <p className="text-xs text-destructive">{problem}</p>}
      {results === null ? null : results.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing found.</p>
      ) : (
        <ul className="flex max-h-56 flex-col divide-y overflow-y-auto rounded-md border">
          {results.map((result) => (
            <li key={result.source.id}>
              <button
                type="button"
                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-accent"
                onClick={() => {
                  props.onChoose(result);
                  setResults(null);
                }}
              >
                <span className="text-sm font-medium">{result.title}</span>
                {result.description === "" ? null : (
                  <span className="text-xs text-muted-foreground">{result.description}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {`${result.config.transport === "stdio" ? "Runs a command" : "Over HTTP"} · ${result.source.id}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SKILL_TEMPLATE = "---\nname: \ndescription: \n---\n";

function SkillDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly editing: SpaceSkillSummary | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const getSkill = useAtomCommand(spaceToolsEnvironment.getSkill, "read the Skill");
  const putSkill = useAtomCommand(spaceToolsEnvironment.putSkill, "save the Skill");
  const [files, setFiles] = useState<SpaceSkillFiles | null>(
    props.editing === null ? { "SKILL.md": SKILL_TEMPLATE } : null,
  );
  const [expects, setExpects] = useState(props.editing?.expects.join(", ") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const editingId = props.editing?.id ?? null;
  const readFirst = useEffectEvent((id: SpaceSkillSummary["id"]) =>
    getSkill({ environmentId: props.environmentId, input: { id } }),
  );
  const applyRead = useEffectEvent((result: Awaited<ReturnType<typeof getSkill>>) => {
    if (result._tag === "Success") setFiles(result.value.files);
    else setError(failureText(result, "Could not read the Skill."));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Skill's files from the Hub when the dialog opens.
  useEffect(() => {
    if (editingId === null) return;
    let cancelled = false;
    void readFirst(editingId).then((result) => {
      if (!cancelled) applyRead(result);
    });
    return () => {
      cancelled = true;
    };
  }, [editingId]);

  const save = async () => {
    if (files === null) return;
    setPending(true);
    const result = await putSkill({
      environmentId: props.environmentId,
      input: {
        spaceId: props.spaceId,
        ...(props.editing === null ? {} : { id: props.editing.id }),
        files,
        expects: expects
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
      },
    });
    setPending(false);
    const problem = failureText(result, "Could not save it.");
    if (problem === null) props.onSaved();
    else setError(problem);
  };

  const others = files === null ? 0 : Object.keys(files).length - 1;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="sm:max-w-2xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {props.editing === null ? "Add Skill" : `Edit ${props.editing.name}`}
            </DialogTitle>
            <DialogDescription>
              Its frontmatter needs a name and a description. A Skill holds no Secrets.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {files === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium">
                  SKILL.md
                  <Textarea
                    className="min-h-64"
                    value={files["SKILL.md"] ?? ""}
                    onChange={(event) =>
                      setFiles((current) => ({ ...current, "SKILL.md": event.target.value }))
                    }
                  />
                </label>
                {others > 0 ? (
                  <p className="text-xs text-muted-foreground">{`Keeps its ${others} other files.`}</p>
                ) : null}
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Vault names it expects, comma-separated
                  <Input
                    value={expects}
                    placeholder="GITHUB_TOKEN"
                    onChange={(event) => setExpects(event.target.value)}
                  />
                </label>
                {error === null ? null : (
                  <p className="text-xs text-destructive" role="alert">
                    {error}
                  </p>
                )}
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || files === null}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * «Lend…» on a Space's MCP server or Skill. An MCP server that uses Vault entries is refused until
 * this Space's groups holding them are lent there first; the Hub says which names.
 */
function LendToolDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly tool: Tool;
  readonly onClose: () => void;
}) {
  const targetsCommand = useAtomCommand(grantsEnvironment.targets, "list where you may lend");
  const [targets, setTargets] = useState<ReadonlyArray<GrantTarget> | null>(null);
  const [spaceId, setSpaceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const resource =
    props.tool.kind === "mcp"
      ? ({ kind: "space-mcp", spaceMcpId: props.tool.row.id } as const)
      : ({ kind: "space-skill", spaceSkillId: props.tool.row.id } as const);

  const readFirst = useEffectEvent(() =>
    targetsCommand({ environmentId: props.environmentId, input: { resource } }),
  );
  const applyRead = useEffectEvent((found: Awaited<ReturnType<typeof targetsCommand>>) => {
    if (found._tag === "Success") setTargets(found.value.targets);
    else setError(failureText(found, "Could not list the Spaces."));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads where it may be lent when the dialog opens.
  useEffect(() => {
    let cancelled = false;
    void readFirst().then((found) => {
      if (!cancelled) applyRead(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const target = targets?.find((entry) => entry.spaceId === spaceId);
  const submit = async () => {
    if (target === undefined) return;
    setPending(true);
    setError(null);
    try {
      const grant = await giveGrant(
        {
          resource,
          spaceId: target.spaceId,
          limits: { kind: resource.kind },
        },
        undefined,
      );
      setDone(
        grant.state === "active"
          ? `Lent to ${spaceLabel(target)}.`
          : `Waiting for ${spaceLabel(target)} to accept it.`,
      );
    } catch (cause) {
      setError(errorMessageOf(cause, "The loan did not go through."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Lend {props.tool.row.name}</DialogTitle>
            <DialogDescription>
              The Space's Threads use it; its people never see its settings and cannot change or
              lend it. You can take it back at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium">
                Lend to
                <Select
                  value={spaceId}
                  disabled={done !== null}
                  onValueChange={(next) => setSpaceId(String(next ?? ""))}
                >
                  <SelectTrigger aria-label="Lend to">
                    <SelectValue>
                      {target
                        ? spaceLabel(target)
                        : targets === null
                          ? "Loading…"
                          : "Choose a Space"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(targets ?? []).map((entry) => (
                      <SelectItem key={entry.spaceId} value={entry.spaceId}>
                        {spaceLabel(entry)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              {done === null ? null : <p className="text-xs text-success-foreground">{done}</p>}
              {error === null ? null : (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              {done === null ? "Cancel" : "Done"}
            </Button>
            {done === null ? (
              <Button type="submit" disabled={pending || target === undefined}>
                Lend
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
