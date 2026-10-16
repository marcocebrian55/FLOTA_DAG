# Panel local: reservas en Rentway por broker

El panel publicado (GitHub Pages) solo consulta precios. Abierto en local, además
crea, consulta y cancela reservas en Rentway con las credenciales de cada broker.

## Arrancar

    py server.py            → http://localhost:8787

(o el acceso directo "Panel de reservas.bat" del Escritorio). En local no hay
login: el servidor solo escucha en 127.0.0.1.

## Credenciales

`brokers.ini` (no se sube a git; plantilla en `brokers.ejemplo.ini`). Un bloque por
broker con `company`, `customer`, `user`, `password`, `rate` (opcional, admite
`{station}`) y `entorno` (`produccion` | `prueba`). Se relee en cada petición.

## Tarificador en local

- **Brokers**: precio en vivo por oficina + modelo (grupo) + tarifa. Si la tarifa se
  deja vacía, Rentway devuelve todas las del broker y se muestra la más barata sin
  paquete; tras consultar, el campo sugiere las tarifas disponibles. Por defecto se
  elige el broker `directo` (nunca `prueba`, cuya empresa ya no existe).
- **Directa** (tarifas internas): lee `rates.json` del bucket privado de Supabase, que
  exige sesión. En local se entra sin login, así que al obtener precios en Directa se
  pide iniciar sesión una vez (queda guardada); "Volver al panel" sigue sin ella.
- Las consultas de precio reintentan una vez si falla la red; crear/cancelar reservas
  nunca se reenvía.

## Flujo (botón "Reservas")

1. Disponibilidad: `getMultiplePrices` sin grupo ni tarifa por oficina/fechas/horas
   (+ fecha de nacimiento y `promotionCode` opcionales) → todos los grupos, tarifas
   y paquetes del broker.
2. Elegir opción → datos del conductor (solo nombre y apellidos obligatorios;
   se envían como `Apellidos,Nombre`) y referencia/voucher del broker.
3. Revisión → `Create_Internacional_Reservation` MessageType `N` con `Group`,
   `RateCode`, `package`, `promotionCode` y `Refrence`.
4. Resultado → consultar (`V`) o cancelar (`C`). Pestaña "Buscar reserva" para
   cualquier número.

Cada operación queda en `reservas.log` (JSON por línea, sin credenciales; no se sube a git).

## Notas de la API (Jimpisoft / Emotion Mobility)

- Servicio: `https://ws-soap-api.jimpisoft.com/Create_Reservation.asmx`, SOAP 1.1,
  namespace `http://www.jimpisoft.pt/Rentway_Internacional_Reservations_WS/`.
- No existe campo "voucher" al crear: el número del broker va en `<Refrence>`
  (sic, máx. 30). Rentway rechaza referencias repetidas (`RESERVATION ALREADY EXIST!`).
- Sin `package` Rentway aplica la tarifa sin paquete aunque se haya cotizado con él.
- La respuesta de `getMultiplePrices` usa camelCase (`groupID`, `group_Name`).
- El servidor de pruebas (`jsserver10…/Rentway_WS_Test`) responde, pero la empresa
  9999 de la documentación ya no existe.
