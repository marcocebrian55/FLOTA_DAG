# Portal de agencias (B2B)

Alternativa propia al microsite de reservas para agencias, sobre el servidor local
(`py server.py` → http://localhost:8787/portal.html). Rama `portal-agencias`.

- Marca: `?marca=avis|budget|xtravans` · idioma: `?lang=es|en` (también en la cabecera).
- La **agencia** es un broker de `brokers.ini` (su cliente en Rentway). Rentway aplica sus
  tarifas, comisiones y condiciones. En la fase 1 vendrá del inicio de sesión.
- Las reservas se crean en el **Rentway real**.

## Acceso (fase 1)

- Cada usuario entra con email y contraseña. Usuarios, agencias y sesiones en `portal_datos.json`
  (no se sube a git; otra ruta con `PORTAL_DATOS`). Lógica en `portal_auth.py`.
- Primer administrador: `py server.py --usuario correo@empresa.com --rol admin [--agencia id]`
  → imprime una contraseña temporal que hay que cambiar al entrar.
- Roles: **admin** (interno: agencias, usuarios, actúa como cualquier agencia) · **responsable**
  (su agencia y sucursales; da de alta agentes; ve facturas si su agencia es la titular del cliente
  Rentway) · **agente** (solo su agencia).
- Jerarquía sede → sucursales. Una sucursal sin cliente Rentway usa el de su sede.
- La agencia y su cliente de Rentway los decide el servidor a partir de la sesión: el navegador no
  puede elegir otro broker.
- Visibilidad: cada agencia ve las reservas que crearon ella o sus sucursales (registro local); la
  agencia titular del cliente Rentway ve además las que Rentway liste de ese cliente.
- Formas de pago por agencia; crédito con límite por agencia (se hereda hacia las sucursales). El
  consumo se calcula con las reservas a crédito vivas del registro — PROVISIONAL hasta decidir la
  fuente buena (Navision).
- Seguridad: contraseñas PBKDF2, cookie HttpOnly + SameSite=Strict, bloqueo 15 min tras 5 fallos,
  sesiones de 12 h, desactivar un usuario o cambiarle la contraseña cierra sus sesiones.
- `PORTAL_PUBLICO=1` (para cuando se publique): todo exige sesión, cookie Secure (HTTPS) y el panel
  interno deja de servirse. El panel local sin sesión sigue funcionando como antes.

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

- **ListReservations**: con `directo` devuelve también las futuras confirmadas (29/10: el 28/10 parecía
  que no porque `RA_Number = 0` —sin contrato— se leía como contrato; corregido). Con `tres60`
  responde "USER NOT AUTHORIZED TO LIST RESERVATIONS". El listado se completa con las reservas
  creadas desde aquí (`reservas.log`) y su estado actual (mensaje V).
- **ListPendingInvoices**: "The key 'RWGDPR_Rentway_Key' is not open" → problema del servidor de
  Jimpisoft; hay que pedírselo a ellos.

- **Códigos promocionales** (29/10): el portal envía el código en la búsqueda (getMultiplePrices) y
  en la reserva (promotionCode). Rentway valida el código (si no existe: "THE PROMOTION CODE INFORMED
  IS NOT VALID!") pero el descuento lo decide su configuración: `Avis10` (clientes 1, 49 y 533) se
  acepta con el cliente 1 y devuelve `percentualDiscount` 0 en todas las tarifas, grupos, fechas y
  oficinas probados. Si un código válido no rebaja nada, el portal lo avisa encima de los resultados.

- **Cuentas XML** (29/10): `brokers.ini` tiene los 168 clientes de Rentway del webservice (bloque
  `<nombre>-<clientid>`, company 200037). Prueba de precios: 78 con tarifa, 88 entran pero sin tarifa
  en ninguna oficina/fecha probada ("NO RATE IS AVAILABLE"), 2 "CUSTOMER NOT AUTHORIZED". Esas 90
  llevan `reservable = no`: se conservan pero no se pueden elegir (ni buscar precios ni crear reservas).
- **Buscador de agencia** (cabecera): busca por nombre o id entre las agencias del portal y, para el
  admin, entre los intermediarios (clientes Rentway, `rw:<broker>`). Con un intermediario el admin
  reserva directamente con ese cliente: sin agencia del portal, solo pago en destino, ve todas sus
  reservas. Los no reservables salen en gris.

## Configuración

`js/portal-config.js`: marcas, oficinas, países, política de cancelación (PENDIENTE),
enlaces legales (PENDIENTE), antelación mínima para cambios. Textos en `js/portal-i18n.js`.

## Reglas que aplica

- Un conductor extranjero nunca va con DNI (servidor y navegador).
- Extras que Rentway cobra por reglas (OW one-way, YOU conductor joven) no se envían: se
  aplican solos. Los paquetes (TUR MC/MSC) se eligen como tarifa en la búsqueda.
- Doble clic en confirmar no duplica la reserva.
