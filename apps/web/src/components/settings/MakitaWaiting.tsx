import { type MakitaWaitingItem, makitaItemUrl } from "@t3tools/contracts";

/** «1st», «2nd», «3rd», «4th»…, for a place in line. */
const ordinal = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
};

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Makita ticket 22: issues waiting for a free slot of their configuration, in the order they
 * will start. Nothing when none waits.
 */
export function MakitaWaitingList({
  waiting,
  nameOf,
}: {
  readonly waiting: ReadonlyArray<MakitaWaitingItem>;
  /** The configuration's name where several are shown; else null. */
  readonly nameOf: (configId: string) => string | null;
}) {
  if (waiting.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {`Waiting for a free slot (${waiting.length})`}
      </span>
      <ul aria-label="Makita waiting" className="divide-y divide-border/50">
        {waiting.map((item) => (
          <li
            key={`${item.configId}-${item.repo}-${item.number}-${item.since}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-2 text-xs"
          >
            <a
              className="font-medium hover:underline"
              href={makitaItemUrl(item)}
              target="_blank"
              rel="noreferrer"
            >
              {item.repo}#{item.number}
            </a>
            <span>{`${ordinal(item.position)} in line`}</span>
            <span className="text-muted-foreground">
              {item.actorLogin === null ? "" : `@${item.actorLogin} · `}
              {`since ${formatWhen(item.since)}`}
              {nameOf(item.configId) === null ? "" : ` · ${nameOf(item.configId)}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
