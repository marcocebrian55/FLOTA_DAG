"""
Servidor local FLOTA_DAG
------------------------
Sirve el panel y hace de proxy hacia Jimpisoft (Rentway) con las
credenciales de cada broker, que se leen de brokers.ini (NO se sube a git).

Uso:  py server.py          → http://localhost:8787

Endpoints:
  GET  /api/brokers   lista de brokers configurados (sin credenciales)
  POST /api/precios   {provider, groupID, pickupDate, dropoffDate, station, rateCode?}
                      → XML de Jimpisoft tal cual
  POST /api/disponibilidad {provider, recogida, devolucion ("AAAA-MM-DD HH:MM"),
                      oficina_recogida, oficina_devolucion, nacimiento?}
                      → JSON con todos los grupos/tarifas/paquetes del broker
  POST /api/reserva   {provider, accion: N|V|C, ...} → JSON con el resultado
                      N crear · V consultar estado · C cancelar
                      Cada llamada queda registrada en reservas.log (sin credenciales)

Servicio de reservas: Create_Reservation.asmx → Create_Internacional_Reservation
(documentación: RW_WEBSERVICE §3 "Reservation Process" + WSDL de producción).
"""

import configparser
import json
import os
import re
import sys
import secrets
import time
import urllib.error
import urllib.request
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs
from xml.sax.saxutils import escape

import portal_auth as pa

ROOT = Path(__file__).resolve().parent
BROKERS_FILE = ROOT / "brokers.ini"
LOG_FILE = ROOT / "reservas.log"
PORT = 8787

# entorno de cada broker → URL base de los servicios
ENTORNOS = {
    "produccion": "https://ws-soap-api.jimpisoft.com/",
    "prueba": "http://jsserver10.jimpisoft.pt/Rentway_WS_Test/",
}
PRICES_ACTION = "http://www.jimpisoft.pt/Rentway_Reservations_WS/getMultiplePrices/MultiplePrices"
RES_NS = "http://www.jimpisoft.pt/Rentway_Internacional_Reservations_WS/"
RES_ACTION = RES_NS + "Create_Internacional_Reservation/Create_Internacional_Reservation"

# Ficheros que nunca se sirven por HTTP aunque estén en la carpeta
BLOCKED = {"brokers.ini", "server.py", "reservas.log", "portal_datos.json", "portal_datos.tmp", "portal_auth.py"}

# PORTAL_PUBLICO=1 al publicar el portal: todo exige sesión, cookie Secure (HTTPS) y el panel interno no se sirve
MODO_PUBLICO = os.environ.get("PORTAL_PUBLICO") == "1"
COOKIE = "portal_sesion"

is_date = lambda s: bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", s or ""))
is_datetime = lambda s: bool(re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", s or ""))
is_code = lambda s: bool(re.fullmatch(r"[A-Za-z0-9]{1,10}", s or ""))
# Oficina de Rentway: hasta 10 caracteres, con espacios internos ("FUE BUD", "TFN TUR")
is_station = lambda s: bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 ]{0,9}", s or "")) and s == s.rstrip()
is_promo = lambda s: bool(re.fullmatch(r"[A-Za-z0-9_\-]{1,50}", s or ""))
is_ref = lambda s: bool(re.fullmatch(r"[A-Za-z0-9_\-/.]{1,30}", s or ""))


def load_brokers():
    """Se relee en cada petición: así basta con guardar brokers.ini, sin reiniciar."""
    # interpolation=None: una contraseña con "%" no rompe la lectura.
    # strict=False: un bloque repetido no tumba el servidor (gana el último).
    cfg = configparser.ConfigParser(interpolation=None, strict=False)
    cfg.read(BROKERS_FILE, encoding="utf-8")
    brokers = {}
    for sec in cfg.sections():
        b = cfg[sec]
        brokers[sec] = {
            "nombre": b.get("nombre", sec),
            "company": b.get("company", "").strip(),
            "customer": b.get("customer", "").strip(),
            "user": b.get("user", "").strip(),
            "password": b.get("password", "").strip(),
            "rate": b.get("rate", "").strip(),
            "entorno": b.get("entorno", "produccion").strip().lower(),
            # reservable = no: se conserva (p. ej. cliente sin tarifa en Rentway) pero no se puede elegir
            "reservable": b.get("reservable", "si").strip().lower() not in ("no", "false", "0"),
        }
    return brokers


def configured(b):
    return all(b[k] for k in ("company", "customer", "user", "password"))


def base_url(b):
    return ENTORNOS.get(b["entorno"], ENTORNOS["produccion"])


def post_soap(url, body, headers, retries=0):
    """Devuelve (status, bytes). Lanza excepción si no hay conexión.
    retries: reintentos ante fallo de red. Solo para consultas: una reserva nunca se reenvía."""
    req = urllib.request.Request(url, data=body.encode("utf-8"), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, OSError):
        if retries <= 0:
            raise
        time.sleep(1)
        return post_soap(url, body, headers, retries - 1)


def tag(name, value):
    """<name>value</name>, o nada si el valor está vacío."""
    if value is None or str(value).strip() == "":
        return ""
    return f"<{name}>{escape(str(value).strip())}</{name}>"


# ---------------------------------------------------------------- precios

def soap_prices(b, group, pickup, dropoff, station, station_drop=None, dob=None, rate=None, promo=None):
    """pickup/dropoff: "AAAA-MM-DD" (a las 10:00) o "AAAA-MM-DD HH:MM"."""
    as_dt = lambda d: d.replace(" ", "T") + ":00" if " " in d else d + "T10:00:00"
    rate = b["rate"].replace("{station}", station) if rate is None else rate
    return f"""<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tns="http://www.jimpisoft.pt/Rentway_Reservations_WS/getMultiplePrices">
  <soap:Header/>
  <soap:Body>
    <tns:MultiplePrices>
      <tns:objRequest>
        {tag("tns:companyCode", b["company"])}
        {tag("tns:customerCode", b["customer"])}
        {tag("tns:username", b["user"])}
        {tag("tns:password", b["password"])}
        {tag("tns:groupID", group)}
        {tag("tns:rateCode", rate)}
        <tns:pickUp>
          <tns:Date>{as_dt(pickup)}</tns:Date>
          <tns:rentalStation>{station}</tns:rentalStation>
        </tns:pickUp>
        <tns:dropOff>
          <tns:Date>{as_dt(dropoff)}</tns:Date>
          <tns:rentalStation>{station_drop or station}</tns:rentalStation>
        </tns:dropOff>
        {tag("tns:Date_of_Birth", dob)}
        {tag("tns:promotionCode", promo)}
      </tns:objRequest>
    </tns:MultiplePrices>
  </soap:Body>
</soap:Envelope>"""


