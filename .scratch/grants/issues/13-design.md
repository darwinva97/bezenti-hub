# Design: door inventory and full pass (Grants 13)

Branch `feat/grants-11-13`. No migration.

## How the review ran

- An independent read-only review of every door (WS, HttpApi, raw routes, MCP, executor wire, the
  Sandbox socket and git route, logs, spans, process arguments, access keys), against the spec's
  «Quién hace qué» and «Puertas». Each hole: a failing test first, then the fix.
- `grants/GrantDoors.test.ts`: the Owner, the Admin, Member and Guest of Acme and Globex, and Ana
  (no Organization) call each Grants door; nobody sees another's waiting loans, usage outside their
  loans, a lent Secret's value or a link's token; nobody but a loan's sides changes it; any door
  matching /grant/ in `WsRpcGroup`, `HTTP_ENDPOINT_RULES`, `RAW_ROUTE_RULES` or `MCP_TOOL_RULES`
  not called there (or in a named file) fails; no MCP door exists. Inverse doors one by one.
- Leak smoke: a link's token in no log, span or audit entry (making, reading, applying, a wrong
  token, a used link); a lent Sandbox's credential in no log, span, process argument or stored row.

## Holes found and their fixes

1. **A lent Sandbox's credential read every Project of the borrowing Space** over the git route
   (the lender can always mint one from their machine). Now it reads only the repositories of the
   Threads it runs (or is the target of a move to); 403 otherwise.
2. **The Owner, outside an Organization, used what was lent to it** (AI accounts through
   `aiAccount.use`, lent machines through the Owner's bypass in `environment.use`, lent Vault groups
   through `EffectiveVaults`). Conservative fix: a loan reaches the Space's people
   (`AccessPolicy.borrowsIn`): the Owner borrows there only as a Member or in their own Personal
   space, and still uses what they lent themselves. Their operator powers elsewhere are unchanged.
3. **Someone else's resource was described before the policy** (whether an account is `direct`, a
   group `default` or archived, a machine's own report of why it cannot host). Now whoever is not on
   its lending side hears «does not exist» first (404 / `not-found`); a Member of the owning
   Organization still gets the policy's «no».
4. **Ended loans were listed to Members** (from ticket 11). Ended loans are history for whoever runs
   the Space (`grant.return`: Admins, a Personal space's User).
5. **A lent Vault group kept delivering while its lender could not lend** (a disabled User, an
   archived or frozen Organization), unlike AI accounts and machines. Now it reaches nothing then,
   and again once the lender is back.
6. **A lent Sandbox's credential outlived a failed close.** It now dies once its loan ended and
   `LENT_DRAIN_MS` (the time its turns get to save their checkpoints) passed, whatever the close did.

## Checked and left as is

- `aiUsage.summary`'s quota share for a lent subscription: a borrower (Guest included, who may use
  it) sees their own share and the window's reset, which the gateway's cap error also says.
- Access keys reach only the Space's own AI accounts (`AllowedAiAccounts.forSpace`), never a lent
  one (access-keys spec).
- The WS door makes no machine or Vault group loan active; only HTTP with the strong factor.

## Not done here

The live pass in WSL with Podman (AI account with a cap, Vault group and machine lent to Acme, a
link applied by Bob, taking the three back, migrated allowances with copied data) needs a running
Hub with real data and providers; it is listed for a human.
