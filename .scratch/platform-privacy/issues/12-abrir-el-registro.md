# 12: Abrir el registro en producción

**What to build:** Pasar el Registration mode de la Installation de producción a «open». Es una lista de comprobación que hace el Owner a mano cuando todas las protecciones están puestas, no código nuevo. Si algún punto falla, el registro sigue cerrado o solo con invitación.

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, `../../keycloak-sign-in/issues/11`, `../../plans-and-limits/issues/12`, `../../grants/issues/13` (inventarios de puertas)

**Status:** ready-for-human

Spec: ../spec.md

- [ ] Los tickets de los que depende están `done` y sus tablas de puertas están en sus `## Comments`. Si `../owned-resources/` tiene un inventario de puertas, también.
- [ ] Términos de uso y política de privacidad publicados (06) y revisados por el Owner, con las frases sobre qué ve el operador y los límites de la garantía.
- [ ] Plan por defecto (`../plans-and-limits/`) con límites prudentes para un desconocido: Organizations, miembros, máquinas, disco y Sandbox en el Hub. Sin préstamos de la plataforma que no quiera dar a cualquiera.
- [ ] Keycloak: verificación de correo, captcha y protección contra fuerza bruta activados en el realm (`../keycloak-sign-in/`). El mapeo de grupos no apunta a Organizations ajenas.
- [ ] Copia de la clave maestra hecha y guardada fuera del servidor (`masterKey.backup`).
- [ ] Cuotas del Hub (disco y tráfico) comprobadas con el disco real de la máquina.
- [ ] Logs de la AI gateway sin cuerpos de petición (05).
- [ ] Prueba en producción con una cuenta nueva desde fuera: registrarse, aceptar los términos, ver el aviso del Personal space, crear un Thread. Desde la sesión del Owner, ese Personal space aparece en la lista de Plataforma sin contenido y no en el selector.
- [ ] Prueba de abuso: suspender y reactivar una Organization de prueba; deshabilitar y rehabilitar el User de prueba; borrar su cuenta y cancelar.
- [ ] Cambiar el Registration mode a «open» en el modal de Plataforma y anotar la fecha bajo `## Comments`.
- [ ] Se sabe cómo volver atrás: pasar a «invitation only» o «closed» en Plataforma, sin despliegue.
