# 02: Valores multilínea y enmascarado por líneas

**What to build:** Un Secret puede tener varias líneas (una clave PEM, un JSON de cuenta de servicio) y se escribe en un área de texto. El enmascarado `[NAME]` tapa el Secret entero, como hoy, y además cada línea suya de al menos 16 caracteres (sin contar espacios de los extremos), salvo las líneas de armadura PEM, para que un `head -5 key.pem` o un valor con sangría tampoco quede en el historial. Ver spec, «Valores multilínea y enmascarado parcial».

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Red-first en `packages/shared/src/secretMasking.test.ts`: con una clave PEM de prueba como valor, las tres primeras líneas impresas solas, las líneas con sangría de 4 espacios y las líneas en CRLF salen como `[NAME]`; las líneas `-----BEGIN …-----`/`-----END …-----` y las de menos de 16 caracteres no. Falla en `main`.
- [ ] `secretForms` añade las formas por línea solo para valores con más de una línea; `pendingSuffix` cubre una línea cortada entre dos trozos de un stream (caso en `SecretMasker.test.ts` con salida de terminal troceada).
- [ ] El valor se guarda con sus saltos de línea tal cual (LF o CRLF) y llega igual en `secretEnv`: caso en `HubWithEnvironments.secretEnv.test.ts` que compara el entorno real del proceso.
- [ ] Web y desktop: el valor se escribe en un área de texto que no muestra lo escrito después de guardar; pegar un PEM conserva las líneas. Móvil: `TextInput multiline` en `apps/mobile/src/features/vaults/`.
- [ ] `request_secret` acepta respuestas multilínea en su tarjeta (web y móvil) y las enmascara igual.
- [ ] Docs: `docs/internals/secrets.md` («Masking») dice qué tapa por líneas y qué no (líneas cortas, armadura PEM), en un párrafo.
- [ ] Prueba real: un Thread con un Secret PEM ejecuta `head -3` y `cat` del archivo; el historial muestra `[NAME]` en las dos.
