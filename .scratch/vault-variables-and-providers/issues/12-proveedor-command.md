# 12: Proveedor `command`

**What to build:** Un driver que ejecuta solo los comandos que el operador permite en `T3CODE_SECRET_COMMANDS` (nombre → ruta absoluta y plantilla de argumentos con huecos). La referencia rellena los huecos; sin shell, con entorno controlado por el operador, timeout y tope de salida. Sirve para `sops`, `pass`, `age`, `gopass`, `vault` CLI y herramientas internas. Ver spec, «Proveedores».

**Blocked by:** 03

**Status:** needs-triage

- [ ] Red-first: un nombre fuera de la lista, una ruta relativa, un hueco con `-` inicial o con salto de línea y una salida mayor de 64 KiB se rechazan; la UI no puede escribir comandos.
- [ ] Red-first: el valor no aparece en logs ni en errores; el stderr se resume sin contenido.
- [ ] Settings muestra los comandos permitidos y de dónde salen (solo lectura).
- [ ] Docs: ejemplos con `sops -d --extract` y `pass show`.
