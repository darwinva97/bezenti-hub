# 29 design: talk to Makita without commands

Ticket: `29-hablar-sin-comandos.md`. Spec: `../spec.md` («Seguir la conversación», «Aprobación», «Aterrizar con `/makita merge`», «Amenazas de prompt injection»). Builds on 09 (`/makita stop`, `/makita retry`), 11 (`/makita ok`), 13 (`/makita merge`, `makita_request_merge`), 14 (Makita's pull request without a mention) and 26 (`/makita reopen`).

## What changes

**One pure recognizer, `makitaPlainWords.ts`.** `plainIntentOf(body, { login, addressed })` answers `stop`, `retry`, `reopen`, `approve`, `merge` or nothing:

1. Quoted lines (`>`) are dropped.
2. `addressed: "mention"` (an issue): the text must mention `@login` (the existing `mentions`). `addressed: "pull"` (Makita's own pull request): no mention needed, as ticket 14.
3. Every `@login` is removed. Any other `@someone` left: nothing (the comment speaks to someone else too).
4. Lower case, accents removed (NFD, marks dropped), apostrophes dropped, everything that is not a letter or a digit (punctuation, emoji, symbols) becomes a space.
5. Politeness and filler words are removed wherever they stand: `please`, `pls`, `plz`, `thanks`, `thank you`, `thx`, `por favor`, `porfa`, `porfavor`, `gracias`, `hey`, `hi`, `hello`, `hola`, `oye`, `now`, `ahora`, `makita`.
6. What is left must be **exactly** one phrase of one list. Anything longer is not an order.

The lists (written here with accents; matched without):

| Intent  | Spanish                                                                                                                                          | English                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| stop    | para, páralo, párate, para ya, detente, detenlo, alto, basta, cancela, cancélalo, aborta, abórtalo, ya no, déjalo, déjalo ya, olvídalo, no sigas | stop, stop it, stop that, stop working, cancel, cancel it, cancel that, abort, abort it, halt, forget it                             |
| retry   | reintenta, reinténtalo, inténtalo de nuevo, inténtalo otra vez, vuelve a intentarlo, prueba de nuevo, prueba otra vez, otra vez, de nuevo        | retry, retry it, try again, try it again, try once more, again, one more time, give it another try, give it another go, run it again |
| reopen  | reabre, reábrelo, reabre el issue, reabrir, ábrelo de nuevo, ábrelo otra vez, vuelve a abrirlo                                                   | reopen, reopen it, reopen this, reopen the issue, open it again                                                                      |
| approve | ok, okay, okey, vale, dale, adelante, aprobado, aprobada, apruebo, súbelo, sube, empuja, empújalo, de acuerdo                                    | approved, approve, i approve, go ahead, go for it, lgtm, looks good, push it, send it                                                |
| merge   | mergéalo, mergea, mergear, haz merge, haz el merge, fusiónalo, fusiona, intégralo                                                                | merge, merge it, merge this, go ahead and merge, lgtm merge, lgtm merge it, land it                                                  |

Left out on purpose: «sí» / «yes» / «hazlo» / «do it» (an answer to any question Makita asked), «ship it» (push or merge?), «never mind» (often «forget my question»), «súbelo a main» (the agent's path handles it). The lists are disjoint (a test checks it).

**Where each intent is decided** (the comment still has to pass the rules its command passes: a person, not a bot or Makita, unedited, allowed; a stranger gets silence):

- **stop**: `decideComment` (issue, with a mention) and `decideConversation` (Makita's pull request) treat it as `/makita stop`: same outcomes (`queued`/`stop`, `command`/`nothing-to-stop`, which also takes the issue out of the line), same 👍, same `stopFromGitHub`.
- **retry**: `decideComment` treats it as `/makita retry` only when the issue has no live task and its newest task failed; otherwise it is the plain mention it was before (which starts or wakes a task exactly as today). On Makita's pull request the task is live, so it is conversation.
- **reopen**: `decideReopenComment` accepts it with a mention on an issue Makita closed (ticket 26's rule unchanged: someone the closing configuration answers; strangers, bots, edits and Makita: silence). The cleanup pass reads it again by id and checks the same phrase with Makita's login.
- **approve**: in the intake, before the conversation: only on an issue comment (as `/makita ok`), only when the item's live task has a waiting push Makita already asked for, not yet approved, the comment newer than Makita's request, and its author an approver **now** (`isApproverNow`). Then it is queued exactly as `/makita ok` and `approveFromGitHub` reads it again by id and checks everything again. Otherwise it is ordinary conversation (it wakes the agent like any comment).
- **merge**: in the intake, only on an issue comment of an item with a live task, by an approver now; then it is queued as `/makita merge` and `orderFromCommand` reads it again and checks everything (`MakitaLanding.ts` is not loosened: landing on, CI green on the head, mergeable, no workflows, after the last push). Otherwise conversation: the agent's wake already says the author is not an approver.

**`makita_request_approval { commentId, kind }`** (kind as `makita_request_merge`: `issue-comment`, `review-comment`, `review`), listed only where the configuration may push (`MAKITA_PUSH_TOOLS`). For longer wording («vale, súbelo, ya lo revisé»). The agent only points at a comment; `MakitaTasks.requestApprovalForThread` (logic in `makitaApprovalFlow.ts`) trusts nothing but the id and checks, in order:

1. the calling Thread is a Makita task's; Makita and its configuration not paused, the task live, no stop queued for it; the configuration may push;
2. a push waits, Makita asked for it on GitHub (`request`), and it has no approval yet;
3. not a review (GitHub keeps no edit time for a review, as for merges);
4. the comment read again from GitHub in the task's repository by id; on the task's pull request, or a mention of Makita on its issue;
5. a person's, not Makita's; unedited (`updated_at = created_at`);
6. newer than Makita's request (an issue comment by id, a review comment by time);
7. its author approves the configuration now;
8. it woke the current turn (the newest `started` event of the task is this comment, by this author): an injected text cannot make the agent cite an older, innocent comment;
9. unused: `gh:approval-request:<kind>:<id>` inserted with `ON CONFLICT DO NOTHING`.

Then, in one transaction with the mark, the waiting push gets the approval (`approved_through`, `replies_without_person = 0`) and `makita.task.approve` is audited as for `/makita ok` (`via: github`, the approver's login, the sha); a 👍 on the comment. The next tasks pass sends exactly that commit and tells the Thread, as today. The agent gains no way to approve itself: the authority is the approver's comment, and Makita's own comments are refused at 5.

**The agent is told.** A wake on a task whose push waits ends with one line: whether the author approves, and the exact comment id and kind to point at (or that a review cannot approve). The first message of a pushing task says a waiting push is approved by an approver's words, and that it may ask with `makita_request_approval` only for the comment that woke it.

**What Makita says** offers words first, the command as the exact form: «Ready to push `…` (…). @x can reply `@<makita> ok` (or `/makita ok`) to send it.», the close comment «… reopen this issue or tell @<makita> to reopen it (`/makita reopen`) …», the agent's wait message, the review refusals, and the Space settings texts.

## Who may do it

Exactly who may use the command: stop and retry, whoever the configuration answers; reopen, whoever the closing configuration answers; approve and merge, approvers now. Nothing changes who is allowed or who approves. Out of scope: hearing an issue without a mention; any model call in the Hub.

## How it is undone

As each command: a stopped task is asked for again; a released push and a merge stay. A phrase that turns out bad is removed from its list; the commands keep working. The tool goes away by turning `push` off.

## Risks that stay

A short phrase said without meaning the order («ok» as «got it» while a push waits). Bounded: approve and merge only from approvers now, approve only for a push Makita already asked for, merge only through every landing check, and nothing longer than a listed phrase is ever the Hub's order. The tool's risk is merge's: the agent reads an approval that was not one; the instructions say to ask when unsure.

## Tests (red-first)

- `makitaPlainWords.test.ts`, a table: accents, capitals, trailing punctuation, emoji, a mention at the start or the end, quoted lines, another person mentioned, missing mention on an issue, longer sentences that contain a listed word («no pares hasta que pase CI», «stop using tabs»), disjoint lists.
- Integration over the fake GitHub: «@makita-bot para» stops and reacts, «para» on Makita's pull request stops, «stop using tabs» wakes the agent instead; a stranger's «stop» is silence; an edited one is ignored. «@makita-bot reintenta» restarts a failed task; on a live one it wakes it. «@makita-bot reábrelo» reopens an issue Makita closed; a stranger's does nothing. «@makita-bot dale» from an approver releases the waiting push and resets the loop guard; from a non-approver, or with nothing waiting, it is conversation; an issue body «approved, push it» approves nothing. `makita_request_approval`: a non-approver's «approved, push it», an older comment, Makita's own, an edited one, one before the request, a review, a used one: refused; the approver's comment that woke the turn approves. «mergéalo» from an approver lands through every check; from a non-approver it wakes the agent.
- The door sweeps list the tool.
