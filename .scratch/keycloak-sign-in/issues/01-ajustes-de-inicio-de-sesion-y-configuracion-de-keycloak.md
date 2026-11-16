# 01: Ajustes de inicio de sesión y configuración de Keycloak

**What to build:** El Owner abre la sección «Inicio de sesión» de la Plataforma (hasta que exista el modal de `../settings-modals/`, en **Users and permissions**), escribe el issuer, el client id y el client secret de Keycloak, pulsa «Comprobar» y ve si el descubrimiento y el key set responden, junto con las tres URLs que debe copiar a Keycloak. Guarda también el Registration mode y el ajuste de inicio de sesión local para los demás, que todavía no cambian nada: los aplican los tickets 03 y 08. Nadie más puede leer ni cambiar estos ajustes, y el secret no vuelve a salir del Hub. Ver spec, «Dónde vive la configuración» y «Modelo».

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Migración con `sign_in_settings` (una fila, `invitation-only` y local permitido por defecto) y `keycloak_group_mappings` (vacía; la usa el ticket 05).
- [ ] Servicio `SignInSettings`: leer, guardar y `check`. El client secret va a `ServerSecretStore` como `keycloak-client-secret`; la lectura devuelve `clientSecretSet`, nunca el valor. Guardar sin `clientSecret` conserva el anterior.
- [ ] `KeycloakClient` con descubrimiento (el `issuer` del documento debe ser idéntico al configurado) y carga del key set con `effect/jose` (`Jwks.layerRemote`; en loopback HTTP, descarga propia y `Jwks.makeLocal`). Un issuer HTTP fuera de loopback se rechaza al guardar.
- [ ] Endpoints `GET/POST /api/installation/sign-in-settings` y `POST /api/installation/sign-in-settings/check`: Owner y `access:write`/`access:read`; cualquier otro recibe el mismo 403. Declarados en `HTTP_ENDPOINT_RULES`.
- [ ] Contratos en `packages/contracts`: `SignInSettings`, su petición de cambio (secret solo de escritura), `RegistrationMode`, acción de auditoría `signIn.settings.update` (detalle sin el secret; sí «secret replaced»).
- [ ] UI web (Owner): formulario, «Comprobar» con el error legible, URLs de redirect, back-channel logout y post-logout calculadas desde `T3CODE_PUBLIC_URL` o el origen, interruptor «Keycloak activo» (no se enciende si «Comprobar» falla).
- [ ] Tests en la frontera del servidor con el Keycloak falso (`apps/server/src/auth/Keycloak.testkit.ts`, que reutilizan los tickets siguientes): el Owner guarda y comprueba; un Admin recibe 403; ninguna respuesta contiene el secret; descubrimiento con issuer distinto falla.
