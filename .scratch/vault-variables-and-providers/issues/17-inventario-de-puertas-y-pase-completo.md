# 17: Inventario de puertas, documentación y pase completo

**What to build:** Repaso final, como el ticket 09 del spec 5: cada puerta nueva o cambiada (WS, HttpApi, raw routes, MCP, executor, CLI, logs y OTLP) en `DoorRules.ts` y `MaskedPaths.ts`, la documentación al día y una prueba real de extremo a extremo.

**Blocked by:** 01–16

**Status:** needs-triage

- [ ] `DoorRules.test.ts`: solo `vaults/http.ts` revela, y nunca sellados; ninguna respuesta lleva valores de Secrets; las raw routes de identidad son las únicas públicas nuevas.
- [ ] `docs/internals/secrets.md`, `docs/internals/glossary.md` (si cambia algo base), `docs/user` (proveedores, identidad, aprobaciones, recetas), `GLOSSARY.md` revisado.
- [ ] Prueba real: un Thread de Acme en el Sandbox recibe una Variable, un sellado, una Provider entry de OpenBao, un Dynamic secret de Kubernetes como kubeconfig (plantilla + archivo) con aprobación; un Thread de Globex no recibe nada de eso; el historial de ambos está enmascarado.
