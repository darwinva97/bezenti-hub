# 24: Reproducir, informar, etiquetar y probar

**What to build:** Como `robobun`: el agente reproduce antes de cambiar código e informa en el issue con una forma fija («Reproduced on main `0966e99d8f3` (linux x64): `bun out.js` throws `ReferenceError: node_path is not defined`.» o «Could not reproduce …» con lo que probó), y luego la línea del estado del arreglo con el número del PR («Fix in progress: #49561», «Fix: #49575»). Etiqueta el issue o su PR con las etiquetas que la configuración le deja, y su PR lleva una sección de evidencia: el test nuevo falla antes del cambio y pasa después («17 of 20 new tests fail on main.»).

**Blocked by:** 12, 23.

**Status:** needs-triage

**Tipo:** AFK

**Tanda:** 5 (como `robobun`)

**Seguridad:** sensible (una escritura nueva en GitHub y un campo nuevo de la configuración). Nota de diseño `24-design.md` antes de construir.

Spec: ../spec.md

- [ ] Instrucciones en el primer mensaje: reproducir primero; el informe con la forma fija (commit, plataforma del Sandbox, resultado observado; o «Could not reproduce» con lo intentado); la línea del estado del arreglo cuando hay PR.
- [ ] Comprobación barata en el Hub, sin analizar texto libre: `makita_comment { report }` comprueba solo el comienzo del informe y que nombre un commit, y la tarea guarda si reprodujo.
- [ ] La configuración gana una lista opcional de etiquetas que Makita puede poner o quitar (hasta 30 nombres; vacía: nunca etiqueta; nunca la etiqueta que dispara). El formulario la edita y ofrece las etiquetas que ya existen en los repositorios.
- [ ] `makita_label { add?, remove?, on? }`: solo en el issue o el PR de su tarea, solo de la lista, nunca la etiqueta que dispara, auditado (`makita.github.labels`), con un tope pequeño por tarea. Solo aparece si la lista no está vacía.
- [ ] `makita_open_pull_request { evidence? }`: comandos y resultado antes y después del cambio, enmascarado como el resto, acotado, colocado por el Hub entre marcadores ocultos estables.
- [ ] La actividad muestra si la tarea reprodujo el problema y qué etiquetas puso.
- [ ] Migración: columna `labels_json` en `makita_configs`; `reproduced` y `labels_json` en `makita_tasks`.
- [ ] Red-first: una etiqueta fuera de la lista o la de disparo se rechaza y no llega a GitHub; el tope por tarea corta; una evidencia con forma de token se rechaza; los marcadores del cuerpo no se pueden falsificar.
