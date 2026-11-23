# Lending resources

You can lend something you own to a Space so its people can use it: an AI account, a Vault group,
or one of your personal machines. An organization's Admins lend what the organization owns the same
way. You keep it: you see how it is used and take it back whenever you want.

## What you can lend

- **An AI account** (an API key or a subscription), used through the Hub's AI gateway. You can cap
  it in tokens and requests per day, week or month. You see how many tokens and requests each
  person in the Space used, and an estimated cost for API keys; never their prompts or threads.
  Accounts whose key goes straight to the agent are not lent.
- **A Vault group**. The Space's agents receive its Secrets as environment variables when their turns
  start, so they can read them. People in the Space see its Variables and the names of its Secrets,
  never a Secret's value. Names that change how tools run are never sent from a lent group. When you
  take it back, you are told which Secrets to replace.
- **A personal machine**. Each Space you lend it to runs in its own Sandbox there, with the CPU,
  memory, process and disk limits you set. You keep working on it as before.

## Lend

Choose **Lend…** on the resource's row: in Settings → AI accounts, Settings → Vault or Settings →
Machines. The command palette's **Lend a resource...** leads to the same pages. Pick a Space you
belong to, or make a **lending link** for anyone else: it works once, for 7 days, and only shows
what you lend and who you are. Lending a Vault group always asks for your passkey or authenticator
code.

Lending a subscription shows a warning: the provider's terms forbid sharing an account, and it may
be suspended.

## Accept or reject

A loan to an organization waits for one of its Admins; a loan to your Personal space waits for you.
The Space selector shows how many loans wait for you, beside each Space; the count refreshes when you
open the selector and after you decide. Find them under **Loans** in Settings → Machines, or with
**Loans waiting for you** in the command palette. On the mobile app, open Settings → Loans.

Each loan says who lends it, its limits and what its owner can see. Accepting a machine asks for
your passkey or authenticator code, on the web or desktop app.

**What a machine's owner sees.** Whoever lends you a machine controls it and can see everything that
runs on it: files, processes, the Secrets your turns receive and each thread's AI gateway key. Only
accept machines of people you trust that much.

To apply a lending link, open it while signed in, or paste it in the mobile app (Settings → Loans →
Apply a lending link), and choose which of your Spaces receives it. The desktop app opens lending
links for its Hub itself.

## Take back, give back

The lender takes a loan back; the Space's Admins (or the Personal space's owner) give it back. Both
are in **Loans**, on every app. A loan also ends by itself when the resource is deleted, when the
Space is deleted, or when the lender's account or organization is removed; archiving the Space or
the lender leaving it ends nothing. Ended loans stay listed with the day and the reason.

When a machine's loan ends, its threads stop (running turns get up to two minutes to save their
work) and wait for you to move them to another environment; its Sandbox and files are deleted from
the machine.
