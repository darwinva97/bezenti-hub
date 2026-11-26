/**
 * Makita ticket 29, pure: a comment in plain words that is exactly one phrase of a short closed
 * list, once the mention, punctuation, emoji, accents and politeness are taken out. No model.
 */
export type PlainIntent = "stop" | "retry" | "reopen" | "approve" | "merge";

/** The phrases, lower case, without accents or punctuation, as they are matched. */
export const PLAIN_PHRASES: Readonly<Record<PlainIntent, ReadonlyArray<string>>> = {
  stop: [
    "para",
    "paralo",
    "parate",
    "para ya",
    "detente",
    "detenlo",
    "alto",
    "basta",
    "cancela",
    "cancelalo",
    "aborta",
    "abortalo",
    "ya no",
    "dejalo",
    "dejalo ya",
    "olvidalo",
    "no sigas",
    "stop",
    "stop it",
    "stop that",
    "stop working",
    "cancel",
    "cancel it",
    "cancel that",
    "abort",
    "abort it",
    "halt",
    "forget it",
  ],
  retry: [
    "reintenta",
    "reintentalo",
    "intentalo de nuevo",
    "intentalo otra vez",
    "vuelve a intentarlo",
    "prueba de nuevo",
    "prueba otra vez",
    "otra vez",
    "de nuevo",
    "retry",
    "retry it",
    "try again",
    "try it again",
    "try once more",
    "again",
    "one more time",
    "give it another try",
    "give it another go",
    "run it again",
  ],
  reopen: [
    "reabre",
    "reabrelo",
    "reabre el issue",
    "reabrir",
    "abrelo de nuevo",
    "abrelo otra vez",
    "vuelve a abrirlo",
    "reopen",
    "reopen it",
    "reopen this",
    "reopen the issue",
    "open it again",
  ],
  approve: [
    "ok",
    "okay",
    "okey",
    "vale",
    "dale",
    "adelante",
    "aprobado",
    "aprobada",
    "apruebo",
    "subelo",
    "sube",
    "empuja",
    "empujalo",
    "de acuerdo",
    "approved",
    "approve",
    "i approve",
    "go ahead",
    "go for it",
    "lgtm",
    "looks good",
    "push it",
    "send it",
  ],
  merge: [
    "mergealo",
    "mergea",
    "mergear",
    "haz merge",
    "haz el merge",
    "fusionalo",
    "fusiona",
    "integralo",
    "merge",
    "merge it",
    "merge this",
    "go ahead and merge",
    "lgtm merge",
    "lgtm merge it",
    "land it",
  ],
};

/** Words that carry no order, taken out wherever they stand. */
const FILLERS: ReadonlyArray<ReadonlyArray<string>> = [
  "please",
  "pls",
  "plz",
  "thanks",
  "thank you",
  "thx",
  "por favor",
  "porfa",
  "porfavor",
  "gracias",
  "hey",
  "hi",
  "hello",
  "hola",
  "oye",
  "now",
  "ahora",
  "makita",
].map((filler) => filler.split(" "));

const INTENT_OF: ReadonlyMap<string, PlainIntent> = new Map(
  (
    Object.entries(PLAIN_PHRASES) as ReadonlyArray<readonly [PlainIntent, ReadonlyArray<string>]>
  ).flatMap(([intent, phrases]) => phrases.map((phrase) => [phrase, intent] as const)),
);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The words left once fillers are taken out. */
const withoutFillers = (words: ReadonlyArray<string>) => {
  const kept: Array<string> = [];
  for (let at = 0; at < words.length;) {
    const filler = FILLERS.find((parts) => parts.every((part, i) => words[at + i] === part));
    if (filler === undefined) {
      kept.push(words[at]!);
      at += 1;
    } else {
      at += filler.length;
    }
  }
  return kept;
};

/**
 * The order a comment gives in plain words, or undefined. `addressed`: `mention` on an issue (the
 * comment must mention `@login`), `pull` on Makita's own pull request (no mention needed).
 * Quoted lines never count, a `/makita` command is left to the command, and a comment that also
 * mentions someone else is not an order.
 */
export const plainIntentOf = (
  body: string,
  input: { readonly login: string; readonly addressed: "mention" | "pull" },
): PlainIntent | undefined => {
  if (input.login.length === 0) return;
  const lines = body
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith(">"))
    .filter((line) => line.trim().length > 0);
  // A `/makita` command anywhere is the command's to read (only on the first line), never words.
  if (lines.some((line) => /(?:^|\s)\/makita(?:\s|$)/iu.test(line))) return;
  // A mention as `makitaFeeds.mentions` reads it: a whole word, outside quotes and inline code.
  const self = `(^|[^\\w/@.-])@${escape(input.login)}(?![\\w-])`;
  const joined = lines.join("\n");
  const outsideCode = joined.replace(/`[^`\n]*`/gu, " ");
  if (input.addressed === "mention" && !new RegExp(self, "iu").test(outsideCode)) return;
  const text = joined.replace(new RegExp(self, "giu"), "$1 ").replace(/\n/gu, " ");
  // Speaking to someone else too: not Makita's order alone.
  if (/(?:^|[^\w/@.-])@[A-Za-z0-9]/u.test(text)) return;
  const words = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
  const left = withoutFillers(words).join(" ");
  return left.length === 0 ? undefined : INTENT_OF.get(left);
};
