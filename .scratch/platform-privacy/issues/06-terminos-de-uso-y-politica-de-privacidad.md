# 06: Términos de uso y política de privacidad del Owner

**What to build:** El Owner escribe sus términos de uso y su política de privacidad en el modal de Plataforma, cada uno como texto Markdown o como URL. La primera vez parte de un texto inicial que ya dice qué ve el operador y qué no, y que es una garantía de la aplicación, no criptográfica. Al publicar elige entre «Publicar y pedir aceptación», que sube la versión, y «Corregir sin pedir aceptación». Los dos documentos se leen sin sesión en `/legal/terms` y `/legal/privacy` del Hub y se enlazan desde la página de inicio de sesión y desde el modal de Usuario.

**Blocked by:** `../settings-modals/` (modal de Plataforma)

**Status:** ready-for-agent

Spec: ../spec.md («Términos de uso y política de privacidad»)

- [ ] Tabla `legal_documents` (migración) y servicio `LegalDocuments` (publicar, corregir, leer), con una versión compartida por los dos documentos.
- [ ] Endpoint HTTP público con los dos documentos y la versión. Un documento `url` redirige. El Markdown se pinta con el renderizador existente, sin HTML crudo.
- [ ] RPC de operador en `INSTALLATION_RPC_METHODS` para publicar y corregir. Test de frontera: corregir no cambia la versión y publicar la sube; un Admin recibe la negativa.
- [ ] El texto inicial (en inglés, editable) incluye: qué ve el operador (cuenta, consumo, metadatos), qué no ve (Threads, archivos, terminales, previews, valores de Vault), que la garantía es de la aplicación y no criptográfica (el operador administra el servidor, la clave maestra y Keycloak) y que el dueño de una máquina prestada ve lo que corre en ella.
- [ ] Hay `AuditAction` `legal.publish` (`version`, `kind`).
- [ ] Web: sección «Terms and privacy» del modal de Plataforma, con enlaces en la página de inicio de sesión y en el modal de Usuario. Móvil: la sección en Plataforma y enlaces que abren el navegador del sistema.
- [ ] `docs/user/install.md`: un párrafo sobre dónde se publican y qué pide aceptación.

Sin documentos publicados no hay nada que aceptar; abrir el registro (12) exige tenerlos.
