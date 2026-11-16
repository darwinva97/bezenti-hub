# Spec: Variables, Secretos sellados y Secret providers

Status: needs-triage
Map: ninguno; continúa el spec 5 «Vaults» (`../vaults/spec.md`, done)
ADRs: 0002 (el Hub es la fuente de verdad), 0004 (nada protege los secretos de un Space frente a su propio agente), 0006 (el Hub guarda los Threads; los Environments ejecutan), **0008** (entradas leídas de Secret providers, nueva), **0009** (identidad de trabajo firmada por el Hub, nueva)
Vocabulario: `GLOSSARY.md` (raíz) por encima de `docs/internals/glossary.md`: Vault, Secret, Sealed secret, Variable, Secret link, Secret provider, Provider scope, Provider entry, Dynamic secret, Lease, Provider-backed vault, Template entry, Secret file, Workload identity token
Depende de: spec 5 «Vaults» (done) y spec 4 «AI accounts y AI gateway» (los ajustes con credenciales).
**Contradice y reabre:** la decisión 2 del mapa (`../multi-user-hub/issues/12-vaults.md`: «Sin backends externos») y la línea «Backends externos» del Out of Scope del spec 5, por la ADR 0008. **Refina** «Solo el Owner revela» del spec 5: el Owner revela solo los Secrets revelables.

## Problem Statement

Tres problemas, vistos en el despliegue real de bezenti (`claude.bezenti.com`):

1. **Todo valor de un Vault es un secreto revelable.** El Owner puede revelar cualquier valor; no hay forma de guardar un secreto que nadie pueda volver a leer desde el Hub, como los secrets de GitHub. Y al revés, la configuración que no es secreta (una URL, una región, el nombre de un clúster) se trata como secreto: se enmascara en el historial y nadie más que el Owner puede leerla, así que los Members no saben qué reciben sus Threads.
2. **Los valores solo pueden vivir en el Hub.** Una Organization que ya guarda sus secretos en OpenBao, HashiCorp Vault, 1Password, Infisical o el gestor de su nube tiene que copiarlos a mano al Hub, y la copia se queda vieja al rotar. Las credenciales que solo existen en un proveedor (tokens de Kubernetes, usuarios de base de datos y claves de nube de corta duración) no se pueden dar a un Thread. Tampoco se puede guardar la clave maestra del Hub en un KMS.
3. **Para dar acceso a sistemas externos solo hay credenciales de larga duración.** El caso real: el Vault `bezenti-ti` entrega a los Threads un `KUBECONFIG` con un certificado `system:masters` válido hasta 2027 y la contraseña de root SSH del nodo. Un agente lo imprimió en un Thread, así que quedó en el contexto del modelo. No hay credenciales por Thread que caduquen solas, ni forma de que el clúster, OpenBao o una nube sepan qué User y qué Thread actúan.

## Solution

- Cada entrada de un Vault es una **Variable** (configuración visible para quien ve su nombre, nunca enmascarada) o un **Secret**. Un Secret es **revelable** (el Owner lo revela con su factor fuerte, como hoy) o **sellado** (nadie lo revela, ni el Owner; solo se sustituye o se borra). Los Secrets nuevos nacen sellados.
- Además de su propio almacén cifrado, el Hub lee valores de **Secret providers**: OpenBao y HashiCorp Vault, 1Password, Infisical, Doppler, Bitwarden Secrets Manager, AWS Secrets Manager y SSM Parameter Store, Google Secret Manager, Azure Key Vault, los Secrets de un clúster de Kubernetes y un comando permitido por el operador. El Owner los conecta en Settings y define **Provider scopes**: el rol con el que el Hub entra y las rutas que puede nombrar. Cada scope se permite a Vaults concretos.
- Una entrada puede ser:
  - un valor propio, una copia o un Secret link (como hoy);
  - una **Provider entry**: estática, o un **Dynamic secret** con **Lease** por Thread que el Hub renueva y revoca;
  - una **Template entry**, compuesta a partir de otras;
  - un **Workload identity token** firmado por el Hub (ADR 0009).
- Un Vault puede estar **respaldado por un proveedor**: sus entradas son las claves de una ruta, y opcionalmente el Hub escribe en ella. Hay caminos en los dos sentidos: mover una entrada del Hub al proveedor y copiar una del proveedor al Hub (sellada).
- Una entrada llega como **variable de entorno**, como **Secret file** en memoria (la variable lleva la ruta y el Hub la refresca antes de que caduque) o no llega, cuando solo alimenta una plantilla.
- El Owner puede **restringir a qué máquinas llega** un Vault o una entrada (Sandbox, máquinas dedicadas, personales) y **exigir aprobación** antes de entregar entradas sensibles. Es el equivalente a los environments con revisores de GitHub.
- La clave maestra del Hub puede quedar envuelta por OpenBao Transit o por el KMS de una nube.
- Todo valor entregado se sigue enmascarando en el historial, también los que el Hub no guarda. El Hub audita cada lectura, Lease y token emitido, sin valores.

## User Stories

### Variables y Secrets sellados

1. As the Owner or an Admin, I want to mark an entry as a Variable, so that configuration such as `KUBE_SERVER` or `AWS_REGION` is visible to everyone who sees the Thread's entries and is never masked.
2. As a Member, I want to see the values of the Variables my Threads receive, so that I know which cluster, region or URL my agent works against.
3. As the Owner, I want new Secrets to be sealed by default, so that a credential once saved can never be read back through the Hub, not even from my session.
4. As the Owner, I want to choose «Allow reveal» when I add a Secret, so that I can still keep revealable the few values I need to read back.
5. As the Owner, I want making a sealed Secret revealable to require a new value, so that sealing is never undone for a value someone trusted to stay sealed.
6. As an Admin, I want a warning when I save a credential-looking value (a name ending in `_TOKEN`, a value starting `ghp_`, `sk-`, `AKIA`…) as a Variable, so that I do not expose a credential by mistake.
7. As the Owner, I want turning a Secret into a Variable to require that I could reveal it, or a new value, so that changing the class is never a way around sealing.
8. As the Owner, I want copies and Secret links of a sealed Secret to stay sealed, so that copying is not a way to reveal it.
9. As the Owner, I want answers saved from `request_secret` to be sealed Secrets, so that what someone typed for an agent cannot be read back.

