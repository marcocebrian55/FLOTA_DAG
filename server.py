"""
Servidor local FLOTA_DAG
------------------------
Sirve el panel y hace de proxy hacia Jimpisoft (Rentway) con las
credenciales de cada broker, que se leen de brokers.ini (NO se sube a git).

Uso:  py server.py          → http://localhost:8787

Endpoints:
  GET  /api/brokers   lista de brokers configurados (sin credenciales)
  POST /api/precios   {provider, groupID, pickupDate, dropoffDate, station}
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
import re
import secrets
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.sax.saxutils import escape

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
BLOCKED = {"brokers.ini", "server.py", "reservas.log"}

is_date = lambda s: bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", s or ""))
is_datetime = lambda s: bool(re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", s or ""))
is_code = lambda s: bool(re.fullmatch(r"[A-Za-z0-9]{1,10}", s or ""))
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
        }
    return brokers


def configured(b):
    return all(b[k] for k in ("company", "customer", "user", "password"))


def base_url(b):
    return ENTORNOS.get(b["entorno"], ENTORNOS["produccion"])


def post_soap(url, body, headers):
    """Devuelve (status, bytes). Lanza excepción si no hay conexión."""
    req = urllib.request.Request(url, data=body.encode("utf-8"), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


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


# ---------------------------------------------------------------- reservas

def validar_reserva(accion, d):
    if accion not in ("N", "V", "C"):
        return "Acción no válida (N, V o C)"
    if accion in ("V", "C"):
        if not (d.get("numero") or d.get("referencia")):
            return "Falta el número de reserva o la referencia"
        return None
    if not is_code(d.get("grupo")):
        return "Falta el grupo"
    for k in ("recogida", "devolucion"):
        if not is_datetime(d.get(k)):
            return f"Fecha de {k} no válida (AAAA-MM-DD HH:MM)"
        if not is_code(d.get(f"oficina_{k}")):
            return f"Falta la oficina de {k}"
    if d["devolucion"] <= d["recogida"]:
        return "La devolución debe ser posterior a la recogida"
    if not (d.get("apellidos", "").strip() and d.get("nombre", "").strip()):
        return "Faltan el nombre y los apellidos del conductor"
    if d.get("referencia") and not is_ref(d["referencia"]):
        return "Referencia no válida (máx. 30: letras, números, - _ / .)"
    if d.get("promocion") and not is_promo(d["promocion"]):
        return "Código de promoción no válido"
    return None


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
            + tag("Mobile", d.get("movil")) + tag("EMail", d.get("email"))
            + tag("Date_of_Birth", d.get("nacimiento"))
            + "</Driver>"
            + tag("Observations", d.get("observaciones"))
            + tag("RateCode", tarifa)
            + tag("Extras", d.get("extras"))
            + tag("package", d.get("paquete"))  # sin él Rentway aplica la tarifa sin paquete
            + tag("promotionCode", d.get("promocion"))
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
        "grupo": d.get("grupo"), "recogida": d.get("recogida"), "oficina": d.get("oficina_recogida"),
        "cliente": f'{d.get("apellidos", "")}, {d.get("nombre", "")}'.strip(", "),
        "resultado": {k: v for k, v in result.items() if k != "respuesta"},
    }
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------- HTTP

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def send_json(self, body, status=200):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0].lstrip("/")
        if path == "api/brokers":
            return self.send_json([
                {"id": k, "nombre": b["nombre"], "activo": configured(b), "entorno": b["entorno"]}
                for k, b in load_brokers().items()
            ])
        if path in BLOCKED or path.startswith(".git"):
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except ValueError:
            return self.send_json({"error": "Petición no válida"}, 400)
        broker_id = body.get("provider", "")
        b = load_brokers().get(broker_id)
        if not b or not configured(b):
            return self.send_json({"error": f"Broker sin credenciales: {broker_id}"}, 400)
        if path == "/api/precios":
            return self.precios(b, body)
        if path == "/api/disponibilidad":
            return self.disponibilidad(b, body)
        if path == "/api/reserva":
            return self.reserva(broker_id, b, body)
        return self.send_error(404)

    def precios(self, b, body):
        group, pu, do, st = (body.get(k) for k in ("groupID", "pickupDate", "dropoffDate", "station"))
        # Sin groupID, Rentway devuelve todos los grupos y tarifas disponibles para el broker
        if not ((not group or is_code(group)) and is_code(st) and is_date(pu) and is_date(do)):
            return self.send_json({"error": "Parámetros no válidos"}, 400)
        try:
            status, xml = post_soap(
                base_url(b) + "getMultiplePrices.asmx",
                soap_prices(b, group, pu, do, st),
                {"Content-Type": f'application/soap+xml; charset=utf-8; action="{PRICES_ACTION}"'},
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
        if not (is_datetime(pu) and is_datetime(do) and is_code(sp) and is_code(sd)) or (dob and not is_date(dob)):
            return self.send_json({"error": "Parámetros no válidos"}, 400)
        if do <= pu:
            return self.send_json({"error": "La devolución debe ser posterior a la recogida"}, 400)
        try:
            status, xml = post_soap(
                base_url(b) + "getMultiplePrices.asmx",
                soap_prices(b, None, pu, do, sp, sd, dob, rate="", promo=promo),  # sin tarifa: todas las del broker
                {"Content-Type": f'application/soap+xml; charset=utf-8; action="{PRICES_ACTION}"'},
            )
        except Exception as e:
            return self.send_json({"error": f"No se pudo contactar con Jimpisoft ({e.__class__.__name__})"}, 502)
        result = parse_disponibilidad(xml)
        if status != 200 and not result.get("error"):
            result = {"error": f"HTTP {status}"}
        return self.send_json(result)

    def reserva(self, broker_id, b, body):
        accion = body.get("accion", "")
        error = validar_reserva(accion, body)
        if error:
            return self.send_json({"error": error}, 400)
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
    if not BROKERS_FILE.exists():
        print("AVISO: falta brokers.ini — copia brokers.ejemplo.ini y rellénalo.")
    print(f"Panel en http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
