# Vaults

Type: grilling
Label: wayfinder:grilling
Status: resolved
Blocked by: 02, 08
Map: ../map.md

## Question

¿Qué es un vault, qué contiene, cómo se asigna a una Organización, usuario o Project, cómo se crea uno nuevo o se exporta e importa desde el vault principal del Owner, y cómo lo consumen los agentes sin exponer los valores?

Incluye: ningún aislamiento protege los secretos de un Space frente a su propio agente (ADR 0004). ¿Cómo se inyectan para minimizar la exposición? (Surgió en «Aislamiento entre Organizaciones».)

## Answer

Resuelto por grilling con el Owner (2026-11-04). Términos nuevos en `GLOSSARY.md`: Vault, Main vault, Secret link.

1. Un Vault es un conjunto con nombre de secretos (tokens, API keys…), cada uno bajo un nombre de variable de entorno. El Owner tiene un Main vault.
2. Los valores viven en un almacén propio del Hub, cifrado, con la clave maestra en un archivo aparte de la base de datos. Sin backends externos. _(Reabierto: ADR 0008, `../../vault-variables-and-providers/spec.md`.)_
3. Solo el Owner crea Vaults y los permite a Spaces y/o Users.
4. El Vault de una Organization combina Secret links al Main vault (rotar el original los actualiza), copias independientes y secretos propios.
5. Editan: el Main vault, solo el Owner; los Vaults de una Organization, el Owner y sus Admins.
6. Revelar valores: solo el Owner. Admins: solo escritura. Members y Guests: solo nombres.
7. Vaults por defecto por Space, aplicados a sus Projects y Threads; cada Project añade o quita entre los permitidos. El Main vault solo es defecto del Personal space del Owner.
8. Los secretos llegan como variables de entorno al agente, terminales y dev servers del Project; el agente puede listar los nombres disponibles sin ver valores.
9. Los valores se sustituyen por `[NOMBRE]` en el historial guardado y mostrado. El proveedor de IA sí los ve si el agente los lee.
10. Si un agente pide un secreto que falta, el Owner o un Admin pueden guardar la respuesta en un Vault.