### Secret providers y scopes

10. As the Owner, I want to connect OpenBao or HashiCorp Vault with Kubernetes, JWT, AppRole, token or TLS-certificate sign-in, namespaces and a custom CA, so that the Hub reads from the vault my Organization already runs.
11. As the Owner, I want to connect 1Password (service account or Connect server), Infisical, Doppler, Bitwarden Secrets Manager, AWS Secrets Manager and SSM Parameter Store, Google Secret Manager, Azure Key Vault and a Kubernetes cluster's Secrets, so that every team can keep its provider.
12. As the Operator of the Hub's machine, I want to allow named commands (`sops`, `pass`, an internal CLI) that the Hub may run to read a secret, so that any other provider works without new code, and nobody can make the Hub run arbitrary commands from the UI.
13. As the Owner, I want «Test connection» on each provider and each scope, so that I find a wrong role or path before a Thread fails.
14. As the Owner, I want to define Provider scopes (role, allowed paths, allowed dynamic roles, writable or not) and allow each to specific Vaults, so that an Admin of one Organization can name only what is meant for it.
15. As an Admin, I want to add Provider entries to my Organization's Vaults within the scopes allowed to them, so that I do not need the Owner for every path.
16. As the Owner, I want each scope to sign in with its own provider role, so that the provider's policy also keeps Organizations apart if the Hub is wrong.
17. As the Owner, I want deleting a provider or a scope to list the entries that break and show them as «broken», so that nothing silently stops being delivered.
18. As the Owner, I want provider credentials (AppRole secret IDs, service-account tokens, API keys) to be sealed in the Hub's store, or not to exist at all when the Hub signs in with its Kubernetes service account or its own workload identity, so that the Hub holds as little as possible.

### Provider entries y Dynamic secrets

19. As an Admin, I want to add an entry that reads `kv/acme/github#token` from OpenBao, so that rotating it in OpenBao changes what the next turn receives with no step in the Hub.
20. As the Owner, I want to pin a version (`?version=3`) when I need to, so that a rotation does not reach a Project before I decide.
21. As the Owner, I want an entry backed by a Dynamic secret (OpenBao `kubernetes/creds`, `database/creds`, `aws/creds`, PKI `issue`), so that each Thread gets its own short-lived credential.
22. As the Owner, I want `DB_USER` and `DB_PASSWORD` read from the same dynamic path to come from one Lease, so that they match.
23. As the Owner, I want a Thread's Lease reused across its turns while it has life left, renewed when renewable, and replaced before it ends, so that sessions are not reopened on every turn and credentials never expire mid-use without warning.
24. As the Owner, I want the Hub to revoke a Thread's Leases when the Thread is archived or deleted, a User leaves, a Vault or scope is no longer allowed, or the Project changes Space, so that a credential does not outlive the access it was issued for.
25. As a User, I want a clear error naming the provider and entries when a provider does not answer, and a «Retry», so that a turn never starts half-configured.

### Plantillas y Secret files

26. As the Owner, I want a Template entry such as a kubeconfig built from `KUBE_SERVER`, `KUBE_CA` and a dynamic `KUBE_TOKEN`, delivered as a file in `KUBECONFIG`, so that `kubectl` works with no setup in the Thread.
27. As an Admin, I want a `DATABASE_URL` template with `urlencode` of the password, so that tools that take a URL get a valid one.
28. As the Owner, I want inputs of a template to be «not delivered», so that the raw token reaches the agent only inside the file.
29. As a User, I want a Secret file whose credential expires to be rewritten in place before it does, so that long turns and terminals keep working.
30. As the Owner, I want Secret files to live in memory, readable only by the Thread's user, and removed when the Thread's processes end, so that they never reach a disk or a backup.

### Identidad de trabajo

31. As the Owner, I want a Workload identity token entry with audience `kubernetes`, so that the cluster trusts the Hub and its audit log names `t3:<user>` and the Space, with no stored token.
32. As the Owner, I want the same token to work with AWS (`AWS_WEB_IDENTITY_TOKEN_FILE`), Google Cloud (workload identity federation) and Azure (`AZURE_FEDERATED_TOKEN_FILE`), so that agents reach cloud accounts without keys.
33. As the Owner, I want the Hub to sign in to OpenBao and cloud providers with its own workload identity, so that no provider credential is stored at all.
34. As the Owner, I want the signing keys rotated with an overlap and never exported, so that a rotation never breaks verifiers and the key never leaves the Hub.

### Vaults respaldados por un proveedor

35. As the Owner, I want a Vault bound to `kv/acme/app` in OpenBao, so that its entries are whatever keys that path holds.
36. As an Admin, I want to replace a value in a writable Provider-backed vault from the Hub, so that I manage OpenBao values without OpenBao's UI, and the change is attributed to me.
37. As the Owner, I want to move an entry stored in the Hub into a provider, and to copy a Provider entry into the Hub as a sealed Secret, so that I can migrate in either direction.

### Entrega controlada

38. As the Owner, I want to restrict a Vault or an entry to the Sandbox and dedicated machines, so that production credentials never reach a User's laptop.
39. As the Owner, I want an entry to require approval by me or the Organization's Admins before a Thread receives it, valid for that Thread for a while, so that sensitive access is deliberate, like GitHub environment reviewers.
40. As an approver, I want the request with the User, Thread, Project and entries, on web, desktop and mobile with a notification, so that I can decide anywhere.

### Clave maestra

41. As the Owner, I want the master key wrapped by OpenBao Transit or a cloud KMS, so that a copy of the Hub's disk and its backups is useless without the provider.

### Agente, ajustes, clientes y auditoría

