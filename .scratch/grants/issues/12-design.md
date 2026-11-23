# Design: desktop, mobile, palette and waiting loans (Grants 12)

Branch `feat/grants-11-13`. No migration.

## Shared logic (client-runtime)

- `@t3tools/client-runtime/grants-view` (`grantsView.ts`): everything a client says or sorts about a
  loan, moved from the web app's `grantText.ts` and `GrantsSettings.tsx`: limits, states and ended
  reasons, warnings (what the lender sees, a subscription's terms, a lent group, ending a loan),
  `groupLentLoans`, `receivedSections` (waiting / borrowed / ended), `pendingGrantsOf` (the
  directory's counts) and `grantOfferTokenOf` (a pasted lending link). Web and mobile import it;
  nothing of it is copied.
- Commands: `createGrantsEnvironmentAtoms` (already there) for every WS call; giving, accepting and
  applying a machine's link stay over HTTP with the strong factor.

## Waiting loans

- `SpaceSummary.pendingGrants` (optional): loans `pending` in that Space, set only where the viewer
  holds `grant.decide` (an Organization's Admins, a Personal space's User), absent otherwise. One
  `COUNT … GROUP BY target_id` per directory read, only over the Spaces the viewer decides in.
- It refreshes whenever the Space directory does: opening the Space selector, a fresh shell snapshot
  (reconnect), and after the client decides a loan. No new push channel: a lender giving a loan does
  not wake the decider's client (conservative: no new stream to secure; the count is right at the
  next refresh).
- Web/desktop: a count beside each Space in the selector and on its trigger; mobile: in its Space
  picker.

## Palette (web and desktop)

- «Lend a resource…»: a submenu, «Lend an AI account», «Lend a Vault group», «Lend a machine», each
  opening the Settings page whose rows carry «Lend…».
- «Loans waiting for you» (with the count) and «Loans you gave»: Settings → Machines → «Loans»
  (`#grants`). No default shortcut.

## Desktop

- A lending link is made on the Hub's public URL, else the address the app reaches the Hub on
  (`readHubLinkOrigin`), never the app's own `t3code://` origin.
- Opened from outside: `t3code://grants/offer#token=…` and a link on the Hub's address open the app's
  `/grants/offer` page (`promptLinkAppPath` learns the route); anything else stays in the browser.

## Mobile (`apps/mobile/src/features/grants/`)

- Settings → «Loans»: waiting (accept, reject), borrowed (give back, use), ended, and lent by the
  User (take back, cancel, use), with the same warnings as web (`grants-view`).
- Accepting a machine's loan or applying a machine's link needs the strong factor over HTTP; mobile
  does what it can (AI accounts, Vault groups) and tells the User to finish a machine on web or
  desktop. Giving a loan with limits stays on web and desktop (spec).
- «Apply a lending link»: paste a link (`grantOfferTokenOf`), read it (`grants.readOffer`), pick a
  Space, apply (`grants.claimOffer`).
- Pickers: the AI account strip names a lent account «<name> · from <lender>» with its cap use
  (`aiAccountPickerLabel`, already shared); a lent machine shows its warning
  (`environmentUseDescription`, already shared).

## Not done here

The live passes (`test-t3-app`, `test-t3-mobile`) need a running Hub and a device; mobile can only be
checked with component tests in this environment.