DISP_FIELDS = {
    "grupo": "groupID", "nombre": "group_Name", "sipp": "SIPP", "imagen": "imageURL",
    "tarifa": "rateCode", "dias": "nrDays", "total": "previewValue", "dia": "totalDayValueWithTax",
    "incluidos": "extrasIncluded", "obligatorios": "extrasRequired", "paquete": "package",
    "prepago": "prepaidRate", "moneda": "currency",
    # con promotionCode: precio con descuento y % aplicado
    "total_desc": "previewValueWithDiscount", "descuento": "percentualDiscount",
}


def parse_disponibilidad(xml):
    """Convierte el DataSet de getMultiplePrices en una lista de opciones reservables."""
    text = xml.decode("utf-8", "replace")
    err = re.search(r"<errorCode>(.*?)</errorCode>", text, re.S)
    if err and err.group(1).strip():
        return {"error": err.group(1).strip()}
    data = text.split("</xs:schema>", 1)[-1]
    opciones = []
    for row in re.findall(r"<MultiplePrices [^>]*>(.*?)</MultiplePrices>", data, re.S):
        o = {}
        for k, t in DISP_FIELDS.items():
            m = re.search(rf"<{t}>(.*?)</{t}>", row, re.S)
            o[k] = m.group(1).strip() if m else ""
        for k in ("total", "dia", "total_desc", "descuento"):
            try:
                o[k] = round(float(o[k]), 2)
            except ValueError:
                o[k] = None
        opciones.append(o)
    if not opciones:
        return {"error": "Sin disponibilidad para esa selección"}
    opciones.sort(key=lambda o: (o["total"] is None, o["total"] or 0))
    return {"opciones": opciones}


# ---------------------------------------------------------------- consultas (solo lectura)
# Mismo formato que getMultiplePrices: SOAP 1.2, <tns:objRequest> en el orden del WSDL.

WS_NS = "http://www.jimpisoft.pt/Rentway_Reservations_WS/"


def soap12(service, op, campos):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tns="{WS_NS}{service}">
  <soap:Header/>
  <soap:Body><tns:{op}><tns:objRequest>{campos}</tns:objRequest></tns:{op}></soap:Body>
