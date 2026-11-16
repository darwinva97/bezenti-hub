# 08: Medir el tráfico del Hub por Space

**What to build:** El Hub cuenta los bytes que pasan por la AI gateway y por los previews que sirve, atribuidos al Space, por mes natural UTC. Sin escribir en la base por petición. El User, el Admin y el Owner ven el tráfico del mes, todavía sin cuota. Ver spec, «Tráfico del Hub».

**Blocked by:** 02.

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Migración: `hub_traffic_monthly` (`month`, `space_id`, `kind` `gateway` | `preview`, `bytes`).
- [ ] Contador en memoria con escritura por lotes y al parar (como el writer de `apps/server/src/ai/AiUsage.ts`).
- [ ] Gateway: bytes de petición y de respuesta (también en streaming) en `AiGatewayProxy.ts`, con el Space que ya lleva la petición. Previews: cuerpos HTTP y frames de WebSocket en `apps/server/src/preview/hubPreviewRoute.ts` y en el origen propio de previews, atribuidos por el Thread del preview.
- [ ] Red-first: una respuesta de gateway en streaming y un preview con WebSocket suman sus bytes al Space correcto; un preview de otro Space no se mezcla; cambiar de mes empieza de cero.
- [ ] Rendimiento: ninguna escritura en la base ni lock por petición; anotar en el ticket el coste por petición medido.
- [ ] `PlanUsage` añade el tráfico del mes por Space y tipo.
- [ ] Web/desktop: modal Usuario → «Plan» y modal Space → «Usage» con «Hub traffic this month 3.1 GB (gateway 0.4, previews 2.7), resets on 1 Dec». Owner: en Plataforma → Users.