42. As an agent, I want `list_secret_names` to say for each entry its class, source, delivery (variable or file path), expiry and the value of Variables, so that I know what I have without reading Secrets.
43. As the Owner, I want my settings credentials (AI accounts, source control tokens, provider instance environments) to read from any connected provider, so that the Hub's own credentials follow the same rules.
44. As the Owner on mobile, I want to manage classes, providers, scopes, approvals and entries as on web, with no «Reveal», so that I can work from the phone.
45. As the Owner, I want every provider read, Lease, renewal, revocation, identity token, approval, seal and move in the audit log without values, so that I can trace who received what.

## Implementation Decisions

### Modelo de una entrada: tres ejes independientes

| Eje     | Valores                                                              | Notas                                                                          |
| ------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Clase   | `variable` · `secret`                                                | Un Secret además es `revealable` (sí/no).                                      |
| Fuente  | `own` · `copy` · `link` (hoy) · `provider` · `template` · `identity` | `identity` siempre es Secret y siempre archivo.                                |
| Entrega | `env` · `file` · `none` (solo entrada de plantillas)                 | `none` solo si alguna Template entry del mismo Vault la nombra (si no, aviso). |

Además, por entrada y por Vault: `deliverTo` (subconjunto de `sandbox`, `dedicated`, `personal`, `hub`; por defecto todos) y `requiresApproval` (`none` · `owner` · `owner-or-admins`). Lo de la entrada solo puede **restringir** más que el Vault.

Combinaciones válidas (lo demás se rechaza al guardar, con red-first):

| Fuente     | Variable                            | Secret revelable                | Secret sellado | `env` | `file` | `none` |
| ---------- | ----------------------------------- | ------------------------------- | -------------- | ----- | ------ | ------ |
| `own`      | sí                                  | sí                              | sí             | sí    | sí     | sí     |
| `copy`     | sí                                  | solo si el original lo es       | sí             | sí    | sí     | sí     |
| `link`     | hereda                              | hereda                          | hereda         | sí    | sí     | sí     |
| `provider` | sí                                  | no (nunca se revela por el Hub) | sí (implícito) | sí    | sí     | sí     |
| `template` | si todas sus entradas son Variables | no                              | sí (implícito) | sí    | sí     | no     |
| `identity` | no                                  | no                              | sí (implícito) | no    | sí     | no     |

### Modelo de datos

Una migración (siguiente número libre; hoy 119) sobre las tablas del spec 5:

- `vault_entries`: añade `class` (`secret` | `variable`, por defecto `secret`), `revealable` (las filas existentes **1**, las nuevas **0**; pregunta 1), `delivery` (`env` | `file` | `none`, por defecto `env`), `deliver_to` (JSON, nulo = todos), `requires_approval`; amplía `kind` con `provider`, `template`, `identity`; columnas `provider_scope_id`, `provider_reference` (texto validado por el driver; ≤ 1024), `template_text` (solo nombres, sin valores: se guarda en claro), `identity_audience`, `identity_ttl_seconds`. Los CHECK reflejan la tabla de arriba.
- `vaults`: `deliver_to`, `requires_approval`, y para un Provider-backed vault `provider_scope_id` + `provider_path` + `backed` (si `backed`, el Vault no tiene entradas propias).
- `secret_provider_scopes`: id, provider id (de `settings.secretProviders`), etiqueta, `auth` (rol, mount o método que sobrescriben los del proveedor), `allowed_paths` (prefijos), `allowed_dynamic` (prefijos de rutas dinámicas con método), `writable`, fechas, creado por. `vault_provider_scopes`: qué scope se permite a qué Vault.
- `secret_leases`: id, raíz del Thread, User, scope, petición normalizada (método + ruta + parámetros), `lease_id` (sellado: con él se renueva y revoca), `expires_at`, `renewable`, `max_expires_at`, estado (`active` | `revoking` | `revoked` | `expired`), intentos.
- `delivered_values`: los valores que el Hub entregó a un Thread y no guarda en otro sitio (Provider entries, plantillas, Dynamic secrets, tokens de identidad), **sellados**, solo para enmascarar el historial de ese Thread. Se borran con el Thread. Amplía la idea de `thread_secret_values` (migración 116), que ya guarda referencias para el enmascarado.
- `secret_approvals`: raíz del Thread, User, entrada, decisión, quién decide, `valid_until`.
- La configuración de cada proveedor sigue en `settings.secretProviders` (forma `{ kind, label, config }`, ya existente). Sus credenciales son `SettingsSecretValue` en el almacén cifrado. Una credencial de un proveedor no puede ser una referencia a ese mismo proveedor (ciclo; se rechaza).

### Quién hace qué (amplía la tabla de `AccessPolicy` del spec 5)

| Acción                                                                          | Owner                        | Admin (de la Organization)                       | Member | Guest |
| ------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------ | ------ | ----- |
| Conectar, editar y borrar Secret providers; crear Provider scopes y permitirlos | sí                           | no                                               | no     | no    |
| Añadir Provider entries en un Vault permitido                                   | sí, cualquier ruta del scope | solo dentro de los scopes permitidos a ese Vault | no     | no    |
| Ligar un Vault a un proveedor (Provider-backed)                                 | sí                           | no                                               | no     | no    |
| Sustituir valores de un Provider-backed vault con scope `writable`              | sí                           | sí                                               | no     | no    |
| Variables: ver el valor                                                         | sí                           | sí                                               | sí     | sí    |
| Variables: añadir y editar                                                      | sí                           | sí                                               | no     | no    |
| Revelar un Secret revelable                                                     | sí, factor fuerte reciente   | no                                               | no     | no    |
| Revelar un Secret sellado, Provider entry, plantilla o identidad                | **nadie**                    | no                                               | no     | no    |
| Hacer revelable un Secret sellado                                               | sí, con un valor nuevo       | no                                               | no     | no    |
| Workload identity entries (crear, audiencias, TTL)                              | sí                           | no                                               | no     | no    |
| `deliverTo` y `requiresApproval`                                                | sí                           | solo restringir más                              | no     | no    |
| Aprobar entregas                                                                | sí                           | si la regla es `owner-or-admins`                 | no     | no    |
| Mover una entrada al proveedor / copiar una Provider entry al Hub               | sí                           | mover: si el scope es `writable`; copiar: no     | no     | no    |

### Variables

