import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, MakitaProjectRepo, SpaceId } from "@t3tools/contracts";
import { useState } from "react";

import { errorMessageOf } from "../../lib/errorMessage";
import { makitaEnvironment } from "../../state/makita";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * Makita ticket 21: a repository by name, in a configuration's form. The Hub reuses this Space's
 * Project with that GitHub remote, or clones it as a new Project of the Space, as you.
 */
export function MakitaRepoAddField(props: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly disabled: boolean;
  readonly onAdded: (project: MakitaProjectRepo) => void;
}) {
  const add = useAtomCommand(makitaEnvironment.addRepo, "add a repository to Makita");
  const [repo, setRepo] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    readonly text: string;
    readonly tone: "note" | "error";
  } | null>(null);

  const submit = () => {
    const name = repo.trim();
    if (name.length === 0 || pending) return;
    setPending(true);
    setMessage(null);
    void add({ environmentId: props.environmentId, input: { spaceId: props.spaceId, repo: name } })
      .then((result) => {
        if (result._tag !== "Success") {
          setMessage({
            tone: "error",
            text: errorMessageOf(squashAtomCommandFailure(result), "Could not add it."),
          });
          return;
        }
        const { project, created, notes } = result.value;
        props.onAdded(project);
        setRepo("");
        const said = created
          ? `Added ${project.repo ?? name} as a new Project of this Space.`
          : `${project.title ?? name} already has ${project.repo ?? name}: chosen.`;
        setMessage({ tone: "note", text: [said, ...notes].join(" ") });
      })
      .finally(() => setPending(false));
  };

  return (
    <div className="flex flex-col gap-1 font-normal">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Repository to add"
          nativeInput
          disabled={props.disabled || pending}
          placeholder="owner/name or a github.com address"
          value={repo}
          onChange={(event) => setRepo(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Inside the configuration's form: Enter adds this, it does not save the form.
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.disabled || pending || repo.trim().length === 0}
          onClick={submit}
        >
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>
      {message === null ? (
        <span className="text-muted-foreground">
          A repository without a Project here becomes a new Project of this Space, cloned as you.
          Removing it from Makita later keeps the Project.
        </span>
      ) : (
        <span
          className={message.tone === "error" ? "text-destructive" : "text-muted-foreground"}
          role={message.tone === "error" ? "alert" : "status"}
        >
          {message.text}
        </span>
      )}
    </div>
  );
}