</soap:Envelope>"""


def call12(b, service, op, campos):
    """Devuelve el XML de respuesta (bytes). Consultas: un reintento ante fallo de red."""
    action = f"{WS_NS}{service}/{op}"
    status, xml = post_soap(
        base_url(b) + service + ".asmx", soap12(service, op, campos),
        {"Content-Type": f'application/soap+xml; charset=utf-8; action="{action}"'}, retries=1,
    )
    if status != 200 and b"<errorCode>" not in xml:
        raise RuntimeError(f"HTTP {status}")
    return xml


def dataset(xml):
    """Filas de un DataSet .NET → {tabla: [ {campo: valor} ]}. Error de Rentway → {"error": ...}."""
    text = xml.decode("utf-8", "replace")
    err = re.search(r"<errorCode>(.*?)</errorCode>", text, re.S)
    if err and err.group(1).strip():
        return {"error": err.group(1).strip()}
    return _filas(text.split("</xs:schema>", 1)[-1])


# Una fila puede llevar dentro otros DataSet (ListReservations: Payments, Reservations_Value)
_ANIDADO = re.compile(r"<(\w+)><xs:schema.*?</diffgr:diffgram></\1>", re.S)


def _filas(data):
    tablas = {}
    for nombre, cuerpo in re.findall(r'<(\w+) diffgr:id="[^"]*"[^>]*>(.*?)</\1>', data, re.S):
        hijos = {}
        for m in _ANIDADO.finditer(cuerpo):
            sub = _filas(m.group(0).split("</xs:schema>", 1)[-1])
            hijos[m.group(1)] = next(iter(sub.values()), [])
        fila = {k: v.strip() for k, v in re.findall(r"<(\w+)>([^<]*)</\1>", _ANIDADO.sub("", cuerpo))}
        fila.update(hijos)
        tablas.setdefault(nombre, []).append(fila)
    return tablas


def plano(xml, campos):
    """Respuesta sin DataSet (getGroupDetails): campos sueltos del primer nivel."""
    text = xml.decode("utf-8", "replace")
    err = re.search(r"<errorCode>(.*?)</errorCode>", text, re.S)
    if err and err.group(1).strip():
        return {"error": err.group(1).strip()}
    out = {}
    for c in campos:
        m = re.search(rf"<{c}>([^<]*)</{c}>", text)
        out[c] = m.group(1).strip() if m else ""
    return out


def num(v):
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


def extras_disponibles(b, d):
    return parse_extras(call12(b, "getExtras", "Extras", (
        tag("tns:companyCode", b["company"]) + tag("tns:customerCode", b["customer"])
        + tag("tns:groupID", d["grupo"]) + tag("tns:rateCode", d.get("tarifa"))
        + "<tns:Reservation_Number>0</tns:Reservation_Number>"
        + "<tns:pickUp>" + tag("tns:Date", d["recogida"]) + tag("tns:rentalStation", d["oficina_recogida"]) + "</tns:pickUp>"
        + "<tns:dropOff>" + tag("tns:Date", d["devolucion"])
        + tag("tns:rentalStation", d.get("oficina_devolucion") or d["oficina_recogida"]) + "</tns:dropOff>"
        + tag("tns:promotionCode", d.get("promocion")) + tag("tns:Date_of_Birth", d.get("nacimiento"))
    )))


def parse_extras(xml):
    t = dataset(xml)
    if "error" in t:
        return t
    filas = next(iter(t.values()), [])
    si = lambda v: (v or "").lower() == "true"
    extras = []
    for f in filas:
        valor, iva = num(f.get("value")), num(f.get("taxRate")) or 0
        extras.append({
            "codigo": f.get("extraID", ""), "nombre": f.get("extra", ""), "descripcion": f.get("description", ""),
            "valor": valor, "valor_iva": round(valor * (1 + iva / 100), 2) if valor is not None else None,
            "iva": iva, "incluido": si(f.get("extraIncluded")), "aceptado": si(f.get("accepted")),
            "obligatorio": si(f.get("required")), "disponible": f.get("Available", "true").lower() != "false",
            "cantidad": si(f.get("acceptQty")), "por_dia": si(f.get("extraByDay")),
            "seguro": si(f.get("insurance")), "franquicia": num(f.get("excess")),
            "incluir_con": f.get("must_include", ""), "excluir_con": f.get("must_not_include", ""),
        })
    return {"extras": extras}


GRUPO_CAMPOS = ["groupID", "group_Name", "SIPP", "suitcases", "handbag", "seats", "doors", "fuel",
                "automaticTransmission", "imageURL", "brand", "model", "details", "category",
                "segmentDescription", "minAge", "maxAge", "capacity", "load"]
_grupos_cache = {}  # (company, grupo) → (instante, ficha): la ficha cambia poco


def ficha_grupo(b, grupo):
    clave = (b["company"], grupo)
    hit = _grupos_cache.get(clave)
    if hit and time.time() - hit[0] < 6 * 3600:
        return hit[1]
    xml = call12(b, "getGroupDetails", "GroupDetails",
                 tag("tns:companyCode", b["company"]) + tag("tns:groupID", grupo))
    f = plano(xml, GRUPO_CAMPOS)
    if "error" not in f:
        f["opciones"] = re.findall(r"<option>([^<]*)</option>", xml.decode("utf-8", "replace"))
        _grupos_cache[clave] = (time.time(), f)
    return f


def listado_reservas(b, desde, hasta, numero=None):
    campos = (
        tag("tns:companyCode", b["company"]) + tag("tns:customerCode", b["customer"])
        + tag("tns:username", b["user"]) + tag("tns:password", b["password"])
        + tag("tns:resNumber", numero)
        + tag("tns:pickupDateFrom", None if numero else desde + " 00:00")
        + tag("tns:pickupDateTo", None if numero else hasta + " 23:59")
        + "<tns:OnlyInternationalReservation>false</tns:OnlyInternationalReservation>"
        + "<tns:AllUsers>true</tns:AllUsers>"
        + "<tns:WithoutRA>true</tns:WithoutRA><tns:WithRAOpened>true</tns:WithRAOpened>"
        + "<tns:WithRAClosed>true</tns:WithRAClosed>"
    )
    return dataset(call12(b, "ListReservations", "Reservations", campos))


def listado_facturas(b, desde, hasta, solo_pendientes):
    campos = (
        tag("tns:companyCode", b["company"]) + tag("tns:customerCode", b["customer"])
        + tag("tns:username", b["user"]) + tag("tns:password", b["password"])
        + tag("tns:dateFrom", desde + " 00:00") + tag("tns:dateTo", hasta + " 23:59")
        + f"<tns:onlyPendingInvoices>{'true' if solo_pendientes else 'false'}</tns:onlyPendingInvoices>"
        + "<tns:maxInvoicesShow>1000</tns:maxInvoicesShow>"
    )
    return dataset(call12(b, "ListPendingInvoices", "PendingInvoices", campos))


ESTADOS_LISTADO = {"0": "Pendiente de confirmar", "1": "Confirmada", "2": "Cancelada",
                   "3": "No confirmada", "4": "Pendiente del cliente", "5": "En análisis"}


def api_extras(b, d):
    if not (is_code(d.get("grupo")) and is_datetime(d.get("recogida")) and is_datetime(d.get("devolucion"))
            and is_station(d.get("oficina_recogida"))):
        raise ValueError("Parámetros no válidos")
    return extras_disponibles(b, d)


def api_grupo(b, d):
    if not is_code(d.get("grupo")):
        raise ValueError("Grupo no válido")
    return ficha_grupo(b, d["grupo"].upper())


def rango(d):
    desde, hasta = d.get("desde"), d.get("hasta")
    if not (is_date(desde) and is_date(hasta)) or hasta < desde:
        raise ValueError("Fechas no válidas (AAAA-MM-DD)")
    return desde, hasta


def api_listado(b, d):
    """Reservas del cliente Rentway del broker, por fecha de recogida (o una por número).
    Solo se devuelve lo que la agencia necesita ver: nada de documentos ni carnés."""
    numero = d.get("numero")
    if numero and not str(numero).isdigit():
        raise ValueError("Número de reserva no válido")
    desde, hasta = (None, None) if numero else rango(d)
    t = listado_reservas(b, desde, hasta, numero)
    aviso = None
    if "error" in t:
        # Sin resultados no es un error; sin permiso de listado, se sigue con las del registro local
        if "NO RESERVATIONS FOUND" in t["error"].upper():
            t = {}
        elif "NOT AUTHORIZED" in t["error"].upper():
            aviso, t = "sin_permiso_listado", {}
        else:
            return t
    out = []
    for f in next(iter(t.values()), []):
        estado = f.get("StatusCode", "")
        contrato = f.get("RA_Number", "").strip()
        if contrato == "0":  # Rentway devuelve 0 cuando aún no hay contrato
            contrato = ""
        if estado == "1" and contrato:
            estado_txt = "Finalizada" if f.get("RA_Closed", "").lower() == "true" else "Con contrato"
        else:
            estado_txt = ESTADOS_LISTADO.get(estado, f.get("StatusDescription", ""))
        out.append({
            "numero": f.get("Reservation", ""), "referencia": f.get("Reference", ""),
            "estado": estado, "estado_texto": estado_txt,
            "oficina_recogida": f.get("PickupStationID", ""), "recogida": f.get("PickupDate", "")[:16],
            "vuelo": f.get("PickupFlight", ""),
            "oficina_devolucion": f.get("DropOffStationID", ""), "devolucion": f.get("DropOffDate", "")[:16],
            "grupo": f.get("GroupID", ""), "tarifa": f.get("RateCode", ""), "dias": f.get("NrDays", ""),
            "creada": f.get("CreationDate", "")[:16], "conductor": f.get("DriverName", ""),
            "promocion": f.get("promotionCode", ""), "importe": num(f.get("ReservationPreviewValue")),
            "contrato": contrato, "prepago": f.get("PrePaid", "").lower() == "true",
            "lineas": [{"codigo": l.get("Code", ""), "descripcion": l.get("Description", ""),
                        "tipo": l.get("Type", ""), "unidad": num(l.get("Unit_Value")),
                        "cantidad": l.get("Quantity", ""), "iva": num(l.get("Vat_Rate"))}
                       for l in f.get("Reservations_Value", [])],
        })
    # Rentway no siempre lista las reservas futuras ni las recién creadas: se completan
    # con las creadas desde el panel/portal (reservas.log), con su estado actual vía V.
    ya = {r["numero"] for r in out}
    for r in del_registro(d.get("provider", ""), desde, hasta, numero):
        if r["numero"] in ya:
            continue
        try:
            v = parse_reserva(post_soap(
                base_url(b) + "Create_Reservation.asmx", soap_reserva(b, "V", {"numero": r["numero"]}),
                {"Content-Type": "text/xml; charset=utf-8", "SOAPAction": f'"{RES_ACTION}"'}, retries=1)[1])
            if not v.get("error"):
                r["estado"] = {"C": "1", "P": "0", "D": "2", "NC": "3", "RA": "1"}.get(v["estado"], r["estado"])
                r["estado_texto"] = v["estado_texto"]
                r["importe"] = num(v.get("importe")) or r["importe"]
                if v["estado"] == "RA":
                    r["estado_texto"], r["contrato"] = "Con contrato", "?"
        except Exception:
            pass  # se muestra con lo que diga el registro
        out.append(r)
    out.sort(key=lambda r: r["recogida"], reverse=True)
    res = {"reservas": out}
    if aviso:
        res["aviso"] = aviso
    return res


def del_registro(broker_id, desde, hasta, numero=None):
    """Reservas creadas con éxito desde aquí para ese broker, con su última modificación o cancelación."""
    if not LOG_FILE.exists():
        return []
    regs = {}
    with open(LOG_FILE, encoding="utf-8") as fh:
        for linea in fh:
            try:
                e = json.loads(linea)
            except ValueError:
                continue
            res = e.get("resultado") or {}
            if e.get("broker") != broker_id or res.get("error"):
                continue
            n = res.get("numero") or e.get("numero_pedido")
            if e.get("accion") == "N" and n:
                regs[n] = {
                    "numero": n, "referencia": res.get("referencia", ""), "estado": "1",
                    "estado_texto": res.get("estado_texto", "Confirmada"),
                    "oficina_recogida": e.get("oficina", ""), "recogida": e.get("recogida", ""), "vuelo": "",
                    "oficina_devolucion": e.get("oficina_devolucion") or e.get("oficina", ""),
                    "devolucion": e.get("devolucion") or "", "grupo": e.get("grupo", ""), "tarifa": e.get("tarifa", ""),
                    "dias": "", "creada": e.get("fecha", "")[:16], "conductor": e.get("cliente", ""),
                    "promocion": e.get("promocion") or "", "importe": num(res.get("importe")), "contrato": "",
                    "prepago": False, "lineas": [], "origen": "portal", "agencia": e.get("agencia"),
                }
            elif n in regs and e.get("accion") == "C":
                regs[n].update(estado="2", estado_texto="Cancelada")
            elif n in regs and e.get("accion") == "P":
                for k in ("recogida", "devolucion"):
                    if e.get(k):
                        regs[n][k] = e[k]
    out = []
    for r in regs.values():
        if numero:
            if r["numero"] == str(numero):
                out.append(r)
        elif desde <= r["recogida"][:10] <= hasta:
            out.append(r)
    return out


def api_facturas(b, d):
    desde, hasta = rango(d)
    t = listado_facturas(b, desde, hasta, bool(d.get("pendientes")))
    if "error" in t:
        return t
    return {"facturas": [{
        "numero": f.get("InvoiceNr", ""), "fecha": f.get("InvoiceDate", "")[:10],
        "vencimiento": f.get("InvoiceDueDate", "")[:10], "base": num(f.get("ValueWithoutTax")),
        "iva": num(f.get("TaxValue")), "total": num(f.get("TotalValue")), "pagado": num(f.get("ValuePaid")),
        "contrato": f.get("RA", ""), "reserva": f.get("Reservation", ""), "referencia": f.get("Reference", ""),
        "voucher": f.get("Voucher", ""), "conductor": f.get("DriverName", ""),
    } for f in next(iter(t.values()), [])]}


# ---------------------------------------------------------------- oficinas
# getStations devuelve todas las oficinas de la empresa (~1.900: aeropuertos Avis/Budget/Turisprime,
# Xtravans, hoteles…), la misma lista para cualquier cliente. Cada cliente tiene tarifa solo en
# algunas: las "habituales" salen de sus reservas reales (ListReservations) y se muestran primero.

_oficinas_cache = {}     # company → (instante, lista)
_habituales_cache = {}   # (company, customer) → (instante, lista)
_habituales_lock = __import__("threading").Lock()


def api_oficinas(b, d):
    hit = _oficinas_cache.get(b["company"])
    if hit and time.time() - hit[0] < 24 * 3600:
        return {"oficinas": hit[1]}
    t = dataset(call12(b, "getStations", "getStations",
                       tag("tns:companyCode", b["company"]) + tag("tns:customerCode", b["customer"])))
    if "error" in t:
        return t
    ofs = sorted(({"id": f.get("StationID", "").strip(), "nombre": f.get("Station", "").strip(),
                   "ciudad": f.get("City", "").strip()} for f in next(iter(t.values()), [])
                  if f.get("StationID", "").strip()), key=lambda o: o["nombre"].lower())
    _oficinas_cache[b["company"]] = (time.time(), ofs)
    return {"oficinas": ofs}


def api_habituales(b, d):
    """Oficinas que el cliente usa de verdad (recogida y devolución), de más a menos uso."""
    clave = (b["company"], b["customer"])
    hit = _habituales_cache.get(clave)
    if hit and time.time() - hit[0] < 24 * 3600:
        return {"habituales": hit[1]}
    with _habituales_lock:  # varias pestañas a la vez: una sola consulta a Rentway por cliente
        hit = _habituales_cache.get(clave)
        if hit and time.time() - hit[0] < 24 * 3600:
            return {"habituales": hit[1]}
        hoy = time.time()
        desde = time.strftime("%Y-%m-%d", time.localtime(hoy - 120 * 86400))
        hasta = time.strftime("%Y-%m-%d", time.localtime(hoy + 240 * 86400))
        usos = {}
        try:
            t = listado_reservas(b, desde, hasta)
        except Exception:
            t = {"error": "sin respuesta"}
        if "error" not in t:
            for f in next(iter(t.values()), []):
                for k in ("PickupStationID", "DropOffStationID"):
                    st = (f.get(k) or "").strip()
                    if st:
                        usos[st] = usos.get(st, 0) + 1
        lista = [k for k, _ in sorted(usos.items(), key=lambda x: -x[1])][:20]
        # sin permiso de listado o sin reservas: no se guarda 24 h, se reintenta en 1 h
        _habituales_cache[clave] = (time.time() - (0 if lista else 23 * 3600), lista)
        return {"habituales": lista}


CONSULTAS = {"/api/extras": api_extras, "/api/grupo": api_grupo,
             "/api/listado": api_listado, "/api/facturas": api_facturas,
             "/api/oficinas": api_oficinas, "/api/habituales": api_habituales}

# Prepago con tarjeta: construido pero apagado hasta tener pasarela (Redsys o similar)
PASARELA_ACTIVA = False


# ---------------------------------------------------------------- reservas

def validar_reserva(accion, d):
    if accion not in ("N", "V", "C", "P"):
        return "Acción no válida (N, V, C o P)"
    if d.get("extras") and not re.fullmatch(r"-|[A-Za-z0-9 ]{1,10}(,[A-Za-z0-9 ]{1,10})*", d["extras"]):
        return "Extras no válidos (códigos separados por comas)"
    if accion in ("V", "C", "P"):
        if not (d.get("numero") or d.get("referencia")):
            return "Falta el número de reserva o la referencia"
        if accion == "P":
            # Modificación: solo se envía lo que cambia; las fechas, si van, completas
            for k in ("recogida", "devolucion"):
                if d.get(k) and not is_datetime(d[k]):
                    return f"Fecha de {k} no válida (AAAA-MM-DD HH:MM)"
            if d.get("recogida") and d.get("devolucion") and d["devolucion"] <= d["recogida"]:
                return "La devolución debe ser posterior a la recogida"
            if not any(d.get(k) for k in ("recogida", "devolucion", "oficina_recogida", "oficina_devolucion",
                                          "grupo", "tarifa", "extras", "vuelo", "observaciones")):
                return "No hay nada que modificar"
        return None
    if not is_code(d.get("grupo")):
        return "Falta el grupo"
    for k in ("recogida", "devolucion"):
        if not is_datetime(d.get(k)):
            return f"Fecha de {k} no válida (AAAA-MM-DD HH:MM)"
        if not is_station(d.get(f"oficina_{k}")):
            return f"Falta la oficina de {k}"
    if d["devolucion"] <= d["recogida"]:
        return "La devolución debe ser posterior a la recogida"
    if not (d.get("apellidos", "").strip() and d.get("nombre", "").strip()):
        return "Faltan el nombre y los apellidos del conductor"
    if d.get("referencia") and not is_ref(d["referencia"]):
        return "Referencia no válida (máx. 30: letras, números, - _ / .)"
    if d.get("promocion") and not is_promo(d["promocion"]):
        return "Código de promoción no válido"
    if d.get("tipo_documento") == "DNI" and (d.get("pais") or "ES").upper() not in ("ES", "ESP", "ESPAÑA"):
        return "Un conductor extranjero no puede ir con DNI: usa Pasaporte u Otro"
    for k in ("nacimiento", "adicional_nacimiento"):
        if d.get(k) and not is_date(d[k]):
            return "Fecha de nacimiento no válida (AAAA-MM-DD)"
    if d.get("pago") not in (None, "", "destino", "credito", "prepago"):
        return "Modelo de pago no válido"
    return None


def doc_conductor(d):
    """DNI/NIE → ID_Doc; pasaporte u otro → PassportData (un extranjero nunca va como DNI)."""
    numero = (d.get("documento") or "").strip()
    if not numero:
        return ""
    if d.get("tipo_documento") == "DNI":
        return "<ID_Doc>" + tag("Number", numero) + "</ID_Doc>"
    return "<PassportData>" + tag("Number", numero) + "</PassportData>"


def conductor_adicional(d):
    if not (d.get("adicional_apellidos") and d.get("adicional_nombre")):
        return ""
    return ("<DriverAdd>"
            + tag("Name", f'{d["adicional_apellidos"].strip()},{d["adicional_nombre"].strip()}')
            + tag("Date_of_Birth", d.get("adicional_nacimiento"))
            + "</DriverAdd>")


# Modelos de pago del portal → campos de Rentway.
#   destino: el cliente paga en el mostrador (lo normal en un broker)
#   credito: lo paga la agencia a cuenta; se factura al cliente Rentway del broker
#   prepago: PENDIENTE de pasarela. inAnalysis deja la reserva esperando la
#            confirmación del pago (RW_WEBSERVICE §3); sin pasarela no se usa.
def pago(d):
    modo = d.get("pago")
    if modo == "prepago":
        return "<inAnalysis>true</inAnalysis>"
    return ""


def soap_reserva(b, accion, d):
    if accion == "N":
        tarifa = d.get("tarifa") or b["rate"].replace("{station}", d["oficina_recogida"])
        cuerpo = (
            tag("Group", d["grupo"])
            + "<PickUp>" + tag("Date", d["recogida"]) + tag("Rental_Station", d["oficina_recogida"])
            + tag("Flight", d.get("vuelo")) + "</PickUp>"
            + "<DropOff>" + tag("Date", d["devolucion"]) + tag("Rental_Station", d["oficina_devolucion"])
            + "</DropOff>"
            + "<Driver>"
            + tag("Name", f'{d["apellidos"].strip()},{d["nombre"].strip()}')  # Rentway: Apellidos,Nombre
            + tag("Address", d.get("direccion")) + tag("City", d.get("ciudad"))
            + tag("Postal_code", d.get("cp"))
            + doc_conductor(d)
            + tag("Mobile", d.get("movil")) + tag("EMail", d.get("email"))
            + tag("Country", d.get("pais")) + tag("Tax_Number", d.get("nif"))
            + tag("Date_of_Birth", d.get("nacimiento"))
            + "</Driver>"
            + conductor_adicional(d)
            + tag("Observations", d.get("observaciones"))
            + tag("RateCode", tarifa)
            + tag("Extras", d.get("extras"))
            + pago(d)  # orden del WSDL: inAnalysis, promotionCode, package
            + tag("promotionCode", d.get("promocion"))
            + tag("package", d.get("paquete"))  # sin él Rentway aplica la tarifa sin paquete
        )
    elif accion == "P":
        # Modificación: Rentway solo cambia lo que se envía
        recogida = tag("Date", d.get("recogida")) + tag("Rental_Station", d.get("oficina_recogida")) + tag("Flight", d.get("vuelo"))
        devolucion = tag("Date", d.get("devolucion")) + tag("Rental_Station", d.get("oficina_devolucion"))
        cuerpo = (
            tag("Group", d.get("grupo"))
            + (f"<PickUp>{recogida}</PickUp>" if recogida else "")
            + (f"<DropOff>{devolucion}</DropOff>" if devolucion else "")
            + tag("Observations", d.get("observaciones"))
            + tag("RateCode", d.get("tarifa"))
            + tag("Extras", d.get("extras"))  # "-" quita todos los extras aceptados
            + tag("package", d.get("paquete"))
        )
    elif accion == "C":
        cuerpo = tag("CancelationReason", d.get("motivo"))
    else:
        cuerpo = ""
    return f"""<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Create_Internacional_Reservation xmlns="{RES_NS}Create_Internacional_Reservation">
      <Reservation_Request xmlns="{RES_NS}Reservation_Request.xsd">
        {tag("CompanyCode", b["company"])}
        {tag("ClienteCode", b["customer"])}
        {tag("MessageType", accion)}
        {tag("Refrence", d.get("referencia"))}
        {tag("Reservation_Number", d.get("numero"))}
        {cuerpo}
        {tag("Username", b["user"])}
        {tag("Password", b["password"])}
      </Reservation_Request>
    </Create_Internacional_Reservation>
  </soap:Body>
