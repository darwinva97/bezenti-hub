# Vault entries may read their values from external Secret providers

A Vault entry may keep, instead of a value, where to read it in a Secret provider (OpenBao, HashiCorp Vault, 1Password, a cloud secret manager, a Kubernetes cluster's Secrets, or a command the Owner allows). The Hub signs in to the provider with a Provider scope, reads the value when a process of a Thread starts, and delivers it exactly as it delivers its own values: agents never hold provider credentials and never talk to the provider. The Hub's own encrypted store stays, and stays the default.

This reverses decision 2 of the Vaults map (`.scratch/multi-user-hub/issues/12-vaults.md`: «Sin backends externos») and the «Backends externos» line of the Vaults spec's Out of Scope. Organizations that already keep their secrets in a provider asked to stop copying them into the Hub, and Dynamic secrets (a Kubernetes token, a database user) only exist in a provider.

## Considered Options

- **Keep only the Hub's store** and copy values from the provider by hand or with an external sync (External Secrets into Kubernetes Secrets, then into a Vault): values go stale, rotation is manual, and Dynamic secrets are impossible.
- **Agents read the provider themselves** with credentials delivered as Secrets: every Sandbox then holds a long-lived provider credential whose policy, not the Hub, decides what each Thread may read, and the Hub can neither mask nor attribute what was read.
- **The Hub reads for the Thread** (chosen): one place decides what a Thread receives (`EffectiveVaults`), the provider's policy for the Provider scope's role is a second line, and masking, audit, Leases and revocation stay on the Hub.
- **varlock / a `.env.schema` per Project**: still a possible later layer for declaring what a Project needs; it does not remove the need to read from providers.

## Consequences

- Starting a turn, a terminal or a setup script that receives a Provider entry depends on that provider answering. A provider that does not answer fails the start with a typed error naming it, instead of starting without the value.
- The Hub holds the credentials of each Provider scope (in its encrypted store, or none at all with Kubernetes or workload-identity sign-in). Each scope should use its own provider role so the provider, not only the Hub, keeps Organizations apart.
- Values the Hub never stores still have to be masked in history: the Hub keeps every value it delivered for a Thread, sealed, only to mask it, and never reveals a Provider entry.
- The secret-provider registry that today serves only the Owner's settings (`packages/secret-provider-*`, 1Password) becomes the one registry for settings and Vaults alike.
