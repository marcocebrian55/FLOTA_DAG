"""
Acceso al portal de agencias: agencias, usuarios, sesiones.
------------------------------------------------------------
Todo vive en portal_datos.json (NO se sube a git; ruta cambiable con PORTAL_DATOS).

  agencias: {id: {nombre, broker, padre, pagos: [destino, credito, prepago], credito, activa}}
            · jerarquía sede → sucursales con "padre"
            · broker = bloque de brokers.ini (su cliente en Rentway); una sucursal sin broker hereda el de su sede
            · credito = límite en € (None = sin límite)
  usuarios: {email: {nombre, agencia, rol, clave (pbkdf2), activo, debe_cambiar}}
            · rol: admin (interno, todo) · responsable (su agencia y sucursales, gestiona usuarios) · agente
  sesiones: {sha256(token): {email, expira}} — el token solo lo tiene la cookie del navegador

Alta del primer administrador (contraseña temporal, se cambia al entrar):
  py server.py --usuario correo@empresa.com --rol admin
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATOS = Path(os.environ.get("PORTAL_DATOS") or ROOT / "portal_datos.json")
SESION_HORAS = 12
MAX_FALLOS, BLOQUEO_MIN = 5, 15
ROLES = ("admin", "responsable", "agente")
PAGOS = ("destino", "credito", "prepago")

_lock = threading.Lock()
_fallos = {}  # email → (nº de fallos, bloqueado hasta)

is_email = lambda s: bool(re.fullmatch(r"[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,}", s or ""))
is_id = lambda s: bool(re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,39}", s or ""))


class Prohibido(Exception):
    pass


# ---------------------------------------------------------------- fichero

def cargar():
    if not DATOS.exists():
        return {"agencias": {}, "usuarios": {}, "sesiones": {}}
    d = json.loads(DATOS.read_text(encoding="utf-8"))
    for k in ("agencias", "usuarios", "sesiones"):
        d.setdefault(k, {})
    return d


def guardar(d):
    tmp = DATOS.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(DATOS)


# ---------------------------------------------------------------- contraseñas

def hash_clave(clave, sal=None):
    sal = sal or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", clave.encode("utf-8"), bytes.fromhex(sal), 240_000).hex()
    return f"pbkdf2${sal}${h}"


def comprobar(clave, guardada):
    try:
        _, sal, _ = guardada.split("$")
    except (AttributeError, ValueError):
        return False
    return hmac.compare_digest(hash_clave(clave, sal), guardada)


def clave_valida(c):
    if len(c or "") < 10 or not re.search(r"[A-Za-z]", c) or not re.search(r"\d", c):
        return "La contraseña debe tener al menos 10 caracteres, con letras y números"
    return None


def clave_temporal():
    return secrets.token_urlsafe(9) + "7a"  # cumple la regla: letras y números


_sha = lambda t: hashlib.sha256(t.encode()).hexdigest()


# ---------------------------------------------------------------- sesiones

def login(email, clave):
    email = (email or "").strip().lower()
    with _lock:
        n, hasta = _fallos.get(email, (0, 0))
        if hasta > time.time():
            raise Prohibido(f"Demasiados intentos. Prueba de nuevo en {BLOQUEO_MIN} minutos")
        d = cargar()
        u = d["usuarios"].get(email)
        ag = d["agencias"].get(u["agencia"]) if u else None
        ok = u and u.get("activo") and comprobar(clave or "", u.get("clave"))
        if ok and u["rol"] != "admin" and not (ag and ag.get("activa", True)):
            ok = False
        if not ok:
            n += 1
            _fallos[email] = (n, time.time() + BLOQUEO_MIN * 60 if n >= MAX_FALLOS else 0)
            raise Prohibido("Email o contraseña incorrectos")
        _fallos.pop(email, None)
        token = secrets.token_urlsafe(32)
        ahora = time.time()
        d["sesiones"] = {k: v for k, v in d["sesiones"].items() if v["expira"] > ahora}
        d["sesiones"][_sha(token)] = {"email": email, "expira": ahora + SESION_HORAS * 3600}
        u["ultimo_acceso"] = time.strftime("%Y-%m-%d %H:%M")
        guardar(d)
        return token


def logout(token):
    with _lock:
        d = cargar()
        if d["sesiones"].pop(_sha(token or ""), None):
            guardar(d)


def usuario(token):
    """Usuario de la sesión (con su email) o None si no hay sesión válida."""
    if not token:
        return None
    d = cargar()
    s = d["sesiones"].get(_sha(token))
    if not s or s["expira"] < time.time():
        return None
    u = d["usuarios"].get(s["email"])
    if not u or not u.get("activo"):
        return None
    if u["rol"] != "admin" and not d["agencias"].get(u["agencia"], {}).get("activa", True):
        return None
    return {**u, "email": s["email"]}


def cambiar_clave(email, actual, nueva):
    err = clave_valida(nueva)
    if err:
        raise ValueError(err)
    with _lock:
        d = cargar()
        u = d["usuarios"].get(email)
        if not u or not comprobar(actual or "", u["clave"]):
            raise Prohibido("La contraseña actual no es correcta")
        if comprobar(nueva, u["clave"]):
            raise ValueError("La nueva contraseña debe ser distinta")
        u["clave"], u["debe_cambiar"] = hash_clave(nueva), False
        guardar(d)


# ---------------------------------------------------------------- jerarquía

def subarbol(d, agencia_id):
    """La agencia y todas sus sucursales (a cualquier nivel)."""
    out, pend = set(), [agencia_id]
    while pend:
        a = pend.pop()
        if a in out:
            continue
        out.add(a)
        pend += [k for k, v in d["agencias"].items() if v.get("padre") == a]
    return out


def visibles(d, u):
    if u["rol"] == "admin":
        return set(d["agencias"])
    return subarbol(d, u["agencia"]) if u["rol"] == "responsable" else {u["agencia"]}


def broker_de(d, agencia_id):
    vistos = set()
    while agencia_id and agencia_id not in vistos:
        vistos.add(agencia_id)
        a = d["agencias"].get(agencia_id) or {}
        if a.get("broker"):
            return a["broker"]
        agencia_id = a.get("padre")
    return None


def es_titular(d, agencia_id):
    """La agencia de más arriba con ese broker: ve todo lo que Rentway liste para el cliente,
    también lo que no se creó desde el portal."""
    a = d["agencias"].get(agencia_id) or {}
    padre = a.get("padre")
    return not padre or broker_de(d, padre) != broker_de(d, agencia_id)


def agencia_activa(d, u, pedida=None):
    """Agencia con la que actúa el usuario: la suya, o una visible si la pide (admin/responsable)."""
    vis = visibles(d, u)
    if pedida and pedida in vis:
        return pedida
    if u["rol"] == "admin" and u.get("agencia") not in d["agencias"]:
        return next(iter(sorted(vis)), None)
    return u["agencia"]


def ficha_yo(u, pedida=None):
    d = cargar()
    act = agencia_activa(d, u, pedida)
    ag = d["agencias"].get(act) or {}
    return {
        "email": u["email"], "nombre": u.get("nombre", ""), "rol": u["rol"], "debe_cambiar": u.get("debe_cambiar", False),
        "agencia": {"id": act, "nombre": ag.get("nombre", ""), "pagos": ag.get("pagos", ["destino"]),
                    "credito": ag.get("credito"), "titular": es_titular(d, act) if act else False},
        "agencias": sorted([{"id": k, "nombre": v["nombre"], "padre": v.get("padre")}
                            for k, v in d["agencias"].items() if k in visibles(d, u)], key=lambda a: a["nombre"]),
    }


# ---------------------------------------------------------------- administración

def datos_admin(u):
    d = cargar()
    vis = visibles(d, u)
    return {
        "agencias": [{"id": k, **{c: v.get(c) for c in ("nombre", "broker", "padre", "pagos", "credito", "activa")}}
                     for k, v in sorted(d["agencias"].items()) if k in vis],
        "usuarios": [{"email": k, **{c: v.get(c) for c in ("nombre", "agencia", "rol", "activo", "debe_cambiar", "ultimo_acceso")}}
                     for k, v in sorted(d["usuarios"].items()) if v["agencia"] in vis or (u["rol"] == "admin")],
    }


def guardar_agencia(u, a, brokers):
    """Alta o edición de agencia. Solo el administrador interno."""
    if u["rol"] != "admin":
        raise Prohibido("Solo un administrador puede dar de alta o cambiar agencias")
    aid = (a.get("id") or "").strip().lower()
    if not is_id(aid):
        raise ValueError("Identificador no válido (minúsculas, números, - y _)")
    nombre = (a.get("nombre") or "").strip()
    if not nombre or len(nombre) > 80:
        raise ValueError("Falta el nombre de la agencia")
    padre = a.get("padre") or None
    broker = a.get("broker") or None
    pagos = [p for p in (a.get("pagos") or []) if p in PAGOS] or ["destino"]
    credito = a.get("credito")
    if credito in ("", None):
        credito = None
    else:
        try:
            credito = round(float(credito), 2)
        except (TypeError, ValueError):
            raise ValueError("Límite de crédito no válido")
        if credito < 0:
            raise ValueError("Límite de crédito no válido")
    with _lock:
        d = cargar()
        # la superior debe existir y no puede ser ella misma ni una de sus sucursales (ciclo)
        if padre and (padre not in d["agencias"] or (aid in d["agencias"] and padre in subarbol(d, aid)) or padre == aid):
            raise ValueError("Agencia superior no válida")
        if broker and broker not in brokers:
            raise ValueError("Cliente de Rentway (broker) no configurado")
        if not broker and not (padre and broker_de(d, padre)):
            raise ValueError("Indica el cliente de Rentway, o una agencia superior que lo tenga")
        d["agencias"][aid] = {"nombre": nombre, "broker": broker, "padre": padre, "pagos": pagos,
                              "credito": credito, "activa": bool(a.get("activa", True))}
        guardar(d)
    return aid


def guardar_usuario(u, x):
    """Alta o edición. Devuelve la contraseña temporal si se ha creado o reseteado (solo se ve una vez)."""
    email = (x.get("email") or "").strip().lower()
    if not is_email(email):
        raise ValueError("Email no válido")
    rol = x.get("rol") or "agente"
    if rol not in ROLES:
        raise ValueError("Rol no válido")
    with _lock:
        d = cargar()
        vis = visibles(d, u)
        agencia = x.get("agencia") or ""
        if rol == "admin":
            if u["rol"] != "admin":
                raise Prohibido("Solo un administrador puede crear administradores")
            agencia = agencia if agencia in d["agencias"] else ""
        elif agencia not in d["agencias"]:
            raise ValueError("Agencia no válida")
        if u["rol"] == "agente":
            raise Prohibido("Sin permiso para gestionar usuarios")
        if rol != "admin" and agencia not in vis:
            raise Prohibido("No puedes gestionar usuarios de esa agencia")
        previo = d["usuarios"].get(email)
        if previo and previo.get("rol") == "admin" and u["rol"] != "admin":
            raise Prohibido("No puedes cambiar a un administrador")
        if previo and previo["agencia"] not in vis and u["rol"] != "admin":
            raise Prohibido("Ese email pertenece a otra agencia")
        if email == u["email"] and (rol != u["rol"] or not x.get("activo", True)):
            raise ValueError("No puedes cambiar tu propio rol ni desactivarte")
        temporal = None
        nuevo = {"nombre": (x.get("nombre") or "").strip()[:80], "agencia": agencia, "rol": rol,
                 "activo": bool(x.get("activo", True))}
        if previo and not x.get("resetear"):
            nuevo.update(clave=previo["clave"], debe_cambiar=previo.get("debe_cambiar", False),
                         ultimo_acceso=previo.get("ultimo_acceso"))
        else:
            temporal = clave_temporal()
            nuevo.update(clave=hash_clave(temporal), debe_cambiar=True)
            # una contraseña nueva cierra las sesiones abiertas de ese usuario
            d["sesiones"] = {k: v for k, v in d["sesiones"].items() if v["email"] != email}
        if not nuevo["activo"]:
            d["sesiones"] = {k: v for k, v in d["sesiones"].items() if v["email"] != email}
        d["usuarios"][email] = nuevo
        guardar(d)
    return temporal


def alta_cli(email, rol, agencia=""):
    """Alta desde la consola (primer administrador)."""
    falso_admin = {"rol": "admin", "email": "", "agencia": ""}
    return guardar_usuario(falso_admin, {"email": email, "rol": rol, "agencia": agencia, "nombre": email.split("@")[0],
                                         "resetear": True})
