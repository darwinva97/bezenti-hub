# A lent machine runs a Sandbox per borrowing Space, beside its owner's own server

A User can lend their personal machine to another Space (a Grant). The machine keeps serving its owner natively; beside that server it runs one rootless Podman Sandbox per active Grant, with the container rules of ADR 0004, and each is an Environment of the borrowing Space with a credential that reaches that Space alone. The borrowers are told that the machine's owner controls it and sees everything that runs there, and accepting needs a strong factor.

Numbering: the Grants spec (`.scratch/grants/spec.md`) calls this ADR 0011 and cites 0008 to 0012, written before 0008 (Vault entries from secret providers) and 0009 (workload identity tokens) took those numbers. This is the first of them written; the others take the next free numbers when written, and the spec is read with that shift.

## Considered Options

- A dedicated machine only (ADR 0004 on an external machine): no sharing, and the owner loses their own use of it.
- One OS user per lent Sandbox on the machine: an escape stays out of the owner's account, but joining needs root and a user per Grant, which a personal machine's owner may not have.
- Filtering egress (no network, or a proxy through the Hub's socket): stops LAN access, but breaks most tools; possible later as an option.

## Consequences

Every lent Sandbox runs as the owner's Linux user, so a container escape gives that account and the other borrowers' Sandboxes; egress is not filtered and leaves from the owner's address; disk is measured, not capped. These are accepted and shown to both sides. Hosting refuses a machine with services reachable beyond loopback unless its owner lists their ports.
