# 05: Secret files y Template entries

**What to build:** La entrega `file`: el executor escribe el valor en una carpeta en memoria y la variable lleva la ruta (executor contract 13 → 14, con `files` y `secrets.refreshFiles`). Las Template entries (`{{ NOMBRE | filtro }}`, mismo Vault, sin anidar) y la entrega `none` para las entradas de plantilla. Enmascarado de valores multilínea. Ver spec, «Secret files» y «Template entries».

**Blocked by:** 02

**Status:** needs-triage

- [ ] Migración: `delivery`, `template_text`; CHECK de combinaciones.
- [ ] `ENVIRONMENT_EXECUTOR_CONTRACT_VERSION` 13 → 14; `secretEnv.files` en `provider.openSession`, `provider.startTurn`, `terminal.open`, `terminal.stream` y `launch.runSetupScript`; operación `secrets.refreshFiles`.
- [ ] Executor: carpeta por raíz de Thread y User, en tmpfs, 0700/0600, sin seguir enlaces (comprobaciones de `SecretFilesDirectory`); `rename` atómico; se borra con el último proceso y se barre al arrancar.
- [ ] Red-first: una máquina con contrato 13 y entradas `file` → error tipado «needs an update»; sin archivos, sigue igual.
- [ ] Red-first: una plantilla que nombra otro Vault u otra plantilla se rechaza; si una de sus entradas falla, falla la plantilla; su clase es Secret sellado si alguna entrada es Secret.
- [ ] Filtros `base64`, `base64decode`, `urlencode`, `json`, `trim`, `path`; `{{"{{"}}` como escape.
- [ ] `vaults.entries.preview` con `[NOMBRE]`, sin valores.
- [ ] Enmascarado: el valor entero y las líneas de ≥ 20 caracteres sin espacios (pregunta 6); un kubeconfig en una terminal sale enmascarado.
- [ ] Testkit «Hub con Environments»: archivo 0600 en tmpfs, la variable con la ruta, refresco sin cambiar la ruta, nada en `/proc/<pid>/cmdline`. Prueba real con Podman: `kubectl --kubeconfig "$KUBECONFIG"` lee el archivo.
- [ ] Web y móvil: «Delivery» (Environment variable, File, Not delivered) y editor de plantilla con previsualización.
