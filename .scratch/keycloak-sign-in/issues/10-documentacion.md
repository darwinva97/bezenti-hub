# 10: Documentación

**What to build:** Reescribir, no ampliar, la documentación que deja de ser cierta: los Users entran por Keycloak, el Owner configura el realm, el registro, los mapeos de grupos y el inicio local, y las bajas en Keycloak llegan al Hub. Ver spec, «Further Notes».

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `docs/user/public-hub.md`: apartado «Sign in with Keycloak» para el Owner: crear el cliente confidencial en el realm, las tres URLs, `offline_access`, el mapper de grupos (con «Add to ID token»; claim ausente = sin grupos, configurarlo antes de añadir mapeos), los mappers de `acr`/`amr` y su lista, y que el Owner siempre puede entrar con su passkey.
- [ ] `docs/user/install.md`: reescribir «Create the Owner account», «Your sessions», «Invite people» (Invitations de Organization y de plataforma), «Disabling and removing people» (bajas en Keycloak frente a desactivar en el Hub) y añadir lo justo sobre Registration mode, inicio local y «Connect Keycloak»; quitar lo que ya no aplica a Users de Keycloak (contraseña, TOTP, reset de credenciales).
- [ ] `docs/user/remote-access.md` («Sign in to a Hub from the desktop or mobile app»): «with your passkey or your password» pasa a Keycloak.
- [ ] `docs/internals/environment-auth.md`: reescribir «User accounts», «Sign-in rules», «Invitations», «Memberships» (gestionadas por Keycloak) y «App sign-in» (herencia del login) donde cambian; añadir solo lo que el código no cuenta: por qué `offline_access`, por qué la re-comprobación va en segundo plano y falla abierta, y por qué un User con identidad no pasa `requireStepUp` sin prueba.
- [ ] `docs/adr/0003` no se toca (lo sustituye en parte 0009); `GLOSSARY.md` tiene Registration mode y Platform invitation (en inglés), y la entrada de Invitation deja de decir que solo es para una Organization.
- [ ] Ninguna página nueva salvo que un apartado existente no pueda alojarlo.