</soap:Envelope>"""


ESTADOS = {"C": "Confirmada", "P": "Pendiente", "D": "Cancelada", "NC": "No confirmada", "RA": "Con contrato"}


def parse_reserva(xml):
    text = xml.decode("utf-8", "replace")

    def get(t):
        m = re.search(rf"<{t}>(.*?)</{t}>", text, re.S)
        return m.group(1).strip() if m else ""

    fault = get("faultstring")
    if fault:
        return {"error": fault}
    out = {
        "numero": get("Reservation_Nr"),
        "referencia": get("Refrence"),
        "estado": get("Status"),
        "importe": get("Reservation_Value"),
        "moneda": get("Currency"),
    }
    out["estado_texto"] = ESTADOS.get(out["estado"], out["estado"])
    # Rentway devuelve los errores como texto ("ERROR: ...") en lugar del dato
    for v in out.values():
        if isinstance(v, str) and v.upper().startswith("ERROR"):
            out["error"] = v
            break
    if not out.get("error") and not out["numero"].isdigit():
        out["error"] = out["numero"] or out["estado"] or "Respuesta sin número de reserva"
        out["respuesta"] = text[:1500]
    return out


def log_reserva(broker_id, entorno, accion, d, result):
    """Rastro de cada operación. Sin credenciales; del cliente solo el nombre."""
    entry = {
        "fecha": time.strftime("%Y-%m-%d %H:%M:%S"), "broker": broker_id, "entorno": entorno,
        "accion": accion, "referencia": d.get("referencia"), "numero_pedido": d.get("numero"),
        "tarifa": d.get("tarifa"), "paquete": d.get("paquete"), "promocion": d.get("promocion"),
        "extras": d.get("extras"), "pago": d.get("pago"), "devolucion": d.get("devolucion"),
        "oficina_devolucion": d.get("oficina_devolucion"),
        "agencia": d.get("_agencia"), "usuario": d.get("_usuario"), "total_estimado": d.get("total_estimado"),
        "grupo": d.get("grupo"), "recogida": d.get("recogida"), "oficina": d.get("oficina_recogida"),
        "cliente": f'{d.get("apellidos", "")}, {d.get("nombre", "")}'.strip(", "),
        "resultado": {k: v for k, v in result.items() if k != "respuesta"},
    }
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------- agencias del portal

def entradas_log():
    if not LOG_FILE.exists():
        return []
    out = []
    with open(LOG_FILE, encoding="utf-8") as fh:
        for linea in fh:
            try:
                out.append(json.loads(linea))
            except ValueError:
                pass
    return out


def mapa_registro(broker_id):
    """nº de reserva → agencia del portal que la creó (solo las creadas con sesión)."""
    m = {}
    for e in entradas_log():
        res = e.get("resultado") or {}
        if e.get("broker") == broker_id and e.get("accion") == "N" and not res.get("error") and res.get("numero"):
            m[res["numero"]] = e.get("agencia")
    return m


def visible(numero, b, ctx, agencia=None):
    """Una agencia ve lo que crearon ella o sus sucursales; la titular del cliente Rentway ve además
    lo que no salió del portal (mostrador, otros canales)."""
    if "mapa" not in ctx:
        ctx["mapa"] = mapa_registro(ctx.get("broker") or pa.broker_de(ctx["d"], ctx["agencia"]))
    ag = agencia or ctx["mapa"].get(str(numero))
    return ag in ctx["vis"] if ag else ctx["titular"]


def limite_credito(d, agencia):
    """(agencia que fija el límite, límite): el primero definido subiendo por la jerarquía."""
    vistos = set()
    while agencia and agencia not in vistos:
        vistos.add(agencia)
        a = d["agencias"].get(agencia) or {}
        if a.get("credito") is not None:
            return agencia, a["credito"]
        agencia = a.get("padre")
    return None, None


def credito(d, agencia):
    """Consumo PROVISIONAL a partir de reservas.log (reservas a crédito vivas creadas en el portal).
    La fuente buena será la contabilidad (Navision); queda pendiente de decidir."""
    titular, limite = limite_credito(d, agencia)
    if limite is None:
        return None
    ids, vivas = pa.subarbol(d, titular), {}
    for e in entradas_log():
        res = e.get("resultado") or {}
        if res.get("error"):
            continue
        n = res.get("numero") or e.get("numero_pedido")
        if e.get("accion") == "N" and e.get("pago") == "credito" and e.get("agencia") in ids and n:
            vivas[n] = num(res.get("importe")) or num(e.get("total_estimado")) or 0
        elif n in vivas and e.get("accion") == "P" and num(res.get("importe")):
            vivas[n] = num(res.get("importe"))
        elif n in vivas and e.get("accion") == "C":
            vivas.pop(n)
    usado = round(sum(vivas.values()), 2)
    return {"limite": limite, "usado": usado, "disponible": round(limite - usado, 2)}


INTERMEDIARIO = "rw:"  # agencia "rw:<broker>": el admin reserva directamente con un cliente de Rentway


def intermediario(u, agencia):
    """Broker elegido por un admin como intermediario, o None."""
    if not (u and u["rol"] == "admin" and str(agencia or "").startswith(INTERMEDIARIO)):
        return None
    k = agencia[len(INTERMEDIARIO):]
    b = load_brokers().get(k)
    return k if b and configured(b) and b["entorno"] != "prueba" and b["reservable"] else None


def yo(u, agencia=None):
    rw = intermediario(u, agencia)
    f = pa.ficha_yo(u, None if rw else agencia)
    d = pa.cargar()
    if rw:
        f["agencia"] = {"id": INTERMEDIARIO + rw, "nombre": load_brokers()[rw]["nombre"], "pagos": ["destino"],
                        "credito": None, "titular": True, "intermediario": True}
    elif f["agencia"]["id"] and "credito" in f["agencia"]["pagos"]:
        f["agencia"]["credito_info"] = credito(d, f["agencia"]["id"])
    if u["rol"] == "admin":
        f["intermediarios"] = sorted(
            [{"id": INTERMEDIARIO + k, "nombre": b["nombre"], "reservable": b["reservable"]}
             for k, b in load_brokers().items() if configured(b) and b["entorno"] != "prueba"],
            key=lambda x: x["nombre"].lower())
    return f


def permiso_reserva(accion, body, b, ctx):
    d, act = ctx["d"], ctx["agencia"]
    if accion == "N":
        pagos = d["agencias"].get(act, {}).get("pagos", ["destino"])
        pago = body.get("pago") or "destino"
        if pago not in pagos:
            return "Esa forma de pago no está habilitada para tu agencia"
        if pago == "credito":
            c = credito(d, act)
            importe = num(body.get("total_estimado")) or 0
            if c and importe > c["disponible"]:
                return (f"Crédito agotado: disponible {c['disponible']:.2f} € de {c['limite']:.2f} €. "
                        "Elige otra forma de pago o contacta con tu gestor comercial")
        return None
    if not str(body.get("numero") or "").isdigit():
        return "Indica el número de reserva"
    if not visible(body["numero"], b, ctx):
        return "Reserva no encontrada para tu agencia"
    return None


# ---------------------------------------------------------------- HTTP

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def send_json(self, body, status=200, cookie=None):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            # HttpOnly: el JavaScript no puede leerla · SameSite=Strict: otra web no puede usarla
            vida = f"Max-Age={pa.SESION_HORAS * 3600}" if cookie else "Max-Age=0"
            seguro = "; Secure" if MODO_PUBLICO else ""
            self.send_header("Set-Cookie", f"{COOKIE}={cookie}; Path=/; HttpOnly; SameSite=Strict; {vida}{seguro}")
        self.end_headers()
        self.wfile.write(data)

    def token(self):
        c = SimpleCookie()
        try:
            c.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        return c[COOKIE].value if COOKIE in c else None

    def do_GET(self):
        path, _, qs = self.path.partition("?")
        path = path.lstrip("/")
        q = {k: v[0] for k, v in parse_qs(qs).items()}
        u = pa.usuario(self.token())
        if path == "api/yo":
            return self.send_json(yo(u, q.get("agencia")) if u else {"error": "Sin sesión"}, 200 if u else 401)
        if path == "api/admin":
            if not u or u["rol"] == "agente":
                return self.send_json({"error": "Sin permiso"}, 403)
            datos = pa.datos_admin(u)
            if u["rol"] == "admin":
                datos["brokers"] = [{"id": k, "nombre": b["nombre"], "reservable": b["reservable"]}
                                    for k, b in load_brokers().items() if configured(b) and b["entorno"] != "prueba"]
            return self.send_json(datos)
        if path == "api/brokers":
            if MODO_PUBLICO and not (u and u["rol"] == "admin"):
                return self.send_json({"error": "Sin permiso"}, 403)
            return self.send_json([
                {"id": k, "nombre": b["nombre"], "activo": configured(b) and b["reservable"],
                 "reservable": b["reservable"], "entorno": b["entorno"]}
                for k, b in load_brokers().items()
            ])
        if path in BLOCKED or path.startswith(".git") or path.endswith(".py"):
            return self.send_error(404)
        if MODO_PUBLICO and (path in ("", "index.html", "explorador.html") or path.startswith(("docs/", "scraper/", "worker/"))):
            # publicado: solo el portal; el panel interno sigue siendo local
            self.send_response(302)
            self.send_header("Location", "/portal.html")
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except ValueError:
            return self.send_json({"error": "Petición no válida"}, 400)
        if not isinstance(body, dict):
            return self.send_json({"error": "Petición no válida"}, 400)
        try:
            if path == "/api/login":
                tok = pa.login(body.get("email"), body.get("clave"))
                return self.send_json(yo(pa.usuario(tok)), cookie=tok)
            if path == "/api/logout":
                pa.logout(self.token())
                return self.send_json({"ok": True}, cookie="")
            u = pa.usuario(self.token())
            if path == "/api/clave":
                if not u:
                    return self.send_json({"error": "Sin sesión"}, 401)
                pa.cambiar_clave(u["email"], body.get("actual"), body.get("nueva"))
                return self.send_json({"ok": True})
            if path == "/api/admin/agencia":
                if not u:
                    return self.send_json({"error": "Sin sesión"}, 401)
                brokers = {k for k, b in load_brokers().items()
                           if configured(b) and b["entorno"] != "prueba" and b["reservable"]}
                return self.send_json({"id": pa.guardar_agencia(u, body, brokers)})
            if path == "/api/admin/usuario":
                if not u:
                    return self.send_json({"error": "Sin sesión"}, 401)
                return self.send_json({"ok": True, "temporal": pa.guardar_usuario(u, body)})
        except pa.Prohibido as e:
            return self.send_json({"error": str(e)}, 403)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)

        # Con sesión de portal, la agencia (y su cliente de Rentway) la decide el servidor, nunca el navegador
        ctx = None
        rw = intermediario(u, body.get("agencia"))
        if rw:
            # admin con un intermediario de Rentway: sin agencia del portal, pago en destino, lo ve todo
            d = pa.cargar()
            ctx = {"u": u, "d": d, "agencia": None, "vis": set(d["agencias"]), "titular": True, "broker": rw}
            body["provider"] = rw
            body["_agencia"], body["_usuario"] = None, u["email"]
        elif u:
            d = pa.cargar()
            act = pa.agencia_activa(d, u, body.get("agencia"))
            if not act:
                return self.send_json({"error": "Usuario sin agencia"}, 403)
            ctx = {"u": u, "d": d, "agencia": act,
                   "vis": pa.subarbol(d, act) if u["rol"] != "agente" else {act},
                   "titular": pa.es_titular(d, act)}
            body["provider"] = pa.broker_de(d, act)
            body["_agencia"], body["_usuario"] = act, u["email"]
        elif MODO_PUBLICO or self.headers.get("X-Portal") == "1":
            return self.send_json({"error": "Sesión caducada", "login": True}, 401)

        broker_id = body.get("provider", "")
        b = load_brokers().get(broker_id)
        if not b or not configured(b):
            return self.send_json({"error": f"Broker sin credenciales: {broker_id}"}, 400)
        if not b["reservable"] and (path in ("/api/precios", "/api/disponibilidad")
                                    or path == "/api/reserva" and body.get("accion") == "N"):
            return self.send_json({"error": "Ese cliente no tiene tarifa en Rentway: no se puede reservar con él"}, 400)
        if path == "/api/precios":
            if ctx:
                return self.send_json({"error": "Sin permiso"}, 403)
            return self.precios(b, body)
        if path == "/api/disponibilidad":
            return self.disponibilidad(b, body)
        if path == "/api/reserva":
            return self.reserva(broker_id, b, body, ctx)
        if path in CONSULTAS:
            if ctx and path == "/api/facturas" and (ctx["u"]["rol"] == "agente" or not ctx["titular"]):
                return self.send_json({"error": "Las facturas solo las ve el responsable de la agencia titular"}, 403)
            return self.consulta(path, b, body, ctx)
        return self.send_error(404)

    def consulta(self, path, b, d, ctx=None):
        try:
            result = CONSULTAS[path](b, d)
            if ctx and path == "/api/listado" and "reservas" in result:
                result["reservas"] = [r for r in result["reservas"] if visible(r["numero"], b, ctx, r.get("agencia"))]
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:
            return self.send_json({"error": f"No se pudo contactar con Jimpisoft ({e.__class__.__name__})"}, 502)
        return self.send_json(result)

    def precios(self, b, body):
        group, pu, do, st = (body.get(k) for k in ("groupID", "pickupDate", "dropoffDate", "station"))
        rate = (body.get("rateCode") or "").strip().upper() or None  # vacío = la tarifa del broker (o todas)
        # Sin groupID, Rentway devuelve todos los grupos y tarifas disponibles para el broker
        if not ((not group or is_code(group)) and (not rate or is_code(rate))
                and is_station(st) and is_date(pu) and is_date(do)):
            return self.send_json({"error": "Parámetros no válidos"}, 400)
        try:
            status, xml = post_soap(
                base_url(b) + "getMultiplePrices.asmx",
                soap_prices(b, group, pu, do, st, rate=rate),
                {"Content-Type": f'application/soap+xml; charset=utf-8; action="{PRICES_ACTION}"'},
                retries=1,
            )
        except Exception as e:
            return self.send_json({"error": f"No se pudo contactar con Jimpisoft ({e.__class__.__name__})"}, 502)
        self.send_response(status)
        self.send_header("Content-Type", "text/xml; charset=utf-8")
        self.send_header("Content-Length", str(len(xml)))
        self.end_headers()
        self.wfile.write(xml)

    def disponibilidad(self, b, d):
        pu, do = d.get("recogida"), d.get("devolucion")
        sp, sd = d.get("oficina_recogida"), d.get("oficina_devolucion") or d.get("oficina_recogida")
        dob = d.get("nacimiento") or None
        promo = (d.get("promocion") or "").strip() or None
        if promo and not is_promo(promo):
            return self.send_json({"error": "Código de promoción no válido"}, 400)
        if not (is_datetime(pu) and is_datetime(do) and is_station(sp) and is_station(sd)) or (dob and not is_date(dob)):
            return self.send_json({"error": "Parámetros no válidos"}, 400)
        if do <= pu:
            return self.send_json({"error": "La devolución debe ser posterior a la recogida"}, 400)
        try:
            status, xml = post_soap(
                base_url(b) + "getMultiplePrices.asmx",
                soap_prices(b, None, pu, do, sp, sd, dob, rate="", promo=promo),  # sin tarifa: todas las del broker
                {"Content-Type": f'application/soap+xml; charset=utf-8; action="{PRICES_ACTION}"'},
                retries=1,
            )
        except Exception as e:
            return self.send_json({"error": f"No se pudo contactar con Jimpisoft ({e.__class__.__name__})"}, 502)
        result = parse_disponibilidad(xml)
        if status != 200 and not result.get("error"):
            result = {"error": f"HTTP {status}"}
        return self.send_json(result)

    def reserva(self, broker_id, b, body, ctx=None):
        accion = body.get("accion", "")
        error = validar_reserva(accion, body)
        if error:
            return self.send_json({"error": error}, 400)
        if ctx:
            error = permiso_reserva(accion, body, b, ctx)
            if error:
                return self.send_json({"error": error}, 403)
        if accion == "N" and body.get("pago") == "prepago" and not PASARELA_ACTIVA:
            return self.send_json({"error": "El prepago con tarjeta aún no está disponible"}, 400)
        if accion == "N" and not body.get("referencia"):
            # Referencia única por reserva: si se reintenta, Rentway rechaza el duplicado
            body["referencia"] = time.strftime("FD%y%m%d%H%M%S") + secrets.token_hex(2).upper()
        try:
            status, xml = post_soap(
                base_url(b) + "Create_Reservation.asmx",
                soap_reserva(b, accion, body),
                {"Content-Type": "text/xml; charset=utf-8", "SOAPAction": f'"{RES_ACTION}"'},
            )
            result = parse_reserva(xml)
            if status != 200 and not result.get("error"):
                result["error"] = f"HTTP {status}"
        except Exception as e:
            result = {"error": f"No se pudo contactar con Jimpisoft ({e.__class__.__name__})"}
        result["referencia"] = result.get("referencia") or body.get("referencia", "")
        log_reserva(broker_id, b["entorno"], accion, body, result)
        return self.send_json(result, 200 if not result.get("error") else 502)

    def log_message(self, fmt, *args):
        # Solo se registran las llamadas a la API, nunca cuerpos ni credenciales
        if "/api/" in self.path:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    if "--usuario" in sys.argv:
        # py server.py --usuario correo@empresa.com --rol admin [--agencia id]
        arg = lambda k, defecto="": sys.argv[sys.argv.index(k) + 1] if k in sys.argv else defecto
        clave = pa.alta_cli(arg("--usuario"), arg("--rol", "admin"), arg("--agencia"))
        print(f"Usuario {arg('--usuario')} listo. Contraseña temporal (cámbiala al entrar): {clave}")
        sys.exit(0)
    if not BROKERS_FILE.exists():
        print("AVISO: falta brokers.ini — copia brokers.ejemplo.ini y rellénalo.")
    print(f"Panel en http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
