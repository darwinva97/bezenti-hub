# Declutter: AI accounts, access keys, machine card

The Owner finds three settings screens hard to read: long explanation cards, forms always
open, one big card per account, a wall of model checkboxes, and a machine line where memory and
disk read as one sentence. Goal: the list is the page; adding and changing open on demand.
Nothing changes on the server, in the contracts or in who may do what: every control keeps its
permission check, only where it sits moves.

## 1. User settings → AI accounts → Accounts (and an Organization's, in Space settings)

`AiAccountsSettings.tsx`. The same component renders both (Space settings passes an
`organization` scope), so both get this.

- **Intro**: the "AI accounts" card (a section holding a row with the same title) goes. In its
  place, one line under the tabs: "API keys and subscriptions your agents use through the Hub's
  AI gateway, tried first to last." plus a "How this works" disclosure (Collapsible) with the
  rest of the old paragraph. Errors stay an alert on that line.
- **Import from CLIProxyAPI** (Owner only, User settings only): a button beside the intro, opening
  a dialog with the two paragraphs, the file picker and the per-file results.
- **Each owner** ("Mine", each Organization the viewer runs): one section whose title carries an
  info tooltip with the old description, and an "Add AI account" button in its header (only for
  whoever may write) opening a dialog. The dialog has a three-way switch: "API key" (the old
  form: name, credential type, provider, key, base URL and models), "Subscription" (name,
  provider, the terms warning, the sign-in flow), "Vertex service account" (name, JSON key).
  An API key or Vertex import closes the dialog when added; a sign-in closes it when finished.
- **Each account is one dense row** in its owner's group, not its own card:
  name, kind badge (Subscription / API key / Direct), status badge; one muted line with
  provider, priority, key hint or "signed in as", quota; the status message, error or notice
  under it. Actions at the right: Up / Down (icon buttons, same labels), and a "⋯" menu with
  "Manage…", "Enable"/"Disable", "Lend…" (not for direct), "Delete…". Delete asks in an alert
  dialog ("Delete for good"); an account still live in the gateway shows
  "Try removing it again" in the row itself.
- **Manage…** opens a dialog with what was inline: name (and base URL / models for an
  OpenAI-compatible one), "Sign in again" for a subscription with its terms note, "Replace
  credential" for an API key.
- "AI accounts you may use" and "Other people's AI accounts" use the same rows (no actions);
  the "Name, provider, owner and status only" row becomes the title's tooltip.
- `MigratedLoansReview` stays where it is.

## 2. Space settings → AI accounts → Access keys

`AccessKeysSettings.tsx`.

- The section's description row becomes a title tooltip; its header holds "Show ended keys" and
  "New access key" (only for whoever may make keys in this Space). The list of keys is the
  section's content.
- **New access key** opens a dialog with the full form: who it is for, validity (days / until a
  date), token caps with "No token limit", AI accounts, models, the subscription warning (one
  short line, the full text in its tooltip), "Create key". On success the same dialog turns into
  the one-time reveal (key, setup per client, copy buttons, "Done"); it does not close on an
  outside click while the key shows.
- **Models**: "Choose models" / "All models" stays. "Choose models" is a searchable multi-select
  (Base UI combobox, chips for what is chosen, grouped by family); a typed text that is a valid
  pattern or exact name not in the catalog offers "Add «…» as a pattern". Chips remove entries,
  patterns included.
- **AI accounts**: "All of this Space's AI accounts" / "Choose accounts" stays; "Choose accounts"
  is the same multi-select (subscriptions marked).
- The Edit and Renew dialogs use the same pickers.
- **Key rows**: label and hint, expiry or "Revoked" as a badge; one muted line with models,
  accounts and caps; one with usage, author and last use. Actions: "Copy setup", and a "⋯" menu
  with Renew, Edit, Revoke (each only when it was shown before).

## 3. Machine card (Settings → Machines, and an Organization's machines and Sandbox)

`HubEnvironmentsSettings.tsx`.

- The resources line becomes three labelled meters, side by side: **CPU** ("8 CPUs", % busy),
  **Memory** and **Disk**, each "X of Y GB used" with a thin bar and its percent (amber from
  90%). Used, not free: what fills up is what the bar shows. Each meter is a `role="meter"`.
- Providers stay a line under them.
- Actions: "Open" stays a button; Lend…, Change use, Rename and Remove go into a "⋯" menu with
  the same conditions.

## Tests

No browser test covered these components yet. New:
`AiAccountsSettings.browser.test.tsx` (rows, add dialog, manage dialog, delete confirm),
`AccessKeysSettings.browser.test.tsx` (new key dialog and reveal, model picker search, select,
chip removal and pattern), and a meter assertion for the machine card in
`OwnedResourceSections.browser.test.tsx`.