- Un valor de Variable viaja en las respuestas WS de Vaults (campo `value` solo con `class = variable`). `DoorRules.test.ts` pasa a comprobar que ninguna respuesta lleva `value` salvo de Variables.
- Nunca se enmascara, ni se cuenta en `rememberKnownSecrets`.
- Aviso (no bloqueo) `looks-like-credential` por nombre (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_KEY`, `*_PAT`) o por valor (prefijos conocidos `ghp_`, `github_pat_`, `glpat-`, `sk-`, `xox`, `AKIA`, `-----BEGIN`, JWT de tres partes, o alta entropía con ≥ 20 caracteres).
- Pasar de Variable a Secret: quien edita. Pasar de Secret a Variable: solo el Owner, y solo si podría revelarlo (revelable y con factor fuerte); si no, con un valor nuevo.

### Secrets sellados

- `vaults.reveal` (HttpApi) responde `sealed` para un Secret sellado, una Provider entry, una plantilla o una identidad, **antes** de leer nada. Red-first.
- «Allow reveal» en un Secret sellado exige un valor nuevo en la misma petición. El valor antiguo nunca se lee para ello.
- Copiar un sellado da un sellado. Un Secret link muestra la clase y el sellado de su original.
- **Lo que sellar no cubre (aceptado, en Settings y en los docs):**
  - quien tenga el disco del Hub y la clave maestra descifra el almacén;
  - el agente que recibe el valor puede imprimirlo, y el proveedor de IA ve lo que el agente lee, igual que un workflow de GitHub Actions puede hacer `echo` de un secret.
  - Sellar protege la lectura desde la UI y las APIs del Hub. Las credenciales de corta duración (Dynamic secrets, identidad) limitan el daño de lo demás.

### Provider entries

- **Referencia:** texto con la sintaxis del driver, validado con `isReference` al guardar y al leer. Se normalizan las rutas (sin `..`, `//` ni `%2e`) y se comprueba que caigan dentro de un `allowed_paths` del scope, **también al leer** (por si el scope cambió).
- **Cuándo se lee:** en `SecretDelivery.resolve`, al arrancar un proceso (sesión de provider, terminal, setup script), nunca al planear. Lecturas agrupadas por proveedor y scope, en paralelo entre proveedores, y en lote dentro de cada uno si el driver lo permite.
- **Caché:** en memoria, por `(scope, referencia)`, hasta el `expiresAt` que devuelva el driver, o el `refreshInterval` del proveedor (por defecto 5 min) si no devuelve ninguno. Sustituye a la caché de por vida de `SecretResolver` para estos casos; los ajustes conservan su invalidación manual. «Refresh» en Settings y la revocación de un scope vacían la caché.
- **Huella** (`SecretPlan.fingerprint`): para un valor propio sigue siendo nombre + id de valor; para lo que el Hub no guarda, un HMAC del valor con una clave del Hub (nunca el valor ni su hash simple). Así, si un valor rota en el proveedor, la sesión se reabre en el siguiente turno, igual que al rotar un valor propio.
- **Fallos:** `SecretProviderUnavailableError { provider, scope, entries }` para timeout (10 s por defecto) o 5xx; `forbidden` y `not-found` con su propio código. El arranque falla entero, sin entregar una parte (pregunta 3). El Thread muestra el error con «Retry».
- **Rotas:** si el proveedor o el scope ya no existe, o el scope ya no está permitido al Vault, la entrada se ve «broken» y no se entrega.

### Contrato de driver (amplía `packages/secret-provider-core`)

```ts
interface SecretProviderDriver {
  kind;
  definition; // ya existe
  read(ctx, refs): Effect<ReadonlyArray<ReadResult>>; // ReadResult = { value, expiresAt?, version?, lease? } | { error: "not-found" | "forbidden" | "unavailable" | "invalid" }
  issue?(ctx, request): Effect<IssueResult>; // Dynamic secrets: { fields: Record<string,string>, lease: { id, ttl, renewable, maxTtl? } }
  renew?(ctx, leaseId): Effect<LeaseInfo>;
  revoke?(ctx, leaseId): Effect<void>;
  list?(ctx, path): Effect<ReadonlyArray<{ key; metadata }>>; // Provider-backed vaults
  write?(ctx, path, key, value, cas?): Effect<{ version }>; // scopes writable
  test(ctx): Effect<TestReport>; // «Test connection»: auth y, por scope, una lectura de prueba de una ruta permitida
}
```

- `ctx` lleva la configuración decodificada, las credenciales resueltas y el scope.
- Las llamadas HTTP pasan por el cliente saliente del servidor (`outboundHttp.ts`).
- Ningún valor va a errores, logs o spans (test de humo por driver).
- Los drivers de CLI (1Password, Bitwarden, `command`) mantienen la regla actual: nada en argv salvo identificadores, entorno limpio y timeout.

### Proveedores, autenticación y sintaxis

| Kind                  | Etiqueta                  | Autenticación del Hub                                                                                                                    | Referencia estática                                                                                      | Dinámico                                                                                                                                                                                 | `list`/`write`            |
| --------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `openbao`             | OpenBao / HashiCorp Vault | `kubernetes` (token proyectado, audiencia), `jwt` (archivo o identidad del Hub), `approle`, `token` (renovable), `cert`; `namespace`, CA | `kv/acme/app#token`, `?version=N`; KV v1 y v2 declarados por mount en la config (sin pedir `sys/mounts`) | sí: `POST kubernetes/creds/<rol>?kubernetes_namespace=x#service_account_token`, `GET database/creds/<rol>#password`, `aws/creds`, `aws/sts`, `pki/issue/<rol>?common_name=…#certificate` | sí / sí (KV v2 con `cas`) |
| `one_password`        | 1Password                 | CLI de escritorio (hoy), **service account** (`OP_SERVICE_ACCOUNT_TOKEN` al `op`), **Connect** (HTTP + token)                            | `op://vault/item/field` (hoy)                                                                            | no                                                                                                                                                                                       | sí (ítem) / sí            |
| `infisical`           | Infisical                 | Universal auth (client id/secret), Kubernetes auth, identidad del Hub (OIDC auth)                                                        | `<project>/<env>/<path>#KEY`                                                                             | sí (dynamic secrets de Infisical)                                                                                                                                                        | sí / sí                   |
| `doppler`             | Doppler                   | service token por config                                                                                                                 | `<project>/<config>#KEY`                                                                                 | no                                                                                                                                                                                       | sí / sí                   |
| `bitwarden_sm`        | Bitwarden Secrets Manager | machine account access token (CLI `bws`)                                                                                                 | id de secret o `<project>/<key>`                                                                         | no                                                                                                                                                                                       | sí / sí                   |
| `aws_secrets_manager` | AWS Secrets Manager       | claves estáticas, perfil, `AssumeRoleWithWebIdentity` con la identidad del Hub o un token proyectado                                     | `arn:…` o `name#jsonKey`, `?versionStage=AWSCURRENT`                                                     | no                                                                                                                                                                                       | sí / sí                   |
| `aws_ssm`             | AWS SSM Parameter Store   | igual que arriba                                                                                                                         | `/ruta/param` (SecureString descifrado)                                                                  | no                                                                                                                                                                                       | sí (por ruta) / sí        |
| `gcp_secret_manager`  | Google Secret Manager     | workload identity federation (identidad del Hub o token proyectado), clave de SA                                                         | `projects/p/secrets/s#jsonKey`, `/versions/N                                                             | latest`                                                                                                                                                                                  | no                        | sí / sí |
| `azure_key_vault`     | Azure Key Vault           | federated credential (identidad del Hub), client secret, certificado                                                                     | `https://<vault>.vault.azure.net/secrets/<name>[/<ver>]`                                                 | no                                                                                                                                                                                       | sí / sí                   |
| `kubernetes`          | Kubernetes Secrets        | in-cluster (SA del Hub), kubeconfig de un SA (sellado), identidad del Hub                                                                | `<namespace>/<secret>#<key>`                                                                             | sí: `TokenRequest` de un ServiceAccount (`serviceaccounts/<sa>/token?audience=…&ttl=…`)                                                                                                  | sí / no (pregunta 11)     |
| `command`             | Comando permitido         | lo que haga el comando (el entorno lo pone el operador)                                                                                  | argumentos tras el nombre del comando permitido                                                          | no                                                                                                                                                                                       | no / no                   |

- **`command`:** el operador lo habilita con `T3CODE_SECRET_COMMANDS` (JSON: nombre → ruta absoluta del ejecutable y plantilla de argumentos). La UI solo elige entre esos nombres; la referencia solo rellena los huecos de la plantilla, sin shell y con timeout. Así nadie convierte el Hub en un ejecutor de comandos desde el navegador.
- **Kubernetes `TokenRequest`:** es un Dynamic secret sin Lease revocable (los tokens vinculados caducan solos). Es el camino más simple para el caso de bezenti cuando no hay OpenBao.

### Dynamic secrets y Leases

- Petición normalizada = método + ruta + parámetros ordenados. Las entradas del conjunto efectivo con la misma petición, el mismo scope y el mismo User comparten **una** emisión, y cada una toma su campo (`#username`, `#password`).
- Clave de un Lease: raíz del Thread + User + scope + petición. Se emite la primera vez que un proceso del Thread lo necesita.
- **Reutilizar, renovar o reemitir:** se reutiliza mientras le quede más de 1/3 de su vida. Si no, se renueva si es renovable y cabe en su `max_ttl`; si no, se emite otro.
  - Si el valor cambia, con `env` la sesión se reabre en el siguiente turno (por la huella), y con `file` el archivo se reescribe en caliente.
- **Revocación:** al archivar o borrar el Thread, en cada «Losing reach» del spec 5 (baja del User, Vault o scope que dejan de estar permitidos, cambio de Space del Project), y cuando el Thread lleva una hora sin procesos vivos (configurable).
  - Al arrancar, el Hub barre los Leases `revoking` y los que caducaron.
  - Un fallo al revocar se reintenta con backoff y se audita; la caducidad del proveedor es el límite final.
- Los procesos que ya corren conservan su entorno (como acepta el spec 5). Un Lease revocado deja de funcionar para ellos, que es lo que se busca.

### Template entries

- **Sintaxis mínima:** `{{ NOMBRE }}` y `{{ NOMBRE | filtro }}`, con los filtros `base64`, `base64decode`, `urlencode`, `json` (escapa como cadena JSON), `trim` y `path` (la ruta del Secret file de esa entrada en la máquina del Thread).
  - Sin lógica, bucles ni funciones; `{{` literal se escribe `{{"{{"}}`.
  - Solo nombra entradas del **mismo Vault**, nunca otras plantillas (sin ciclos).
- **Clase:** si alguna entrada es Secret, la plantilla es Secret sellado; solo es Variable si todas lo son.
- **Previsualizar** está disponible para quien edita: muestra la plantilla con `[NOMBRE]` en lugar de cada valor. No hay revelado.
- **Si una entrada falla**, falla la plantilla, con el mismo error que la entrada.
- **Ejemplo (kubeconfig):**

  ```yaml
  apiVersion: v1
  kind: Config
  clusters:
    [
      {
        name: c,
        cluster: { server: "{{ KUBE_SERVER }}", certificate-authority-data: "{{ KUBE_CA }}" },
      },
    ]
  users: [{ name: u, user: { tokenFile: "{{ KUBE_TOKEN | path }}" } }]
  contexts: [{ name: c, context: { cluster: c, user: u } }]
  current-context: c
  ```

  Aquí `KUBE_TOKEN` es un Workload identity token o un Dynamic secret entregado como archivo. `tokenFile` hace que `kubectl` relea el archivo, así que el refresco en caliente funciona sin reescribir el kubeconfig.

### Secret files (executor contract 13 → 14)

- `secretEnv` gana `files: [{ name, content, mode }]`. El executor escribe cada archivo en su carpeta en memoria por raíz de Thread y User (`$XDG_RUNTIME_DIR/t3-secrets/<aleatorio>/`, o `/dev/shm`; en el Sandbox, el tmpfs del contenedor), con permisos 0600/0700, sin seguir enlaces (reutiliza las comprobaciones de `SecretFilesDirectory`). Después pone `NOMBRE=<ruta>` en el entorno del proceso.
- **Operación nueva** `secrets.refreshFiles { threadRoot, user, files }`: el executor reescribe con `rename` atómico. El Hub la llama cuando renueva o reemite un Lease o un token de identidad mientras quedan procesos vivos del Thread.
- **Limpieza:** la carpeta se borra cuando acaba el último proceso de ese Thread y User en esa máquina, y el executor barre la suya al arrancar.
- **Máquina con contrato < 14** y alguna entrada `file`: error tipado «<máquina> needs an update to receive this Thread's secret files». Sin archivos, sigue funcionando.
- **Sin carpeta en memoria** (macOS, Windows): carpeta 0700 en disco que el executor vacía al arrancar, con aviso en el Thread. Es la regla actual de `request_secret` con `delivery: file`.
- `request_secret` con `delivery: file` no cambia.

### Workload identity tokens (ADR 0009)

- **Emisor:** `T3CODE_PUBLIC_URL`, o `T3CODE_IDENTITY_ISSUER` para un dominio distinto.
- **Rutas públicas sin sesión:** `GET /.well-known/openid-configuration` y `GET /.well-known/jwks.json`. Opcional: `T3CODE_IDENTITY_DISCOVERY_URL_INTERNAL`, que se documenta para verificadores dentro de la red, como el API de Kubernetes cuando el dominio público está tras Cloudflare Access.
- **Claves:** ES256, generadas por el Hub y selladas en el almacén cifrado. Rotan cada 30 días; la nueva se publica 7 días antes de firmar con ella y la anterior se mantiene 7 días después. Nunca se exportan: no van en `t3 secrets key export` y, tras una restauración, se generan de nuevo.
- **Claims:**
  - `iss`, `aud` (una sola), `iat`, `nbf`, `exp`, `jti`;
  - `sub` = `t3:space:<slug>:project:<slug>:user:<username>`, o `…:project:-:…` sin Project;
  - además `installation`, `user_id`, `username`, `space_id`, `space_slug`, `organization` (o `personal`), `project_id`, `thread_id`, `root_thread_id`, `environment_id`, `environment_kind`, `role`.
  - Nunca nombres de Vaults ni de entradas.
- **Entrada `identity`:** audiencia (una), TTL (por defecto 10 min, máximo 1 h). Siempre Secret sellado y siempre Secret file, refrescado a 2/3 de su vida mientras haya procesos vivos.
- **Identidad del propio Hub** para entrar en proveedores: `sub` = `t3:hub:<installation>`, claim `scope` = id del Provider scope. La política del proveedor puede distinguir scopes sin un rol por credencial.
- **Recetas en `docs/user`:**
  - Kubernetes `AuthenticationConfiguration`: username `t3:` + `username`; grupos `t3:space:<slug>` y `t3:org:<slug>`; `claimValidationRules` que exigen `environment_kind`.
  - OpenBao JWT auth con `bound_claims` y políticas con plantillas de metadatos.
  - AWS IAM OIDC provider + `AWS_ROLE_ARN` como Variable + `AWS_WEB_IDENTITY_TOKEN_FILE`.
  - Google Cloud: plantilla del JSON `external_account` con `{{ TOKEN | path }}`.
  - Azure: `AZURE_FEDERATED_TOKEN_FILE` + `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` como Variables.

### Provider-backed vaults

- Un Vault ligado a un scope y una ruta del proveedor; sus entradas son lo que devuelve `list` (en OpenBao KV v2, las claves del secreto en esa ruta).
- **Clase y entrega:** de los metadatos del proveedor cuando los hay (KV v2 `custom_metadata`: `t3.class.<CLAVE>=variable`, `t3.delivery.<CLAVE>=file`). Si no, Secret sellado entregado por `env`.
- **Claves que no son nombres de variable válidos** (`secretNameProblem`): se listan como «invalid name» y no se entregan.
- **Lista:** se lee al abrir el Vault, al planear un turno (caché de 60 s) y con «Refresh».
- **Escritura:** solo con scope `writable`. «Add» y «Replace value» escriben una versión nueva con _check-and-set_ (si alguien escribió antes, error «changed in the provider», sin pisar). «Delete» borra la clave, previa confirmación.
- **Migrar en los dos sentidos:**
  - «Move to provider» en una entrada propia: escribe el valor en la ruta del scope, la entrada pasa a ser Provider entry y se audita.
  - «Copy into the Hub» de una Provider entry: solo el Owner; crea una copia **sellada** sin mostrar el valor.

### Restricciones de entrega y aprobaciones

- **`deliverTo`** se aplica en `EffectiveVaults.forThread` según el tipo de la Active environment.
  - Lo excluido se lista al agente y en el panel «Secrets» como «not delivered on this machine».
  - Mover un Thread a una máquina excluida lo saca del conjunto, por la misma vía que «Losing reach».
- **`requiresApproval`:** al planear, cada entrada que lo exige y no tiene una aprobación vigente para (raíz del Thread, User, entrada) crea una solicitud.
  - El turno espera (máximo 30 min, configurable) con una tarjeta «Waiting for approval to use PROD_DB».
  - Los aprobadores reciben un aviso en web, desktop y móvil, con notificación.
  - Aprobar vale para ese Thread y ese User hasta `valid_until` (por defecto 8 h). Denegar o caducar falla el arranque con un error tipado.
  - El Owner puede aprobar lo suyo; un Admin no aprueba sus propios Threads (pregunta 9).
  - Se audita, y hay «Revoke approval» (puerta de vuelta).

### Clave maestra en un proveedor

- `T3CODE_MASTER_KEY_SOURCE` = `file` (hoy) | `openbao-transit` | `aws-kms` | `gcp-kms` | `azure-keyvault`.
- **Sobre envuelto:** el archivo de clave guarda la clave de datos **envuelta**. Al arrancar, el Hub la desenvuelve llamando al proveedor con credenciales que vienen del entorno o de archivos del despliegue, nunca del propio almacén.
- **Si el proveedor no responde, el Hub no arranca** (pregunta 10). No hay respaldo en claro.
- **Comandos:** `t3 secrets key rotate` vuelve a envolver; `t3 secrets key wrap|unwrap` pasa de `file` a un KMS y vuelve (puerta de vuelta).
- **Backup:** con un KMS, la copia de la clave es la versión envuelta, y Settings lo explica.

### Agente

- `list_secret_names` devuelve por entrada: `name`, `class`, `source` (`hub` | `provider:<label>` | `template` | `identity`), `delivery` (`env` | `file` + ruta en la máquina), `expiresAt` (Leases e identidad), `status` (`ok` | `broken` | `waiting-approval` | `not-delivered-here`) y `value` solo para Variables.
- `request_secret` guarda la respuesta como Secret sellado y, en un Provider-backed vault con scope `writable`, la escribe en el proveedor.
- El agente no crea Provider entries, scopes, plantillas ni identidades.

### Ajustes del Owner

- `SecretSourceInput` ofrece todos los proveedores conectados (las referencias de los ajustes ya usan `SecretReference`).
- Los ajustes no usan scopes porque solo los edita el Owner.
- La regla de `requireSettingsSecret` («nunca cambiar de cuenta en silencio») se mantiene.

### Clientes

- **Web y desktop:**
  - Settings → Vaults: clase, «Allow reveal», fuente (Value, Secret link, Copy, Provider, Template, Workload identity), entrega, «Deliver to», «Requires approval», previsualización de plantillas, estado «broken».
  - Settings → Secret providers: conexión, credenciales, «Test connection», scopes con sus Vaults.
  - Panel «Secrets» del Thread: caducidades, aprobaciones pendientes, «not delivered here».
- **Móvil:** lo mismo, sin «Reveal». Aprobaciones con notificación push.
- **Nombres accesibles:** se fijan en cada ticket, como en el spec 5.

### Auditoría (sin valores)

- `secret.edit` ganó `op`: `seal`, `allow-reveal`, `class`, `move-to-provider`, `copy-into-hub`.
- Nuevas:
  - `secret_provider.create|update|delete|test`, `provider_scope.create|update|delete|allow`, `vault.bind`;
  - `secret.read`: proveedor, scope, ruta normalizada, entrada, Thread, User, `jti` de la petición, resultado;
  - `lease.issue|renew|revoke`: `lease_id` truncado, TTL, motivo;
  - `identity.issue`: `aud`, `sub`, `jti`, `exp`;
  - `secret.approval.request|decide|revoke`.

### Puertas

- **WS:**
  - `secretProviders.list|put|delete|test`, `secretProviders.scopes.list|put|delete|allow` (Installation, solo Owner);
  - `vaults.entries.put` ampliado, `vaults.entries.preview`, `vaults.entries.move`, `vaults.entries.copyIntoHub`, `vaults.bind|unbind`, `vaults.refresh`;
  - `secretApprovals.list|decide|revoke`.
- **HttpApi:** `vaults.reveal` (responde `sealed`).
- **Raw routes públicas:** las dos de `/.well-known/` de identidad.
- **MCP:** `list_secret_names` y `request_secret` cambian.
- **Executor:** contrato 14 (`files`, `secrets.refreshFiles`).
- `DoorRules.test.ts` y `MaskedPaths.test.ts` se amplían.

### Enmascarado

- Lo que el Hub no guarda (Provider entries, plantillas, Leases, identidad) se registra sellado en `delivered_values` del Thread al entregarlo, y entra en `SecretPatterns`.
- **Valores multilínea** (archivos, PEM, kubeconfig): se enmascaran el valor entero y cada línea de 20 caracteres o más sin espacios (pregunta 6).
- **Variantes:** también la forma `base64` (las tres alineaciones) y la `urlencode` de los Secrets de una línea con 6 caracteres o más (pregunta 6).
- **Rendimiento:** con muchas variantes, el patrón compuesto sigue siendo un único autómata (medirlo en el ticket).

### Rendimiento

- **Ninguna lectura de proveedor en el camino de pintar la UI:** las listas muestran metadatos guardados y la de un Provider-backed vault va cacheada.
- **Arranque de un turno con Provider entries:** una ronda por proveedor, en paralelo, y caché por TTL. El estado «Reading secrets from OpenBao…» aparece si tarda más de 300 ms.
- **WebSocket:** no se envían valores de Secrets nunca. Las Variables viajan solo en `vaults.entries.list`, no en las suscripciones del Thread.

## Testing Decisions

- **Red-first** en todo lo que es permiso o frontera:
  - reveal de sellado, Provider entry, plantilla e identidad;
  - Admin fuera de scope, también con rutas con `..` y codificadas;
  - copia de sellado y Secret → Variable sin valor nuevo;
  - `deliverTo` en una máquina personal y aprobación ausente;
  - contrato 13 con archivos y `command` fuera de la lista del operador;
  - plantilla que nombra otro Vault u otra plantilla;
  - identidad con audiencia no permitida y JWKS sin la clave privada.
- **Drivers:**
  - cada uno contra un servidor HTTP falso en proceso (`it.live`, fixture de red): auth, lectura, lote, errores clasificados, renovación del token del Hub, ningún valor en logs ni spans;
  - pruebas opcionales contra el servicio real: OpenBao en modo dev (`T3CODE_TEST_LIVE_OPENBAO=1`) y las demás con su variable;
  - los drivers de CLI, con un binario de prueba (como el CLIProxyAPI falso del spec 4).
- **Leases:**
  - con `TestClock`: reutilizar, renovar y reemitir en sus umbrales;
  - revocación en cada evento de «Losing reach» y barrido al arrancar;
  - fallo de revocación con reintento.
  - Sin esperas reales.
- **Secret files:** en el testkit «Hub con Environments»: el archivo existe con 0600 en tmpfs, la variable lleva la ruta, `refreshFiles` cambia el contenido sin cambiar la ruta, la carpeta desaparece al acabar el último proceso, y nada aparece en `/proc/<pid>/cmdline`.
- **Identidad:** el token verifica con el JWKS publicado, la rotación mantiene las dos claves durante el solape y los claims salen del Thread real. Prueba real: un API de Kubernetes (kind o k3s) con `AuthenticationConfiguration` acepta el token y aplica el RBAC por grupo de Space.
- **Enmascarado:** líneas de un kubeconfig, variantes base64 y urlencode, y valores dinámicos de un Thread ya cerrado siguen enmascarados en su historial.
- **Tests:** se extienden las tablas existentes (`Vaults.test.ts`, `SecretDelivery.test.ts`, `EffectiveVaults.test.ts`, `SecretMasker.test.ts`, `DoorRules.test.ts`) antes de crear archivos nuevos, como pide `AGENTS.md`.

## Out of Scope

- **Usar un secreto sin que el agente lo vea** (proxy de credenciales: el Hub firma o inyecta en la petición saliente). Sigue como mejora futura de «Cierre del mapa». Con este spec, los Dynamic secrets y la identidad reducen lo que vale un valor filtrado, pero el agente lo sigue viendo.
- **Certificados SSH firmados por OpenBao** (`ssh/sign`): necesitan la clave pública de la máquina del Thread como entrada. Se puede hacer después con la misma operación `issue` y un parámetro que aporte el executor.
- **Response wrapping de OpenBao** y entrega de un token de un solo uso al agente para que lea él mismo: contradice ADR 0008 (los agentes no hablan con el proveedor).
- **Escaneo de secretos en commits** (como el push protection de GitHub).
- **Leases por proceso** en lugar de por Thread y User.
- **`.env.schema` por Project** (varlock): sigue fuera, como en el spec 5.
- **Sincronizar del Hub hacia el proveedor** fuera de «Move to provider» y de los Provider-backed vaults escribibles.

## Further Notes

- **Riesgo aceptado (ADR 0004):** en un Sandbox compartido, otro proceso del Space puede leer el entorno y los Secret files de otro User (`/proc/<pid>/environ`, misma UID). Settings lo dice al permitir a un User un Vault con entradas `file` o `identity`.
- **La disponibilidad de los turnos depende de los proveedores** que use cada Thread. Un Thread sin Provider entries no se ve afectado.
- **El caso bezenti** (ticket 18): sustituir `KUBECONFIG` (admin) y `SSH_PASSWORD` del Vault `bezenti-ti` por un Workload identity token con audiencia del clúster, un kubeconfig como Template entry y RBAC por Space. Fallback: `kubernetes` `TokenRequest` de un ServiceAccount de solo lectura. Exige cambios en `infra-contabo` que no están en este repo.
- **Orden sugerido de los tickets:**
  1. 01 Variables y Secrets sellados.
  2. 02 Núcleo de Provider entries.
  3. 03 Secret providers y Provider scopes en Settings.
  4. 04 Driver OpenBao / HashiCorp Vault.
  5. 05 Secret files y Template entries (contrato 14).
  6. 06 Dynamic secrets y Leases.
  7. 07 Workload identity tokens.
  8. 08 Provider-backed vaults y migración en los dos sentidos.
  9. 09 1Password sin escritorio.
  10. 10 Proveedores de nube.
  11. 11 Infisical, Doppler, Bitwarden SM y Kubernetes.
  12. 12 Proveedor `command`.
  13. 13 Clave maestra en un proveedor.
  14. 14 Restricciones de entrega y aprobaciones.
  15. 15 Ajustes del Owner con todos los proveedores.
  16. 16 Agente y clientes.
  17. 17 Inventario de puertas, documentación y pase completo.
  18. 18 Receta bezenti: clúster y OpenBao (ready-for-human).

  Los tickets 09 a 15 son independientes entre sí una vez hecho el 03 (y el 07 para lo que usa la identidad del Hub).

## Preguntas abiertas

Cada «Recomendación» es la propuesta; el Owner las acepta o cambia antes de pasar el spec a `ready-for-agent`.

1. **¿Qué pasa con las entradas que ya existen?** Recomendación: siguen siendo Secrets revelables (no cambia nada para nadie). Los Secrets nuevos nacen sellados, con «Allow reveal» desmarcado.
2. **¿Pueden los Admins crear Provider entries?** Recomendación: sí, pero solo dentro de los Provider scopes que el Owner permitió a ese Vault. Sin scope permitido, solo el Owner. Cada scope con su propio rol en el proveedor.
3. **Proveedor que no responde.** Recomendación: falla el arranque con error tipado y «Retry». No se entrega el último valor conocido ni se arranca sin la entrada.
4. **¿Ven los Members y Guests los valores de las Variables?** Recomendación: sí, como en GitHub, donde quien ve el repo ve sus variables. Por eso existe el aviso `looks-like-credential`.
5. **Vida de un Lease.** Recomendación: por raíz de Thread y User; se reutiliza mientras le quede más de 1/3 de vida y se revoca tras una hora sin procesos.
6. **Enmascarado de multilínea y variantes.** Recomendación: el valor entero, las líneas de 20 caracteres o más sin espacios, y las variantes base64 y urlencode de los Secrets de una línea con 6 caracteres o más.
7. **Token de identidad.** Recomendación: TTL de 10 min por defecto y 1 h como máximo; una audiencia por entrada; solo el Owner crea entradas de identidad.
8. **Provider-backed vaults escribibles.** Recomendación: no por defecto; el Owner marca el scope como `writable`.
9. **Aprobaciones.** Recomendación: válidas 8 h por Thread y User; espera máxima de 30 min. El Owner puede aprobar lo suyo; un Admin no aprueba sus propios Threads.
10. **Clave maestra en un KMS y proveedor caído al arrancar.** Recomendación: el Hub no arranca. No hay respaldo en claro.
11. **¿Se escribe en Kubernetes Secrets desde el Hub?** Recomendación: no. Solo lectura y `TokenRequest`. Escribir Secrets del clúster es trabajo de GitOps.
12. **¿Las rutas de identidad públicas se publican siempre?** Recomendación: solo cuando existe al menos una entrada `identity` o un proveedor que usa la identidad del Hub. Mientras tanto responden 404.
