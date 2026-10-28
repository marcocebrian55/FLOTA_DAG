# Portal de agencias (B2B)

Alternativa propia al microsite de reservas para agencias, sobre el servidor local
(`py server.py` → http://localhost:8787/portal.html). Rama `portal-agencias`.

- Marca: `?marca=avis|budget|xtravans` · idioma: `?lang=es|en` (también en la cabecera).
- La **agencia** es un broker de `brokers.ini` (su cliente en Rentway). Rentway aplica sus
  tarifas, comisiones y condiciones. En la fase 1 vendrá del inicio de sesión.
- Las reservas se crean en el **Rentway real**.

## Qué hace

| Pantalla | Servicio de Rentway | Estado |
| --- | --- | --- |
| Búsqueda por oficina, fechas, one-way, edad, promoción | getMultiplePrices | Funciona |
| Ficha del vehículo (foto, plazas, maletas, cambio) | getGroupDetails (caché 6 h) | Funciona |
| Filtros por categoría | Código SIPP + ficha | Funciona (heurística) |
| Extras y coberturas con precio, cantidades e incompatibilidades | getExtras | Funciona |
| Conductor (documento, dirección, país), adicional, vuelo, localizador | Create_Reservation N | Funciona |
| Pago en destino / a crédito | — | Funciona (no cambia nada en Rentway) |
| Prepago con tarjeta | inAnalysis + pasarela | Construido, apagado (`PASARELA_ACTIVA`) |
| Bono PDF con logo de la agencia | Imprimir → Guardar como PDF | Funciona (logo en el navegador) |
| Mis reservas + exportar CSV | ListReservations + reservas.log | Funciona con límites (abajo) |
| Modificar (fechas, oficinas, vuelo) | Create_Reservation P | Construido; probado sin enviar |
| Cancelar con gastos estimados | Create_Reservation C | Funciona; política PENDIENTE |
| Facturas + exportar CSV | ListPendingInvoices | Construido; Rentway da error (abajo) |
| FAQ | — | Borrador a revisar |

## Límites conocidos de Rentway (28/10/2026)

- **ListReservations**: con `directo` solo devuelve reservas con contrato o canceladas (no las
  futuras confirmadas); con `tres60` responde "USER NOT AUTHORIZED TO LIST RESERVATIONS".
  Por eso el listado se completa con las reservas creadas desde aquí (`reservas.log`) y su
  estado actual (mensaje V).
- **ListPendingInvoices**: "The key 'RWGDPR_Rentway_Key' is not open" → problema del servidor de
  Jimpisoft; hay que pedírselo a ellos.

## Configuración

`js/portal-config.js`: marcas, oficinas, países, política de cancelación (PENDIENTE),
enlaces legales (PENDIENTE), antelación mínima para cambios. Textos en `js/portal-i18n.js`.

## Reglas que aplica

- Un conductor extranjero nunca va con DNI (servidor y navegador).
- Extras que Rentway cobra por reglas (OW one-way, YOU conductor joven) no se envían: se
  aplican solos. Los paquetes (TUR MC/MSC) se eligen como tarifa en la búsqueda.
- Doble clic en confirmar no duplica la reserva.
