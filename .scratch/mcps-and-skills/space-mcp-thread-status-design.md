# Diseño: lo que `list_space_tools` dice de un Space MCP es lo que recibió la sesión del Thread

Issue: darwinva97/bezenti-hub#20 (refs #10, #12). ADR 0004 (Isolation). Base: `main` `88480a41e59`.

## Problema

`SpaceTools.threadStatus` (la RPC `spaceTools.threadStatus` y la tool MCP `list_space_tools`) llama
a `forSession` con valores fijos (provider que acepta MCPs y secretos, contrato 17). Solo mide el
Vault. La decisión real (`ProviderSessionManager.spaceMcpsFor`, con el adapter y el contrato de la
máquina del Thread) se toma al abrir la sesión y se pierde. Un MCP que no conecta (OAuth pendiente,
handshake fallido) tampoco se ve.

## Qué cambia

1. **La decisión de la sesión se guarda.** Tras abrir un proceso nuevo, `ProviderSessionManager`
   llama a `SpaceTools.recordSession(threadId, …)` con las `decisions` de `forSession` (nombre,
   transporte, disponible, motivo, nombres que faltan; nunca la configuración) y, si el provider la
   tiene, una lectura del estado de conexión. Vive en memoria del Hub: se reemplaza en cada apertura
   y se pierde al reiniciar, como las sesiones mismas.
2. **`threadStatus` lee esa decisión.** Por cada MCP activo del Space:
   - Si el Vault ya lo deja fuera, sale con ese motivo (`not-delivered`, como hoy).
   - Si la última sesión lo decidió, sale su decisión (`outdated-machine`, `not-supported`,
     `no-secrets`, `not-delivered` o disponible).
   - Si no hay sesión, o el MCP se añadió o cambió después de abrirla: `available: false`,
     motivo nuevo `not-in-session`. Ya no afirma `available` sin sesión.
3. **Estado de conexión (Claude).** `ProviderAdapterV2SessionRuntime` gana un campo opcional
   `spaceMcpConnections`; Claude lo lee de `mcpServerStatus` del SDK y devuelve solo nombre y estado
   (`connected`, `pending`, `needs-auth`, `failed`, `disabled`). Ni mensaje de error, ni URL, ni
   cabeceras: el texto del SDK puede llevar una URL con credenciales. Un MCP disponible sale con
   `connection` cuando el provider lo reporta. Los demás providers no lo reportan (sin campo).

## Quién puede

Sin puertas nuevas. `spaceTools.threadStatus` y `list_space_tools` mantienen sus reglas (Thread
visible / Thread propio). `recordSession` no es una puerta: solo lo llama el Hub al abrir una sesión.

## Isolation

El resultado solo lleva nombres de MCP del Space del Thread, nombres del Vault que ya mostraba y un
estado enumerado. Ningún valor, cabecera ni URL.

## Cómo se deshace

Revertir el commit. No hay migración ni datos persistidos: el registro es de memoria.
