/* ============================================
   Portal de agencias (B2B) — fase 0, sobre el servidor local
   --------------------------------------------
   Usa los mismos endpoints que el panel interno:
     /api/brokers · /api/disponibilidad · /api/grupo · /api/extras
     /api/reserva (N crear · P modificar · C cancelar · V consultar)
     /api/listado · /api/facturas
   La "agencia" es un broker de brokers.ini (su cliente en Rentway): Rentway
   aplica sus tarifas, comisiones y condiciones. En fase 1 vendrá del login.
   ============================================ */

(() => {
  const $ = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Preferencias del navegador (marca, idioma, agencia, logo): si no hay almacenamiento, se sigue sin ellas
  const guardado = {
    get(k) { try { return localStorage.getItem("portal." + k); } catch { return null; } },
    set(k, v) { try { v === null ? localStorage.removeItem("portal." + k) : localStorage.setItem("portal." + k, v); } catch { /* sin almacenamiento */ } },
  };

  const params = new URLSearchParams(location.search);
  const s = {
    lang: params.get("lang") || guardado.get("lang") || "es",
    marca: params.get("marca") || guardado.get("marca") || "avis",
    agencia: "", yo: null,
    adm: null,
    consulta: null, opciones: [], grupos: {}, cat: "",
    elegida: null, extras: [], sel: {}, enviando: false, ultima: null,
    reservas: [], facturas: [],
  };

  const t = k => (I18N[s.lang] && I18N[s.lang][k]) || I18N.es[k] || k;
  const estado = e => s.lang === "en" ? (ESTADOS_EN[e] || e) : e;
  const money = v => (v === null || v === undefined || v === "" || isNaN(v)) ? "—"
    : new Intl.NumberFormat(s.lang === "en" ? "en-GB" : "es-ES", { style: "currency", currency: "EUR" }).format(+v);
  const fecha = v => {
    if (!v) return "—";
    const [d, h] = v.split(" ");
    const [y, m, dd] = d.split("-");
    return `${dd}/${m}/${y}${h ? " " + h.slice(0, 5) : ""}`;
  };
  const oficina = c => (PORTAL.oficinas.find(o => o[0] === c) || [c, c])[1];

  function toast(msg) {
    const el = $("p-toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // La agencia y su cliente de Rentway los pone el servidor a partir de la sesión;
  // "agencia" solo sirve para que un responsable/admin elija entre las que puede ver.
  async function api(path, body) {
    const res = await fetch(path, {
      method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Portal": "1" },
      body: JSON.stringify({ agencia: s.agencia, ...body }),
    });
    const data = await res.json();
    if (res.status === 401) mostrarLogin();
    return data;
  }

  /* ---------------------------------------------------------------- sesión */
  function mostrarLogin(msg) {
    s.yo = null;
    $("login").hidden = false;
    $("lg-error").hidden = !msg; $("lg-error").textContent = msg || "";
    setTimeout(() => $("lg-email").focus(), 50);
  }

  async function sesion(agencia) {
    try {
      const res = await fetch("/api/yo" + (agencia ? "?agencia=" + encodeURIComponent(agencia) : ""), { cache: "no-store" });
      if (res.status === 401) return mostrarLogin();
      aplicarSesion(await res.json());
    } catch { toast(t("error_red")); }
  }

  function aplicarSesion(yo) {
    s.yo = yo; s.agencia = yo.agencia.id;
    $("login").hidden = true;
    $("p-user").textContent = yo.nombre || yo.email;
    $("p-user").title = `${yo.email} · ${t("rol_" + yo.rol)}`;
    const varias = yo.agencias.length > 1;
    $("p-agencia-wrap").hidden = !varias;
    $("p-agencia-fija").hidden = varias;
    $("p-agencia-fija").textContent = yo.agencia.nombre;
    $("p-agencia").innerHTML = yo.agencias.map(a => `<option value="${esc(a.id)}">${a.padre ? "— " : ""}${esc(a.nombre)}</option>`).join("");
    $("p-agencia").value = s.agencia;
    // Facturas: solo responsables de la agencia titular del cliente Rentway; Administración: no agentes
    document.querySelector("[data-vista=facturas]").hidden = yo.rol === "agente" || !yo.agencia.titular;
    document.querySelector("[data-vista=admin]").hidden = yo.rol === "agente";
    pintarPagos();
    if (yo.debe_cambiar) abrirClave(true);
  }

  function pintarPagos() {
    if (!s.yo) return;
    const pagos = s.yo.agencia.pagos || ["destino"];
    $$("input[name=pago]").forEach(r => {
      const ok = pagos.includes(r.value) && r.value !== "prepago";  // prepago: hasta que haya pasarela
      r.disabled = !ok;
      r.closest("label").hidden = !pagos.includes(r.value);
      r.closest("label").classList.toggle("p-off", !ok);
    });
    const marcado = document.querySelector("input[name=pago]:checked");
    if (!marcado || marcado.disabled) {
      const primero = [...$$("input[name=pago]")].find(r => !r.disabled);
      if (primero) primero.checked = true;
    }
    const c = s.yo.agencia.credito_info;
    $("c-credito").hidden = !c;
    if (c) $("c-credito").innerHTML = `${t("credito_disp")}: <strong>${money(c.disponible)}</strong> / ${money(c.limite)}`;
  }

  async function entrar(e) {
    e.preventDefault();
    const btn = $("lg-entrar"); btn.disabled = true;
    try {
      const res = await fetch("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: $("lg-email").value.trim(), clave: $("lg-clave").value }),
      });
      const data = await res.json();
      if (!res.ok) { $("lg-error").hidden = false; $("lg-error").textContent = data.error || t("error_red"); return; }
      $("lg-clave").value = "";
      reiniciar();
      aplicarSesion(data);
    } catch { $("lg-error").hidden = false; $("lg-error").textContent = t("error_red"); }
    finally { btn.disabled = false; }
  }

  async function salir() {
    $("p-user-menu").hidden = true;
    try { await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch { /* da igual */ }
    reiniciar(); mostrarLogin();
  }

  function abrirClave(obligatorio) {
    $("p-user-menu").hidden = true;
    $("f-clave").reset(); $("mc-error").hidden = true;
    $("mc-cancelar").hidden = !!obligatorio;
    $("mc-nota").textContent = obligatorio ? t("clave_primera") : t("clave_nota");
    $("m-clave").classList.remove("hidden");
  }

  async function guardarClave(e) {
    e.preventDefault();
    const err = msg => { $("mc-error").hidden = false; $("mc-error").textContent = msg; };
    if ($("mc-nueva").value !== $("mc-repite").value) return err(t("clave_no_coincide"));
    const res = await fetch("/api/clave", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actual: $("mc-actual").value, nueva: $("mc-nueva").value }),
    });
    const data = await res.json();
    if (!res.ok) return err(data.error);
    $("m-clave").classList.add("hidden");
    if (s.yo) s.yo.debe_cambiar = false;
    toast(t("clave_ok"));
  }

  // Errores de Rentway más comunes, traducidos
  const ERRORES = {
    "NO RATE IS AVAILABLE FOR YOUR SELECTION.": ["Sin tarifa disponible para esa selección.", "No rate available for this selection."],
    "THE PICKUP DATE CAN'T BE PREVIOUS THAN CURRENT DATE!": ["La recogida no puede ser anterior a ahora.", "Pick-up cannot be in the past."],
    "RESERVATION NOT AUTHORIZED. RELEASE AUTHORIZATION!": ["Demasiado cerca de la recogida para reservar online.", "Too close to pick-up to book online."],
    "RESERVATION ALREADY EXIST!": ["Ya existe una reserva con ese localizador.", "A booking with that reference already exists."],
    "STOP SELL ACCOUNT": ["No hay disponibilidad para tu agencia en esas fechas.", "No availability for your agency on those dates."],
    "ONEWAY NOT DEFINED BETWEEN PICKUP AND DROPOFF STATIONS!": ["No hay servicio de devolución entre esas oficinas.", "No one-way service between those offices."],
    "Sin disponibilidad para esa selección": ["No hay vehículos disponibles para esa búsqueda.", "No vehicles available for this search."],
    "THE PROMOTION CODE INFORMED IS NOT VALID!": ["El código promocional no es válido.", "The promo code is not valid."],
    "CANCELATION FOR RESERVATION ALREADY CANCELLED!": ["La reserva ya estaba cancelada.", "The booking was already cancelled."],
    "CANCELATION NOT ALLOWED FOR RESERVATION WITH RENTAL AGREEMENT!": ["No se puede cancelar: ya tiene contrato.", "Cannot cancel: the rental has started."],
  };
  const traducir = e => {
    const k = String(e || "").trim().replace(/^ERROR:\s*/, "");
    const hit = ERRORES[k] || ERRORES[k + "!"];
    return hit ? hit[s.lang === "en" ? 1 : 0] : e;
  };

  /* ---------------------------------------------------------------- arranque */
  document.addEventListener("DOMContentLoaded", async () => {
    const ofs = PORTAL.oficinas.map(([c, n]) => `<option value="${c}">${esc(n)} (${c})</option>`).join("");
    $$(".p-of").forEach(el => { el.innerHTML = ofs; });
    $("c-pais").innerHTML = PORTAL.paises.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join("");

    const hoy = new Date(), dia = n => new Date(hoy.getTime() + n * 864e5).toISOString().slice(0, 10);
    $("b-f-rec").value = dia(7); $("b-f-dev").value = dia(14);
    $("l-desde").value = dia(-30); $("l-hasta").value = dia(60);
    $("fa-desde").value = dia(-90); $("fa-hasta").value = dia(0);

    $("p-lang").value = s.lang; $("p-marca").value = s.marca;
    aplicarMarca(); aplicarIdioma();

    $("p-lang").addEventListener("change", e => { s.lang = e.target.value; guardado.set("lang", s.lang); aplicarIdioma(); repintar(); });
    $("p-marca").addEventListener("change", e => { s.marca = e.target.value; guardado.set("marca", s.marca); aplicarMarca(); });
    $("p-agencia").addEventListener("change", e => { reiniciar(); sesion(e.target.value); });
    $("f-login").addEventListener("submit", entrar);
    $("p-user").addEventListener("click", () => { $("p-user-menu").hidden = !$("p-user-menu").hidden; });
    $("p-salir").addEventListener("click", salir);
    $("p-cambiar-clave").addEventListener("click", () => abrirClave(false));
    $("f-clave").addEventListener("submit", guardarClave);
    $("mc-cancelar").addEventListener("click", () => $("m-clave").classList.add("hidden"));
    $("f-usuario").addEventListener("submit", guardarUsuario);
    $("f-agencia").addEventListener("submit", guardarAgencia);
    $("au-limpiar").addEventListener("click", () => editarUsuario(null));
    $("aa-limpiar").addEventListener("click", () => editarAgencia(null));
    document.querySelector("[data-vista=admin]").addEventListener("click", cargarAdmin);
    $$("[data-vista]").forEach(b => b.addEventListener("click", () => vista(b.dataset.vista)));

    $("b-of-rec").addEventListener("change", () => { $("b-of-dev").value = $("b-of-rec").value; });
    $("f-buscar").addEventListener("submit", e => { e.preventDefault(); buscar(); });
    $$("[data-cat]").forEach(b => b.addEventListener("click", () => {
      s.cat = b.dataset.cat; $$("[data-cat]").forEach(x => x.classList.toggle("on", x === b)); pintarResultados();
    }));
    $("b-solo-pack").addEventListener("change", pintarResultados);
    $("c-atras").addEventListener("click", () => paso(1));
    $("c-confirmar").addEventListener("click", confirmar);
    $("c-pais").addEventListener("change", () => { if ($("c-pais").value !== "ES" && $("c-tipo-doc").value === "DNI") $("c-tipo-doc").value = "PAS"; });
    $$("input[name=pago]").forEach(r => r.addEventListener("change", pintarTotal));

    $("f-listado").addEventListener("submit", e => { e.preventDefault(); listar(); });
    $("l-filtro").addEventListener("input", pintarListado);
    $("l-estado").addEventListener("change", pintarListado);
    $("l-csv").addEventListener("click", csvReservas);
    $("f-facturas").addEventListener("submit", e => { e.preventDefault(); facturas(); });
    $("fa-csv").addEventListener("click", csvFacturas);

    $$("[data-cerrar]").forEach(b => b.addEventListener("click", cerrarModal));
    $("m-detalle").addEventListener("click", e => { if (e.target.id === "m-detalle") cerrarModal(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") cerrarModal(); });

    await sesion();
  });

  function aplicarMarca() {
    const m = PORTAL.marcas[s.marca] || PORTAL.marcas.avis;
    document.body.dataset.marca = s.marca;
    const r = document.documentElement.style;
    r.setProperty("--brand", m.color); r.setProperty("--brand-dark", m.colorOscuro);
    r.setProperty("--brand-ink", m.texto); r.setProperty("--brand-accent", m.acento || m.color);
    $("p-logo").textContent = m.nombre;
    $$("[data-logo-marca]").forEach(el => { el.textContent = m.nombre; });
    document.title = `${m.nombre} · ${t("portal")}`;
  }

  function aplicarIdioma() {
    document.documentElement.lang = s.lang;
    $$("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
    $$("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    $("faq").innerHTML = (FAQ[s.lang] || FAQ.es).map(([q, a]) =>
      `<details class="p-card"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("");
    aplicarMarca();
  }

  // Al cambiar de idioma se repinta lo que esté a la vista
  function repintar() {
    if (s.opciones.length) pintarResultados();
    if (s.elegida) { pintarElegida(); pintarExtras(); pintarTotal(); }
    if (s.reservas.length) pintarListado();
    if (s.facturas.length) pintarFacturas();
    pintarPagos();
    if (s.adm) pintarAdmin();
  }

  function reiniciar() {
    s.opciones = []; s.elegida = null; s.reservas = []; s.facturas = [];
    $("b-resultados").innerHTML = ""; $("b-filtros").hidden = true;
    $("l-resultado").innerHTML = ""; $("l-barra").hidden = true;
    $("fa-resultado").innerHTML = ""; $("fa-barra").hidden = true;
    s.adm = null; vista("buscar");
    paso(1);
  }

  function vista(v) {
    $$("[data-vista]").forEach(b => b.classList.toggle("active", b.dataset.vista === v));
    $$("[data-v]").forEach(el => { el.hidden = el.dataset.v !== v; });
  }

  function paso(n) {
    $$("[data-p]").forEach(el => { el.hidden = el.dataset.p !== String(n); });
    $$("[data-paso]").forEach(el => el.classList.toggle("on", +el.dataset.paso <= n));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---------------------------------------------------------------- paso 1: búsqueda */
  async function buscar() {
    const q = {
      oficina_recogida: $("b-of-rec").value, oficina_devolucion: $("b-of-dev").value,
      recogida: `${$("b-f-rec").value} ${$("b-h-rec").value}`, devolucion: `${$("b-f-dev").value} ${$("b-h-dev").value}`,
      nacimiento: $("b-nac").value, promocion: $("b-promo").value.trim(),
    };
    if (q.devolucion <= q.recogida) return toast(s.lang === "en" ? "Drop-off must be after pick-up." : "La devolución debe ser posterior a la recogida.");
    const btn = $("b-buscar");
    btn.disabled = true; btn.textContent = t("buscando");
    $("b-resultados").innerHTML = `<p class="p-muted">${t("buscando")}</p>`;
    try {
      const data = await api("/api/disponibilidad", q);
      if (data.error) { $("b-resultados").innerHTML = `<p class="p-error">${esc(traducir(data.error))}</p>`; return; }
      s.consulta = q; s.opciones = data.opciones;
      await cargarFichas([...new Set(s.opciones.map(o => o.grupo))]);
      $("b-filtros").hidden = false;
      pintarResultados();
    } catch (e) {
      console.error(e);
      $("b-resultados").innerHTML = `<p class="p-error">${t("error_red")}</p>`;
    } finally {
      btn.disabled = false; btn.textContent = t("buscar");
    }
  }

  // Fichas de grupo (plazas, maletas, cambio…): el servidor las guarda 6 h
  async function cargarFichas(grupos) {
    const faltan = grupos.filter(g => !s.grupos[g]);
    await Promise.all(faltan.map(async g => {
      try {
        const f = await api("/api/grupo", { grupo: g });
        s.grupos[g] = f.error ? {} : f;
      } catch { s.grupos[g] = {}; }
    }));
  }

  // Categoría a partir del código SIPP (ACRISS) y de la ficha del grupo
  function categorias(o) {
    const f = s.grupos[o.grupo] || {}, sipp = (o.sipp || f.SIPP || "").toUpperCase();
    const cats = new Set();
    if ("MNEHCD".includes(sipp[0])) cats.add("eco");
    if (sipp[1] === "F" || sipp[1] === "G" || /SUV/i.test(o.nombre)) cats.add("suv");
    if (["V", "K", "M"].includes(sipp[1]) || +f.seats >= 7 || sipp[0] === "P" && sipp[1] === "V") cats.add("van");
    if (f.automaticTransmission === "true" || "ABD".includes(sipp[2] || "")) cats.add("auto");
    if ("EHCI".includes(sipp[3] || "") && sipp[3] !== "") cats.add("elec");
    return cats;
  }

  const precio = o => (o.descuento && o.total_desc) ? o.total_desc : o.total;

  function pintarResultados() {
    const soloPack = $("b-solo-pack").checked;
    const porGrupo = new Map();
    s.opciones.forEach((o, i) => {
      if (soloPack && !o.paquete) return;
      if (s.cat && !categorias(o).has(s.cat)) return;
      if (!porGrupo.has(o.grupo)) porGrupo.set(o.grupo, []);
      porGrupo.get(o.grupo).push({ o, i });
    });
    if (!porGrupo.size) { $("b-resultados").innerHTML = `<p class="p-muted">${t(s.opciones.length ? "ninguno_filtro" : "sin_resultados")}</p>`; return; }
    const grupos = [...porGrupo.values()].sort((a, b) => precio(a[0].o) - precio(b[0].o));
    const q = s.consulta, dias = s.opciones[0]?.dias || "";
    $("b-resultados").innerHTML = `
      <p class="p-hint">${porGrupo.size} · ${esc(dias)} ${t("dias")} · ${esc(oficina(q.oficina_recogida))} → ${esc(oficina(q.oficina_devolucion))}${q.oficina_recogida !== q.oficina_devolucion ? ` <span class="p-tag">${t("oneway")}</span>` : ""}</p>
      ${q.promocion && !s.opciones.some(o => o.descuento) ? `<div class="p-card p-warn">${t("promo_sin_descuento")}</div>` : ""}
      ${grupos.map(lista => tarjeta(lista)).join("")}`;
    $("b-resultados").querySelectorAll("[data-elegir]").forEach(b => b.addEventListener("click", () => elegir(+b.dataset.elegir)));
  }

  function specs(g, o) {
    const f = s.grupos[g] || {};
    const items = [];
    if (+f.seats) items.push(`${f.seats} ${t("plazas")}`);
    if (+f.suitcases) items.push(`${f.suitcases} ${t("maletas")}`);
    if (+f.doors) items.push(`${f.doors} ${t("puertas")}`);
    if (f.automaticTransmission) items.push(f.automaticTransmission === "true" ? t("automatico") : t("manual"));
    if (o?.sipp || f.SIPP) items.push(o?.sipp || f.SIPP);
    return items;
  }

  function tarjeta(lista) {
    lista.sort((a, b) => precio(a.o) - precio(b.o));
    const o0 = lista[0].o, f = s.grupos[o0.grupo] || {};
    const img = o0.imagen || f.imageURL || "";
    const modelo = [f.brand, f.model].filter(Boolean).join(" ");
    return `
      <article class="p-card p-car">
        <div class="p-car-img">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}</div>
        <div class="p-car-info">
          <h3>${esc(o0.nombre || o0.grupo)}</h3>
          ${modelo ? `<p class="p-muted">${esc(modelo)} ${t("o_similar")}</p>` : ""}
          <p class="p-specs">${specs(o0.grupo, o0).map(x => `<span>${esc(x)}</span>`).join("")}</p>
        </div>
        <div class="p-car-rates">
          ${lista.map(({ o, i }) => `
            <div class="p-rate">
              <div>
                <strong>${esc(o.tarifa)}</strong>${o.paquete ? ` <span class="p-tag">${esc(o.paquete)}</span>` : ""}
                ${o.incluidos ? `<br><small class="p-muted">${t("incluye")}: ${esc(o.incluidos)}</small>` : ""}
              </div>
              <div class="p-price">
                ${o.descuento ? `<s class="p-muted">${money(o.total)}</s> ` : ""}<strong>${money(precio(o))}</strong>
                <small class="p-muted">${money(o.dia)}${t("por_dia")}</small>
              </div>
              <button type="button" class="p-btn p-btn-main" data-elegir="${i}">${t("elegir")}</button>
            </div>`).join("")}
          <small class="p-muted">${t("precio_neto")}</small>
        </div>
      </article>`;
  }

  /* ---------------------------------------------------------------- paso 2: extras y conductor */
  async function elegir(i) {
    s.elegida = s.opciones[i]; s.extras = []; s.sel = {};
    pintarElegida(); paso(2);
    $("c-extras").innerHTML = `<p class="p-muted">${t("cargando_extras")}</p>`;
    pintarTotal();
    try {
      const q = s.consulta, o = s.elegida;
      const data = await api("/api/extras", { grupo: o.grupo, tarifa: o.tarifa, recogida: q.recogida, devolucion: q.devolucion,
        oficina_recogida: q.oficina_recogida, oficina_devolucion: q.oficina_devolucion, promocion: q.promocion, nacimiento: q.nacimiento });
      if (data.error) { $("c-extras").innerHTML = `<p class="p-error">${esc(traducir(data.error))}</p>`; return; }
      // Fuera: los paquetes (se eligen como tarifa en el paso 1) y los que Rentway
      // aplica solo por reglas (one way, conductor joven): enviarlos los cobraría siempre.
      const paquetes = new Set(s.opciones.map(x => x.paquete).filter(Boolean));
      const incluidos = new Set((o.incluidos || "").split(",").map(x => x.trim()));
      s.extras = data.extras.filter(x => !paquetes.has(x.codigo) && !["OW", "YOU"].includes(x.codigo))
        .map(x => ({ ...x, incluido: x.incluido || incluidos.has(x.codigo) }));
      s.extras.forEach(x => { if (x.obligatorio && !x.incluido) s.sel[x.codigo] = 1; });
      pintarExtras(); pintarTotal();
    } catch (e) {
      console.error(e);
      $("c-extras").innerHTML = `<p class="p-error">${t("error_red")}</p>`;
    }
  }

  function pintarElegida() {
    const o = s.elegida, q = s.consulta, f = s.grupos[o.grupo] || {};
    $("c-elegido").innerHTML = `
      ${o.imagen || f.imageURL ? `<img src="${esc(o.imagen || f.imageURL)}" alt="" referrerpolicy="no-referrer" />` : ""}
      <div>
        <strong>${esc(o.nombre)}</strong> · ${esc(o.tarifa)}${o.paquete ? " + " + esc(o.paquete) : ""}
        <br><small>${esc(oficina(q.oficina_recogida))} ${fecha(q.recogida)} → ${esc(oficina(q.oficina_devolucion))} ${fecha(q.devolucion)} · ${esc(o.dias)} ${t("dias")}</small>
        <br><small class="p-muted">${specs(o.grupo, o).join(" · ")}</small>
      </div>`;
  }

  const dias = () => +(s.elegida?.dias || 1);
  const costeExtra = (x, n) => (x.valor_iva || 0) * (x.por_dia ? dias() : 1) * n;

  function pintarExtras() {
    if (!s.extras.length) { $("c-extras").innerHTML = `<p class="p-muted">—</p>`; return; }
    const orden = [...s.extras].sort((a, b) => (b.seguro - a.seguro) || a.nombre.localeCompare(b.nombre));
    $("c-extras").innerHTML = orden.map(x => {
      const fijo = x.incluido || x.obligatorio, n = s.sel[x.codigo] || 0;
      const etiqueta = x.incluido ? `<span class="p-tag p-tag-ok">${t("incluido")}</span>`
        : x.obligatorio ? `<span class="p-tag">${t("obligatorio")}</span>`
        : !x.disponible ? `<span class="p-tag p-tag-off">${t("agotado")}</span>` : "";
      const control = fijo || !x.disponible ? ""
        : x.cantidad
          ? `<input type="number" min="0" max="4" value="${n}" data-extra="${esc(x.codigo)}" class="p-qty" aria-label="${esc(x.nombre)}" />`
          : `<input type="checkbox" ${n ? "checked" : ""} data-extra="${esc(x.codigo)}" aria-label="${esc(x.nombre)}" />`;
      return `
        <div class="p-extra ${fijo ? "fijo" : ""}">
          <div><strong>${esc(x.nombre)}</strong> ${etiqueta}
            ${x.franquicia ? `<br><small class="p-muted">${t("franquicia")}: ${money(x.franquicia)}</small>` : ""}</div>
          <div class="p-extra-precio">${x.incluido ? "" : `${money(x.valor_iva)}${x.por_dia ? t("por_dia") : ""}`}</div>
          <div class="p-extra-ctl">${control}</div>
        </div>`;
    }).join("");
    $("c-extras").querySelectorAll("[data-extra]").forEach(el => el.addEventListener("change", () => {
      const cod = el.dataset.extra, n = el.type === "checkbox" ? (el.checked ? 1 : 0) : Math.max(0, Math.min(4, +el.value || 0));
      if (n) {
        s.sel[cod] = n;
        // Coberturas incompatibles entre sí (must_not_include de Rentway)
        const x = s.extras.find(e => e.codigo === cod);
        (x?.excluir_con || "").split(",").map(c => c.trim()).filter(Boolean).forEach(c => { if (!s.extras.find(e => e.codigo === c)?.obligatorio) delete s.sel[c]; });
        (x?.incluir_con || "").split(",").map(c => c.trim()).filter(Boolean).forEach(c => { if (s.extras.some(e => e.codigo === c && !e.incluido)) s.sel[c] = s.sel[c] || 1; });
      } else delete s.sel[cod];
      pintarExtras(); pintarTotal();
    }));
  }

  function totalEstimado() {
    const base = precio(s.elegida) || 0;
    const extras = Object.entries(s.sel).reduce((a, [c, n]) => {
      const x = s.extras.find(e => e.codigo === c);
      return a + (x && !x.obligatorio ? costeExtra(x, n) : 0);  // los obligatorios ya van en el precio
    }, 0);
    return { base, extras, total: base + extras };
  }

  function pintarTotal() {
    if (!s.elegida) return;
    const { base, total } = totalEstimado();
    const lineas = Object.entries(s.sel).map(([c, n]) => {
      const x = s.extras.find(e => e.codigo === c);
      if (!x || x.obligatorio) return "";
      return `<tr><td>${esc(x.nombre)}${n > 1 ? " ×" + n : ""}</td><td class="num">${money(costeExtra(x, n))}</td></tr>`;
    }).join("");
    $("c-total").innerHTML = `
      <table class="p-kv">
        <tr><td>${t("alquiler")} (${esc(s.elegida.dias)} ${t("dias")})</td><td class="num">${money(base)}</td></tr>
        ${lineas}
        <tr class="p-kv-total"><td>${t("total")}</td><td class="num">${money(total)}</td></tr>
      </table>
      <small class="p-muted">${t("total_nota")}</small>`;
  }

  function datosReserva() {
    const o = s.elegida, q = s.consulta;
    const extras = Object.entries(s.sel).filter(([c]) => !s.extras.find(e => e.codigo === c)?.obligatorio)
      .flatMap(([c, n]) => Array(n).fill(c)).join(",");
    return {
      accion: "N", grupo: o.grupo, tarifa: o.tarifa, paquete: o.paquete,
      oficina_recogida: q.oficina_recogida, oficina_devolucion: q.oficina_devolucion,
      recogida: q.recogida, devolucion: q.devolucion, nacimiento: q.nacimiento, promocion: q.promocion,
      extras, pago: document.querySelector("input[name=pago]:checked")?.value || "destino", total_estimado: totalEstimado().total,
      referencia: $("c-ref").value.trim(),
      nombre: $("c-nombre").value.trim(), apellidos: $("c-apellidos").value.trim(),
      pais: $("c-pais").value, tipo_documento: $("c-tipo-doc").value, documento: $("c-doc").value.trim(),
      email: $("c-email").value.trim(), movil: $("c-movil").value.trim(),
      direccion: $("c-direccion").value.trim(), ciudad: $("c-ciudad").value.trim(), cp: $("c-cp").value.trim(),
      vuelo: $("c-vuelo").value.trim().toUpperCase(), observaciones: $("c-obs").value.trim(),
      adicional_nombre: $("c-ad-nombre").value.trim(), adicional_apellidos: $("c-ad-apellidos").value.trim(),
      adicional_nacimiento: $("c-ad-nac").value,
    };
  }

  async function confirmar() {
    if (s.enviando) return;  // doble clic = doble reserva
    const d = datosReserva();
    if (!d.nombre || !d.apellidos) return toast(t("falta_nombre"));
    if (d.email && !$("c-email").checkValidity()) return toast(t("email_mal"));
    if (d.tipo_documento === "DNI" && d.pais !== "ES" && d.documento) return toast(t("dni_extranjero"));
    if (d.referencia && !/^[A-Za-z0-9_\-\/.]{1,30}$/.test(d.referencia)) return toast(t("ref_mal"));
    if (PORTAL.terminosObligatorios && !$("c-terminos").checked) return toast(t("falta_terminos"));
    s.enviando = true;
    const btn = $("c-confirmar"); btn.disabled = true; btn.textContent = t("confirmando");
    const cotizado = totalEstimado().total;
    try {
      const res = await api("/api/reserva", d);
      paso(3);
      if (res.error) {
        $("r-resultado").innerHTML = `<div class="p-card p-ko"><strong>${t("reserva_ko")}</strong><p>${esc(traducir(res.error))}</p></div>
          <div class="p-actions"><button type="button" class="p-btn" id="r-volver">${t("atras")}</button></div>`;
        $("r-volver").addEventListener("click", () => paso(2));
        return;
      }
      // Misma forma que una fila del listado, para el bono
      s.ultima = {
        numero: res.numero, referencia: res.referencia, estado_texto: res.estado_texto, importe: +res.importe || null,
        oficina_recogida: d.oficina_recogida, recogida: d.recogida, oficina_devolucion: d.oficina_devolucion, devolucion: d.devolucion,
        vuelo: d.vuelo, grupo: d.grupo, nombre_grupo: s.elegida.nombre, tarifa: d.tarifa, paquete: d.paquete,
        dias: s.elegida.dias, conductor: `${d.apellidos}, ${d.nombre}`, pago: d.pago,
        extras: Object.entries(s.sel).map(([c, n]) => (s.extras.find(e => e.codigo === c)?.nombre || c) + (n > 1 ? " ×" + n : "")),
        incluidos: s.elegida.incluidos,
      };
      const dif = s.ultima.importe && Math.abs(s.ultima.importe - cotizado) > 0.01;
      $("r-resultado").innerHTML = `
        <div class="p-card p-ok">
          <span>${t("reserva_ok")}</span>
          <strong class="p-ok-num">${esc(res.numero)}</strong>
          <span>${esc(estado(res.estado_texto))} · ${money(res.importe)}</span>
          <small>${t("referencia")}: ${esc(res.referencia)}</small>
        </div>
        ${dif ? `<div class="p-card p-warn">${t("importe_distinto")} (${money(cotizado)} → ${money(s.ultima.importe)})</div>` : ""}
        ${bloqueLogo()}
        <div class="p-actions">
          <button type="button" class="p-btn p-btn-main" id="r-bono">${t("bono")}</button>
          <button type="button" class="p-btn" id="r-nueva">${t("nueva")}</button>
          <button type="button" class="p-btn" id="r-lista">${t("ver_reservas")}</button>
        </div>`;
      enlazarLogo($("r-resultado"));
      $("r-bono").addEventListener("click", () => imprimirBono(s.ultima));
      $("r-nueva").addEventListener("click", () => { limpiarConductor(); paso(1); });
      $("r-lista").addEventListener("click", () => { vista("reservas"); listar(); });
    } catch (e) {
      console.error(e);
      paso(3);
      $("r-resultado").innerHTML = `<div class="p-card p-ko">${t("sin_respuesta")}</div>`;
    } finally {
      s.enviando = false; btn.disabled = false; btn.textContent = t("confirmar");
    }
  }

  function limpiarConductor() {
    $("f-conductor").reset(); $("c-terminos").checked = false;
    s.elegida = null; s.sel = {};
  }

  /* ---------------------------------------------------------------- bono (PDF vía imprimir) */
  // Logo de la agencia: de momento se guarda en este navegador; en fase 1, en la ficha de la agencia
  const logoAgencia = () => guardado.get("logo." + s.agencia);

  function bloqueLogo() {
    const logo = logoAgencia();
    return `<div class="p-card p-logo-agencia">
      <span>${t("logo_agencia")}</span>
      ${logo ? `<img src="${logo}" alt="" />` : ""}
      <input type="file" accept="image/png,image/jpeg,image/svg+xml" data-logo />
      ${logo ? `<button type="button" class="p-btn" data-logo-quitar>${t("logo_quitar")}</button>` : ""}
    </div>`;
  }

  function enlazarLogo(root) {
    root.querySelector("[data-logo]")?.addEventListener("change", e => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 300 * 1024) return toast(s.lang === "en" ? "Logo too large (max. 300 KB)." : "Logo demasiado grande (máx. 300 KB).");
      const rd = new FileReader();
      rd.onload = () => { guardado.set("logo." + s.agencia, rd.result); root.querySelector(".p-logo-agencia").outerHTML = bloqueLogo(); enlazarLogo(root); };
      rd.readAsDataURL(file);
    });
    root.querySelector("[data-logo-quitar]")?.addEventListener("click", () => {
      guardado.set("logo." + s.agencia, null); root.querySelector(".p-logo-agencia").outerHTML = bloqueLogo(); enlazarLogo(root);
    });
  }

  function imprimirBono(r) {
    const m = PORTAL.marcas[s.marca] || PORTAL.marcas.avis, logo = logoAgencia();
    const agencia = s.yo?.agencia.nombre || "";
    const fila = (k, v) => v ? `<tr><th>${esc(k)}</th><td>${v}</td></tr>` : "";
    const pagos = { destino: t("pago_destino"), credito: t("pago_credito"), prepago: t("pago_prepago") };
    $("bono").innerHTML = `
      <div class="b-head">
        <div class="b-marca" style="background:${m.color};color:${m.texto}">${esc(m.nombre)}</div>
        ${logo ? `<img class="b-logo" src="${logo}" alt="" />` : `<div class="b-agencia">${esc(agencia)}</div>`}
      </div>
      <h1>${t("bono_titulo")}</h1>
      <p class="b-num">${esc(r.numero)}</p>
      <table class="b-tabla">
        ${fila(t("referencia"), esc(r.referencia))}
        ${fila(t("agencia"), esc(agencia))}
        ${fila(t("conductor_c"), esc(r.conductor))}
        ${fila(t("of_rec"), `${esc(oficina(r.oficina_recogida))} (${esc(r.oficina_recogida)}) · ${fecha(r.recogida)}${r.vuelo ? ` · ${t("vuelo")} ${esc(r.vuelo)}` : ""}`)}
        ${fila(t("of_dev"), `${esc(oficina(r.oficina_devolucion))} (${esc(r.oficina_devolucion)}) · ${fecha(r.devolucion)}`)}
        ${fila(t("col_grupo"), esc([r.grupo, r.nombre_grupo].filter(Boolean).join(" · ")) + ` <small>(${t("o_similar")})</small>`)}
        ${fila("Tarifa / Rate", esc([r.tarifa, r.paquete].filter(Boolean).join(" + ")))}
        ${fila(t("incluye"), esc(r.incluidos || ""))}
        ${fila(t("extras"), esc((r.extras || []).join(", ")))}
        ${fila(t("pago"), esc(pagos[r.pago] || ""))}
      </table>
      <p class="b-nota">${t("bono_presentar")}</p>
      <p class="b-pie">${t("emitido")}: ${fecha(new Date().toISOString().slice(0, 16).replace("T", " "))}</p>`;
    window.print();
  }

  /* ---------------------------------------------------------------- mis reservas */
  async function listar() {
    const numero = $("l-numero").value.trim();
    const body = numero ? { numero } : { desde: $("l-desde").value, hasta: $("l-hasta").value };
    $("l-resultado").innerHTML = `<p class="p-muted">${t("buscando")}</p>`;
    try {
      const data = await api("/api/listado", body);
      if (data.error) { $("l-resultado").innerHTML = `<p class="p-error">${esc(traducir(data.error))}</p>`; return; }
      s.reservas = data.reservas;
      s.aviso = data.aviso ? t(data.aviso) : "";
      const estados = [...new Set(s.reservas.map(r => r.estado_texto))].sort();
      $("l-estado").innerHTML = `<option value="">${t("todos_estados")}</option>` + estados.map(e => `<option value="${esc(e)}">${esc(estado(e))}</option>`).join("");
      $("l-barra").hidden = false;
      pintarListado();
    } catch (e) {
      console.error(e);
      $("l-resultado").innerHTML = `<p class="p-error">${t("error_red")}</p>`;
    }
  }

  function filtradas() {
    const f = $("l-filtro").value.trim().toLowerCase(), e = $("l-estado").value;
    return s.reservas.filter(r => (!e || r.estado_texto === e)
      && (!f || [r.numero, r.referencia, r.conductor, r.oficina_recogida, r.oficina_devolucion, r.grupo, r.tarifa].join(" ").toLowerCase().includes(f)));
  }

  function pintarListado() {
    const lista = filtradas();
    const aviso = s.aviso ? `<div class="p-card p-warn">${esc(s.aviso)}</div>` : "";
    if (!lista.length) { $("l-resultado").innerHTML = `${aviso}<p class="p-muted">${t("sin_reservas")}</p>`; return; }
    $("l-resultado").innerHTML = `${aviso}
      <p class="p-hint">${lista.length} ${t("reservas_n")}</p>
      <div class="p-table-wrap"><table class="p-table">
        <thead><tr><th>${t("col_reserva")}</th><th>${t("referencia")}</th><th>${t("col_estado")}</th><th>${t("col_cliente")}</th>
          <th>${t("col_recogida")}</th><th>${t("col_devolucion")}</th><th>${t("col_grupo")}</th><th class="num">${t("col_importe")}</th><th></th></tr></thead>
        <tbody>${lista.map(r => `
          <tr>
            <td><strong>${esc(r.numero)}</strong></td><td>${esc(r.referencia)}</td>
            <td><span class="p-estado e${esc(r.estado)}${r.contrato ? " ra" : ""}">${esc(estado(r.estado_texto))}</span></td>
            <td>${esc(r.conductor)}</td>
            <td>${esc(r.oficina_recogida)} · ${fecha(r.recogida)}</td><td>${esc(r.oficina_devolucion)} · ${fecha(r.devolucion)}</td>
            <td>${esc(r.grupo)}</td><td class="num">${money(r.importe)}</td>
            <td><button type="button" class="p-btn p-btn-sm" data-ver="${esc(r.numero)}">${t("detalle")}</button></td>
          </tr>`).join("")}</tbody>
      </table></div>`;
    $("l-resultado").querySelectorAll("[data-ver]").forEach(b => b.addEventListener("click", () => detalle(b.dataset.ver)));
  }

  // Se puede tocar si está pendiente o confirmada, sin contrato y con margen antes de la recogida
  function modificable(r) {
    if (!["0", "1"].includes(r.estado) || r.contrato) return false;
    const horas = (Date.parse(r.recogida.replace(" ", "T")) - Date.now()) / 36e5;
    return horas > (PORTAL.horasMinimasCambio || 0);
  }

  function gastosCancelacion(r) {
    const regla = PORTAL.cancelacion.find(c => c.tarifa === "*" || (r.tarifa || "").startsWith(c.tarifa));
    if (!regla || !r.importe) return null;
    const horas = (Date.parse(r.recogida.replace(" ", "T")) - Date.now()) / 36e5;
    const tramo = [...regla.tramos].sort((a, b) => a.horas - b.horas).find(x => horas < x.horas);
    return tramo ? { pct: tramo.pct, importe: Math.round(r.importe * tramo.pct) / 100 } : { pct: 0, importe: 0 };
  }

  function detalle(numero) {
    const r = s.reservas.find(x => x.numero === numero);
    if (!r) return;
    const puede = modificable(r);
    const lineas = r.lineas.map(l => `<tr><td>${esc(l.descripcion || l.codigo)}</td><td class="num">${esc(l.cantidad)}</td><td class="num">${money(l.unidad)}</td></tr>`).join("");
    $("m-cuerpo").innerHTML = `
      <h2>${t("col_reserva")} ${esc(r.numero)} <span class="p-estado e${esc(r.estado)}${r.contrato ? " ra" : ""}">${esc(estado(r.estado_texto))}</span></h2>
      <table class="p-kv">
        <tr><td>${t("referencia")}</td><td>${esc(r.referencia) || "—"}</td></tr>
        <tr><td>${t("col_cliente")}</td><td>${esc(r.conductor)}</td></tr>
        <tr><td>${t("of_rec")}</td><td>${esc(oficina(r.oficina_recogida))} · ${fecha(r.recogida)}${r.vuelo ? ` · ${t("vuelo")} ${esc(r.vuelo)}` : ""}</td></tr>
        <tr><td>${t("of_dev")}</td><td>${esc(oficina(r.oficina_devolucion))} · ${fecha(r.devolucion)}</td></tr>
        <tr><td>${t("col_grupo")} / Tarifa</td><td>${esc(r.grupo)} · ${esc(r.tarifa)} · ${esc(r.dias)} ${t("dias")}</td></tr>
        ${r.contrato ? `<tr><td>${t("col_contrato")}</td><td>${esc(r.contrato)}</td></tr>` : ""}
        <tr class="p-kv-total"><td>${t("col_importe")}</td><td>${money(r.importe)}</td></tr>
      </table>
      ${lineas ? `<table class="p-table p-table-sm"><tbody>${lineas}</tbody></table>` : ""}
      ${bloqueLogo()}
      <div class="p-actions">
        <button type="button" class="p-btn p-btn-main" data-bono>${t("bono")}</button>
        ${puede ? `<button type="button" class="p-btn" data-mod>${t("modificar")}</button>
                   <button type="button" class="p-btn p-btn-danger" data-cancel>${t("cancelar")}</button>` : ""}
      </div>
      ${!puede && ["0", "1"].includes(r.estado) && !r.contrato ? `<p class="p-muted">${t("no_cancelable")}</p>` : ""}
      <div id="m-accion"></div>`;
    enlazarLogo($("m-cuerpo"));
    $("m-cuerpo").querySelector("[data-bono]").addEventListener("click", () => imprimirBono({ ...r,
      extras: r.lineas.filter(l => l.tipo === "Options" && l.unidad).map(l => l.descripcion) }));
    $("m-cuerpo").querySelector("[data-mod]")?.addEventListener("click", () => formModificar(r));
    $("m-cuerpo").querySelector("[data-cancel]")?.addEventListener("click", () => cancelar(r));
    $("m-detalle").classList.remove("hidden");
  }

  function cerrarModal() { $("m-detalle").classList.add("hidden"); }

  function formModificar(r) {
    const [fr, hr] = r.recogida.split(" "), [fd, hd] = r.devolucion.split(" ");
    const ofs = PORTAL.oficinas.map(([c, n]) => `<option value="${c}">${esc(n)} (${c})</option>`).join("");
    $("m-accion").innerHTML = `
      <h3>${t("mod_titulo")}</h3>
      <p class="p-muted">${t("mod_nota")}</p>
      <form class="p-form" id="f-mod">
        <label><span>${t("of_rec")}</span><select id="m-of-rec">${ofs}</select></label>
        <label><span>${t("of_dev")}</span><select id="m-of-dev">${ofs}</select></label>
        <label><span>${t("f_rec")}</span><input type="date" id="m-f-rec" value="${esc(fr)}" /></label>
        <label><span>${t("hora")}</span><input type="time" id="m-h-rec" value="${esc((hr || "10:00").slice(0, 5))}" step="900" /></label>
        <label><span>${t("f_dev")}</span><input type="date" id="m-f-dev" value="${esc(fd)}" /></label>
        <label><span>${t("hora")}</span><input type="time" id="m-h-dev" value="${esc((hd || "10:00").slice(0, 5))}" step="900" /></label>
        <label><span>${t("vuelo")}</span><input id="m-vuelo" maxlength="10" value="${esc(r.vuelo)}" /></label>
        <label class="p-wide"><span>${t("observaciones")}</span><input id="m-obs" maxlength="250" /></label>
      </form>
      <div class="p-actions"><button type="button" class="p-btn p-btn-main" id="m-guardar">${t("mod_guardar")}</button></div>
      <div id="m-mod-res"></div>`;
    $("m-of-rec").value = r.oficina_recogida; $("m-of-dev").value = r.oficina_devolucion;
    $("m-guardar").addEventListener("click", async () => {
      const cambios = {};
      const rec = `${$("m-f-rec").value} ${$("m-h-rec").value}`, dev = `${$("m-f-dev").value} ${$("m-h-dev").value}`;
      if (rec !== r.recogida.slice(0, 16)) cambios.recogida = rec;
      if (dev !== r.devolucion.slice(0, 16)) cambios.devolucion = dev;
      if ($("m-of-rec").value !== r.oficina_recogida) cambios.oficina_recogida = $("m-of-rec").value;
      if ($("m-of-dev").value !== r.oficina_devolucion) cambios.oficina_devolucion = $("m-of-dev").value;
      if ($("m-vuelo").value.trim().toUpperCase() !== (r.vuelo || "")) cambios.vuelo = $("m-vuelo").value.trim().toUpperCase();
      if ($("m-obs").value.trim()) cambios.observaciones = $("m-obs").value.trim();
      if (!Object.keys(cambios).length) return toast(t("mod_nada"));
      if ((cambios.recogida || r.recogida) >= (cambios.devolucion || r.devolucion))
        return toast(s.lang === "en" ? "Drop-off must be after pick-up." : "La devolución debe ser posterior a la recogida.");
      const btn = $("m-guardar"); btn.disabled = true;
      try {
        const res = await api("/api/reserva", { accion: "P", numero: r.numero, ...cambios });
        $("m-mod-res").innerHTML = res.error
          ? `<p class="p-error">${esc(traducir(res.error))}</p>`
          : `<div class="p-card p-ok p-ok-sm"><span>${t("mod_ok")}</span><strong>${esc(res.numero || r.numero)}</strong><span>${money(res.importe)}</span></div>`;
        if (!res.error) listar();
      } catch { $("m-mod-res").innerHTML = `<p class="p-error">${t("sin_respuesta")}</p>`; }
      finally { btn.disabled = false; }
    });
  }

  async function cancelar(r) {
    const out = $("m-accion");
    // Confirmación en la propia página (sin confirm() del navegador)
    if (out.dataset.confirm !== r.numero) {
      out.dataset.confirm = r.numero;
      const g = gastosCancelacion(r);
      out.innerHTML = `<div class="p-card p-warn">
        ${g ? `<strong>${t("gastos")}: ${money(g.importe)} (${g.pct}%)</strong><br><small>${t("gastos_nota")}</small><br>` : ""}
        ${t("cancel_confirma")}</div>`;
      return;
    }
    delete out.dataset.confirm;
    out.innerHTML = `<p class="p-muted">…</p>`;
    try {
      const res = await api("/api/reserva", { accion: "C", numero: r.numero, motivo: "Cancelada desde el portal de agencias" });
      out.innerHTML = res.error ? `<p class="p-error">${esc(traducir(res.error))}</p>`
        : `<div class="p-card p-ok p-ok-sm"><span>${t("cancel_ok")}</span><strong>${esc(r.numero)}</strong></div>`;
      if (!res.error) listar();
    } catch { out.innerHTML = `<p class="p-error">${t("sin_respuesta")}</p>`; }
  }

  /* ---------------------------------------------------------------- facturas */
  async function facturas() {
    $("fa-resultado").innerHTML = `<p class="p-muted">${t("buscando")}</p>`;
    try {
      const data = await api("/api/facturas", { desde: $("fa-desde").value, hasta: $("fa-hasta").value, pendientes: $("fa-pend").checked });
      if (data.error) {
        $("fa-resultado").innerHTML = `<div class="p-card p-ko">${t("facturas_ko")}<br><small class="p-muted">${esc(data.error)}</small></div>`;
        return;
      }
      s.facturas = data.facturas;
      $("fa-barra").hidden = !s.facturas.length;
      pintarFacturas();
    } catch { $("fa-resultado").innerHTML = `<p class="p-error">${t("error_red")}</p>`; }
  }

  function pintarFacturas() {
    if (!s.facturas.length) { $("fa-resultado").innerHTML = `<p class="p-muted">${t("sin_facturas")}</p>`; return; }
    $("fa-resultado").innerHTML = `<div class="p-table-wrap"><table class="p-table">
      <thead><tr><th>${t("col_factura")}</th><th>${t("col_fecha")}</th><th>${t("col_vence")}</th><th>${t("col_reserva")}</th>
        <th>${t("referencia")}</th><th>${t("col_cliente")}</th><th class="num">${t("col_base")}</th><th class="num">${t("col_iva")}</th>
        <th class="num">${t("col_total")}</th><th class="num">${t("col_pagado")}</th></tr></thead>
      <tbody>${s.facturas.map(f => `<tr><td><strong>${esc(f.numero)}</strong></td><td>${fecha(f.fecha)}</td><td>${fecha(f.vencimiento)}</td>
        <td>${esc(f.reserva)}</td><td>${esc(f.referencia || f.voucher)}</td><td>${esc(f.conductor)}</td>
        <td class="num">${money(f.base)}</td><td class="num">${money(f.iva)}</td><td class="num">${money(f.total)}</td><td class="num">${money(f.pagado)}</td></tr>`).join("")}</tbody>
    </table></div>`;
  }

  /* ---------------------------------------------------------------- exportar (CSV que abre Excel) */
  function descargarCsv(nombre, cabecera, filas) {
    const celda = v => {
      const x = typeof v === "number" ? String(v).replace(".", ",") : String(v ?? "");
      return /[;"\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
    };
    const txt = "﻿" + [cabecera, ...filas].map(f => f.map(celda).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type: "text/csv;charset=utf-8" }));
    a.download = nombre; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function csvReservas() {
    descargarCsv(`reservas_${$("l-desde").value}_${$("l-hasta").value}.csv`,
      [t("col_reserva"), t("referencia"), t("col_estado"), t("col_cliente"), t("of_rec"), t("col_recogida"), t("vuelo"),
        t("of_dev"), t("col_devolucion"), t("col_grupo"), "Tarifa", t("dias"), t("col_importe"), t("col_contrato")],
      filtradas().map(r => [r.numero, r.referencia, estado(r.estado_texto), r.conductor, r.oficina_recogida, r.recogida, r.vuelo,
        r.oficina_devolucion, r.devolucion, r.grupo, r.tarifa, r.dias, r.importe, r.contrato]));
  }

  function csvFacturas() {
    descargarCsv(`facturas_${$("fa-desde").value}_${$("fa-hasta").value}.csv`,
      [t("col_factura"), t("col_fecha"), t("col_vence"), t("col_reserva"), t("col_contrato"), t("referencia"), "Voucher",
        t("col_cliente"), t("col_base"), t("col_iva"), t("col_total"), t("col_pagado")],
      s.facturas.map(f => [f.numero, f.fecha, f.vencimiento, f.reserva, f.contrato, f.referencia, f.voucher, f.conductor,
        f.base, f.iva, f.total, f.pagado]));
  }

  /* ---------------------------------------------------------------- administración */
  async function cargarAdmin() {
    try {
      const res = await fetch("/api/admin", { cache: "no-store" });
      if (res.status === 401) return mostrarLogin();
      s.adm = await res.json();
      if (!res.ok) { $("ad-usuarios").innerHTML = `<p class="p-error">${esc(s.adm.error)}</p>`; s.adm = null; return; }
      pintarAdmin();
    } catch { toast(t("error_red")); }
  }

  const nombreAgencia = id => (s.adm?.agencias.find(a => a.id === id) || {}).nombre || id || "—";

  function pintarAdmin() {
    const esAdmin = s.yo?.rol === "admin", a = s.adm;
    $("ad-agencia-box").hidden = !esAdmin;
    // un responsable no puede crear administradores
    document.querySelector("#au-rol option[value=admin]").hidden = !esAdmin;
    $("au-agencia").innerHTML = a.agencias.map(x => `<option value="${esc(x.id)}">${esc(x.nombre)}</option>`).join("");
    $("aa-padre").innerHTML = `<option value="">${t("ninguna")}</option>` + a.agencias.map(x => `<option value="${esc(x.id)}">${esc(x.nombre)}</option>`).join("");
    $("aa-broker").innerHTML = `<option value="">${t("heredar")}</option>` + (a.brokers || []).map(b => `<option value="${esc(b.id)}">${esc(b.nombre)}</option>`).join("");
    $("ad-usuarios").innerHTML = a.usuarios.length ? `<div class="p-table-wrap"><table class="p-table">
      <thead><tr><th>${t("email")}</th><th>${t("nombre")}</th><th>${t("agencia")}</th><th>${t("rol")}</th><th>${t("estado_u")}</th><th>${t("ultimo_acceso")}</th><th></th></tr></thead>
      <tbody>${a.usuarios.map(u => `<tr>
        <td>${esc(u.email)}</td><td>${esc(u.nombre)}</td><td>${esc(u.rol === "admin" && !u.agencia ? "—" : nombreAgencia(u.agencia))}</td>
        <td>${t("rol_" + u.rol)}</td>
        <td>${u.activo ? (u.debe_cambiar ? `<span class="p-tag">${t("pendiente_clave")}</span>` : `<span class="p-tag p-tag-ok">${t("activo")}</span>`) : `<span class="p-tag p-tag-off">${t("inactivo")}</span>`}</td>
        <td>${esc(u.ultimo_acceso || "—")}</td>
        <td><button type="button" class="p-btn p-btn-sm" data-edit-u="${esc(u.email)}">${t("editar")}</button></td>
      </tr>`).join("")}</tbody></table></div>` : `<p class="p-muted">—</p>`;
    $("ad-agencias").innerHTML = a.agencias.length ? `<div class="p-table-wrap"><table class="p-table">
      <thead><tr><th>${t("agencia")}</th><th>${t("agencia_superior")}</th><th>${t("cliente_rentway")}</th><th>${t("formas_pago")}</th><th class="num">${t("limite_credito_c")}</th><th>${t("estado_u")}</th><th></th></tr></thead>
      <tbody>${a.agencias.map(x => `<tr>
        <td><strong>${esc(x.nombre)}</strong><br><small class="p-muted">${esc(x.id)}</small></td>
        <td>${esc(x.padre ? nombreAgencia(x.padre) : "—")}</td><td>${esc(x.broker || t("heredar"))}</td>
        <td>${(x.pagos || []).map(p => t("pago_" + p)).join(", ")}</td>
        <td class="num">${x.credito === null || x.credito === undefined ? "—" : money(x.credito)}</td>
        <td>${x.activa === false ? `<span class="p-tag p-tag-off">${t("inactiva")}</span>` : `<span class="p-tag p-tag-ok">${t("activa")}</span>`}</td>
        <td>${esAdmin ? `<button type="button" class="p-btn p-btn-sm" data-edit-a="${esc(x.id)}">${t("editar")}</button>` : ""}</td>
      </tr>`).join("")}</tbody></table></div>` : `<p class="p-muted">${t("sin_agencias")}</p>`;
    $("ad-usuarios").querySelectorAll("[data-edit-u]").forEach(b => b.addEventListener("click", () => editarUsuario(b.dataset.editU)));
    $("ad-agencias").querySelectorAll("[data-edit-a]").forEach(b => b.addEventListener("click", () => editarAgencia(b.dataset.editA)));
  }

  function editarUsuario(email) {
    const u = email && s.adm.usuarios.find(x => x.email === email);
    $("f-usuario").reset(); $("au-res").innerHTML = "";
    $("ad-u-titulo").textContent = u ? t("editar_usuario") : t("nuevo_usuario");
    $("au-email").readOnly = !!u;
    $("au-reset-wrap").hidden = !u;
    if (u) {
      $("au-email").value = u.email; $("au-nombre").value = u.nombre || "";
      if (u.agencia) $("au-agencia").value = u.agencia;
      $("au-rol").value = u.rol; $("au-activo").checked = !!u.activo;
    }
    $("f-usuario").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function editarAgencia(id) {
    const a = id && s.adm.agencias.find(x => x.id === id);
    $("f-agencia").reset(); $("aa-res").innerHTML = "";
    $("ad-a-titulo").textContent = a ? t("editar_agencia") : t("nueva_agencia");
    $("aa-id").readOnly = !!a;
    if (a) {
      $("aa-id").value = a.id; $("aa-nombre").value = a.nombre; $("aa-padre").value = a.padre || "";
      $("aa-broker").value = a.broker || ""; $("aa-credito").value = a.credito ?? ""; $("aa-activa").checked = a.activa !== false;
      $$("input[name=aa-pago]").forEach(c => { c.checked = (a.pagos || []).includes(c.value); });
    }
    $("f-agencia").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function postAdmin(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 401) mostrarLogin();
    return [res.ok, await res.json()];
  }

  async function guardarUsuario(e) {
    e.preventDefault();
    const [ok, data] = await postAdmin("/api/admin/usuario", {
      email: $("au-email").value.trim(), nombre: $("au-nombre").value.trim(), agencia: $("au-agencia").value,
      rol: $("au-rol").value, activo: $("au-activo").checked, resetear: $("au-reset").checked,
    });
    if (!ok) { $("au-res").innerHTML = `<p class="p-error">${esc(data.error)}</p>`; return; }
    await cargarAdmin();
    // La contraseña temporal solo se enseña aquí, una vez: el servidor guarda solo su huella
    $("au-res").innerHTML = data.temporal
      ? `<div class="p-card p-warn">${t("temporal")}: <code class="p-code">${esc(data.temporal)}</code><br><small>${t("temporal_nota")}</small></div>`
      : `<p class="p-ok-txt">${t("guardado")}</p>`;
  }

  async function guardarAgencia(e) {
    e.preventDefault();
    const [ok, data] = await postAdmin("/api/admin/agencia", {
      id: $("aa-id").value.trim().toLowerCase(), nombre: $("aa-nombre").value.trim(), padre: $("aa-padre").value,
      broker: $("aa-broker").value, credito: $("aa-credito").value, activa: $("aa-activa").checked,
      pagos: [...$$("input[name=aa-pago]:checked")].map(c => c.value),
    });
    if (!ok) { $("aa-res").innerHTML = `<p class="p-error">${esc(data.error)}</p>`; return; }
    await cargarAdmin();
    await sesion(s.agencia);  // por si cambió la propia agencia (pagos, crédito)
    $("aa-res").innerHTML = `<p class="p-ok-txt">${t("guardado")}</p>`;
  }
})();
