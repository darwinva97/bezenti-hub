import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxPopup } from "../ui/combobox";

/** One heading of the list (a model family), "" for a list without headings. */
export interface ChipsGroup {
  readonly value: string;
  readonly items: ReadonlyArray<string>;
}

/** What the typed text may add that the list does not hold (a model pattern). */
export interface ChipsCreate {
  /** Whether the text, trimmed, may be added as it is. */
  readonly accepts: (text: string) => boolean;
  /** The option's words, such as «Add "claude-sonnet-*" as a pattern». */
  readonly label: (text: string) => string;
}

/**
 * A searchable multi-select: what is chosen as chips (each with its remove button), the rest in a
 * filtered list under headings. Values outside the list (patterns) are chips too.
 */
export function ChipsMultiSelect(props: {
  /** The search field's accessible name. */
  readonly label: string;
  readonly groups: ReadonlyArray<ChipsGroup>;
  readonly value: ReadonlyArray<string>;
  readonly onValueChange: (next: ReadonlyArray<string>) => void;
  readonly labelOf?: (value: string) => string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly empty: string;
  readonly create?: ChipsCreate;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined);
  const labelOf = props.labelOf ?? ((value: string) => value);
  const typed = query.trim();
  const creatable =
    props.create !== undefined &&
    typed.length > 0 &&
    !props.value.includes(typed) &&
    !props.groups.some((group) => group.items.includes(typed)) &&
    props.create.accepts(typed);
  const add = () => {
    if (!creatable) return;
    props.onValueChange([...props.value, typed]);
    setQuery("");
    // Back to the search, to type the next one.
    inputRef.current?.focus();
  };
  return (
    <ComboboxPrimitive.Root
      items={props.groups.map((group) => ({ value: group.value, items: [...group.items] }))}
      multiple
      value={[...props.value]}
      onValueChange={(next: string[]) => props.onValueChange(next)}
      inputValue={query}
      onInputValueChange={setQuery}
      onItemHighlighted={(value: string | undefined) => setHighlighted(value)}
      itemToStringLabel={labelOf}
      disabled={props.disabled === true}
    >
      <ComboboxPrimitive.Chips
        ref={anchorRef}
        className={cn(
          "flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-background px-1.5 py-1 text-sm shadow-xs/5 focus-within:border-ring focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/24 dark:bg-input/32",
          props.disabled === true && "opacity-64",
        )}
      >
        <ComboboxPrimitive.Value>
          {(values: string[]) =>
            values.map((value) => (
              <ComboboxPrimitive.Chip
                key={value}
                className="inline-flex max-w-full items-center gap-0.5 rounded-sm bg-secondary py-0.5 ps-1.5 pe-0.5 text-xs text-secondary-foreground outline-none data-highlighted:ring-2 data-highlighted:ring-ring"
              >
                <span className="truncate">{labelOf(value)}</span>
                <ComboboxPrimitive.ChipRemove
                  aria-label={`Remove ${labelOf(value)}`}
                  className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm opacity-70 hover:bg-foreground/10 hover:opacity-100"
                >
                  <XIcon className="size-3" />
                </ComboboxPrimitive.ChipRemove>
              </ComboboxPrimitive.Chip>
            ))
          }
        </ComboboxPrimitive.Value>
        <ComboboxPrimitive.Input
          ref={inputRef}
          aria-label={props.label}
          placeholder={props.value.length === 0 ? props.placeholder : undefined}
          className="h-6 min-w-28 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground/72"
          onKeyDown={(event) => {
            // Enter with nothing highlighted adds what was typed, when it may be added.
            if (event.key === "Enter" && highlighted === undefined && creatable) {
              event.preventDefault();
              add();
            }
          }}
        />
      </ComboboxPrimitive.Chips>
      <ComboboxPopup anchor={anchorRef} className="w-(--anchor-width)">
        {creatable ? null : <ComboboxEmpty>{props.empty}</ComboboxEmpty>}
        <ComboboxList>
          {(group: { readonly value: string; readonly items: string[] }) => (
            <ComboboxPrimitive.Group key={group.value} items={group.items}>
              {group.value === "" ? null : (
                <ComboboxPrimitive.GroupLabel className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                  {group.value}
                </ComboboxPrimitive.GroupLabel>
              )}
              <ComboboxPrimitive.Collection>
                {(item: string) => (
                  <ComboboxItem key={item} value={item} selectedFill={false}>
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <ComboboxPrimitive.ItemIndicator>
                        <CheckIcon className="size-3.5" />
                      </ComboboxPrimitive.ItemIndicator>
                    </span>
                    <span className="min-w-0 truncate">{labelOf(item)}</span>
                  </ComboboxItem>
                )}
              </ComboboxPrimitive.Collection>
            </ComboboxPrimitive.Group>
          )}
        </ComboboxList>
        {creatable && props.create !== undefined ? (
          <div className="border-t border-border/60 p-1">
            <button
              type="button"
              className="flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-start text-sm hover:bg-foreground/[0.09]"
              onClick={add}
            >
              <PlusIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{props.create.label(typed)}</span>
            </button>
          </div>
        ) : null}
      </ComboboxPopup>
    </ComboboxPrimitive.Root>
  );
}
