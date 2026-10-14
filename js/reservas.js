/* ============================================
   Reservas en Rentway (solo con el servidor local: py server.py)
   --------------------------------------------
   Flujo: 1 disponibilidad (getMultiplePrices sin grupo, por oficina)
          2 conductor · 3 revisión · 4 resultado (con opción de cancelar)
   Las llamadas van a /api/disponibilidad y /api/reserva; el servidor
   pone las credenciales del broker y registra todo en reservas.log.
   ============================================ */

(() => {
  if (!IS_LOCAL) return;

  const $ = id => document.getElementById(id);
  const fmt = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
  const money = v => (v === null || v === undefined || v === "" || isNaN(v)) ? "—" : fmt.format(+v);

  const ERRORES = {
    "ERROR: NO RATE IS AVAILABLE FOR YOUR SELECTION.": "Sin tarifa disponible para esa selección.",
    "ERROR: THE PICKUP DATE CAN'T BE PREVIOUS THAN CURRENT DATE!": "La recogida no puede ser anterior a ahora.",
    "ERROR: RESERVATION NOT AUTHORIZED. RELEASE AUTHORIZATION!": "Fuera de plazo de release: demasiado cerca de la recogida.",
    "ERROR: RESERVATION ALREADY EXIST!": "Ya existe una reserva con esa referencia.",
    "ERROR: STOP SELL ACCOUNT": "Stop sell: no hay disponibilidad para este broker.",
    "ERROR: ACCOUNT IN STOP SELL FOR THE REQUESTED RESERVATION": "Stop sell: no hay disponibilidad para este broker.",
    "ERROR: INVALID RENTAL GROUP": "Grupo no válido para reservas por internet.",
    "ERROR: CANCELATION FOR RESERVATION ALREADY CANCELLED!": "La reserva ya estaba cancelada.",
    "ERROR: CANCELATION NOT ALLOWED FOR RESERVATION WITH RENTAL AGREEMENT!": "No se puede cancelar: ya tiene contrato.",
    "ONEWAY NOT DEFINED BETWEEN PICKUP AND DROPOFF STATIONS!": "No hay one way definido entre esas oficinas.",
    "Sin disponibilidad para esa selección": "Sin disponibilidad para esa selección.",
    "ERROR: THE PROMOTION CODE INFORMED IS NOT VALID": "El código de promoción no es válido para este broker.",
    "THE PROMOTION CODE INFORMED IS NOT VALID!": "El código de promoción no es válido para este broker.",
  };
  const traducir = e => ERRORES[(e || "").trim()] || ERRORES["ERROR: " + (e || "").trim()] || e;

  const r = { paso: 1, opciones: [], elegida: null, consulta: null, enviando: false };

  async function api(path, body) {
    const res = await fetch(path, {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  // Con código de promoción válido Rentway devuelve además el total con descuento
  const precio = o => (o.descuento && o.total_desc) ? o.total_desc : o.total;

  const broker = id => (state.brokers || []).find(b => b.id === id) || {};

  /* ---------- montaje ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    const btn = $("btn-reservas");
    if (!btn) return;
    btn.hidden = false;
    btn.addEventListener("click", abrir);

    // Oficinas: las mismas del selector de brokers
    const stations = $("q-station")?.innerHTML || "";
    document.querySelectorAll(".res-station").forEach(s => { s.innerHTML = stations; });
    $("r-of-rec").addEventListener("change", () => { $("r-of-dev").value = $("r-of-rec").value; limpiarOpciones(); });

    document.querySelectorAll("[data-res-close]").forEach(el => el.addEventListener("click", cerrar));
    document.addEventListener("keydown", e => { if (e.key === "Escape") cerrar(); });
    document.querySelectorAll("[data-res-tab]").forEach(t => t.addEventListener("click", () => pestana(t.dataset.resTab)));

    ["r-broker", "r-of-dev", "r-f-rec", "r-h-rec", "r-f-dev", "r-h-dev", "r-nac", "r-promo"].forEach(id =>
      $(id).addEventListener("change", limpiarOpciones));
    $("r-broker").addEventListener("change", avisoEntorno);
    $("r-buscar").addEventListener("click", buscarDisponibilidad);
    $("r-filtro").addEventListener("input", pintarOpciones);
    $("res-atras").addEventListener("click", () => irA(r.paso - 1));
    $("res-siguiente").addEventListener("click", revisar);
    $("res-crear").addEventListener("click", crear);
    $("res-otra").addEventListener("click", () => { resetConductor(); irA(1); });
    $("l-consultar").addEventListener("click", () => consultar($("l-broker").value, $("l-numero").value.trim(), $("l-resultado")));
  });

  function abrir() {
    const opts = (state.brokers || [])
      .map(b => `<option value="${escapeHtml(b.id)}" ${b.activo ? "" : "disabled"}>${escapeHtml(b.nombre)}${b.activo ? "" : " (sin credenciales)"}${b.entorno === "prueba" ? " · PRUEBAS" : ""}</option>`)
      .join("");
    ["r-broker", "l-broker"].forEach(id => {
      const sel = $(id), prev = sel.value;
      sel.innerHTML = opts;
      if (prev && broker(prev).activo) sel.value = prev;
      else sel.value = ($("q-provider")?.value && broker($("q-provider").value).activo) ? $("q-provider").value
        : ((state.brokers || []).find(b => b.activo)?.id || "");
    });
    // Fechas por defecto: las de la barra de cotización
    if (!$("r-f-rec").value) $("r-f-rec").value = $("q-pickup").value;
    if (!$("r-f-dev").value) $("r-f-dev").value = $("q-dropoff").value;
    if (!$("r-of-rec").value || r.paso === 1) {
      $("r-of-rec").value = $("q-station")?.value || "LPA";
      $("r-of-dev").value = $("r-of-rec").value;
    }
    avisoEntorno();
    $("res-modal").classList.remove("hidden");
    pestana("nueva");
  }

  function cerrar() { $("res-modal").classList.add("hidden"); }

  function pestana(t) {
    document.querySelectorAll("[data-res-tab]").forEach(b => b.classList.toggle("mode-tab-active", b.dataset.resTab === t));
    if (t === "buscar") irA("buscar"); else irA(r.paso === "buscar" ? 1 : r.paso);
  }

  function avisoEntorno() {
    const b = broker($("r-broker").value), el = $("res-env");
    el.hidden = false;
    el.className = "res-env " + (b.entorno === "prueba" ? "res-env-test" : "res-env-prod");
    el.textContent = b.entorno === "prueba"
      ? "Servidor de PRUEBAS de Jimpisoft: lo que crees aquí no llega a Rentway."
      : `PRODUCCIÓN · ${b.nombre || ""}: las reservas se crean en el Rentway real.`;
  }

  function irA(paso) {
    r.paso = paso;
    document.querySelectorAll("[data-res-step]").forEach(s => { s.hidden = String(s.dataset.resStep) !== String(paso); });
    $("res-env").hidden = paso !== 1 && paso !== 2;
    $("res-atras").hidden = !(paso === 2 || paso === 3);
    $("res-siguiente").hidden = paso !== 2;
    $("res-crear").hidden = paso !== 3;
    $("res-otra").hidden = paso !== 4;
    $("res-footer").hidden = paso === 1 || paso === "buscar";
  }

  /* ---------- paso 1: disponibilidad ---------- */
  function consultaActual() {
    return {
      provider: $("r-broker").value,
      oficina_recogida: $("r-of-rec").value,
      oficina_devolucion: $("r-of-dev").value,
      recogida: `${$("r-f-rec").value} ${$("r-h-rec").value}`,
      devolucion: `${$("r-f-dev").value} ${$("r-h-dev").value}`,
      nacimiento: $("r-nac").value || "",
      promocion: $("r-promo").value.trim(),
    };
  }

  function limpiarOpciones() {
    r.opciones = []; r.elegida = null;
    $("r-opciones").innerHTML = "";
    document.querySelector(".res-filter").hidden = true;
  }

  async function buscarDisponibilidad() {
    const q = consultaActual();
    if (!$("r-f-rec").value || !$("r-f-dev").value) return showToast("Indica las fechas de recogida y devolución");
    if (q.devolucion <= q.recogida) return showToast("La devolución debe ser posterior a la recogida");
    const btn = $("r-buscar"), label = btn.textContent;
    btn.disabled = true; btn.textContent = "Consultando…";
    $("r-opciones").innerHTML = `<p class="res-muted">Consultando a Rentway…</p>`;
    try {
      const data = await api("/api/disponibilidad", q);
      if (data.error) {
        $("r-opciones").innerHTML = `<p class="res-error">${escapeHtml(traducir(data.error))}</p>`;
        return;
      }
      r.consulta = q;
      r.opciones = data.opciones;
      document.querySelector(".res-filter").hidden = false;
      pintarOpciones();
    } catch (err) {
      console.error(err);
      $("r-opciones").innerHTML = `<p class="res-error">No se pudo contactar con el servidor local.</p>`;
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  function pintarOpciones() {
    const f = $("r-filtro").value.trim().toLowerCase();
    const lista = r.opciones
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => !f || [o.grupo, o.nombre, o.sipp, o.tarifa, o.paquete].join(" ").toLowerCase().includes(f));
    if (!lista.length) { $("r-opciones").innerHTML = `<p class="res-muted">Ninguna opción coincide.</p>`; return; }
    $("r-opciones").innerHTML = `
      <table class="res-table">
        <thead><tr><th>Grupo</th><th>Tarifa</th><th>Paquete</th><th>Incluye</th><th class="num">€/día</th><th class="num">Total</th><th></th></tr></thead>
        <tbody>${lista.map(({ o, i }) => `
          <tr>
            <td><strong>${escapeHtml(o.grupo)}</strong> <span class="res-muted">${escapeHtml(o.sipp)}</span><br><small>${escapeHtml(o.nombre)}</small></td>
            <td>${escapeHtml(o.tarifa)}${o.prepago === "true" ? ' <span class="res-tag">prepago</span>' : ""}</td>
            <td>${o.paquete ? `<span class="res-tag">${escapeHtml(o.paquete)}</span>` : '<span class="res-muted">—</span>'}</td>
            <td><small>${escapeHtml(o.incluidos || "—")}${o.obligatorios ? `<br>Oblig.: ${escapeHtml(o.obligatorios)}` : ""}</small></td>
            <td class="num">${money(o.dia)}</td>
            <td class="num">${o.descuento
              ? `<s class="res-muted">${money(o.total)}</s><br><strong>${money(o.total_desc)}</strong> <span class="res-tag">-${o.descuento}%</span>`
              : `<strong>${money(o.total)}</strong>`}</td>
            <td><button type="button" class="btn btn-ghost res-pick" data-i="${i}">Elegir</button></td>
          </tr>`).join("")}
        </tbody>
      </table>
      <p class="res-hint">${r.opciones.length} opciones · precios con impuestos · ${escapeHtml(r.opciones[0]?.dias || "")} días${
        r.consulta.promocion ? ` · promoción ${escapeHtml(r.consulta.promocion)}${r.opciones.some(o => o.descuento) ? "" : " (sin descuento en ninguna opción)"}` : ""}</p>`;
    $("r-opciones").querySelectorAll(".res-pick").forEach(b => b.addEventListener("click", () => elegir(+b.dataset.i)));
  }

  function elegir(i) {
    r.elegida = r.opciones[i];
    const o = r.elegida, q = r.consulta;
    $("r-elegida").innerHTML = `
      <strong>${escapeHtml(o.grupo)} · ${escapeHtml(o.nombre)}</strong> — ${escapeHtml(o.tarifa)}${o.paquete ? " + " + escapeHtml(o.paquete) : ""}
      · ${escapeHtml(q.oficina_recogida)} ${escapeHtml(q.recogida)} → ${escapeHtml(q.oficina_devolucion)} ${escapeHtml(q.devolucion)}
      ${q.promocion ? `· promo ${escapeHtml(q.promocion)}` : ""}
      · <strong>${money(precio(o))}</strong>`;
    irA(2);
    $("r-nombre").focus();
  }

  /* ---------- pasos 2-3: conductor y revisión ---------- */
  function datosReserva() {
    const o = r.elegida, q = r.consulta;
    return {
      provider: q.provider, accion: "N",
      grupo: o.grupo, tarifa: o.tarifa, paquete: o.paquete,
      oficina_recogida: q.oficina_recogida, oficina_devolucion: q.oficina_devolucion,
      recogida: q.recogida, devolucion: q.devolucion,
      nacimiento: q.nacimiento,
      promocion: q.promocion,
      referencia: $("r-ref").value.trim(),
      nombre: $("r-nombre").value.trim(), apellidos: $("r-apellidos").value.trim(),
      email: $("r-email").value.trim(), movil: $("r-movil").value.trim(),
      vuelo: $("r-vuelo").value.trim(), observaciones: $("r-obs").value.trim(),
    };
  }

  function revisar() {
    const d = datosReserva();
    if (!d.nombre || !d.apellidos) return showToast("Nombre y apellidos son obligatorios");
    if (d.email && !$("r-email").checkValidity()) return showToast("El email no es válido");
    if (d.referencia && !/^[A-Za-z0-9_\-\/.]{1,30}$/.test(d.referencia))
      return showToast("Referencia: máx. 30 caracteres (letras, números, - _ / .)");
    const b = broker(d.provider), o = r.elegida;
    const fila = (k, v) => v ? `<tr><th>${k}</th><td>${escapeHtml(v)}</td></tr>` : "";
    $("r-resumen").innerHTML = `
      <div class="res-env ${b.entorno === "prueba" ? "res-env-test" : "res-env-prod"}">
        ${b.entorno === "prueba" ? "Se creará en el servidor de PRUEBAS." : `Se creará una reserva REAL en Rentway con el broker <strong>${escapeHtml(b.nombre)}</strong>.`}
      </div>
      <table class="res-kv">
        ${fila("Broker", b.nombre)}
        ${fila("Grupo", `${o.grupo} · ${o.nombre} (${o.sipp})`)}
        ${fila("Tarifa", o.tarifa)}
        ${fila("Paquete", o.paquete)}
        ${fila("Promoción", d.promocion ? `${d.promocion}${o.descuento ? ` (-${o.descuento}%)` : " (sin descuento en esta opción)"}` : "")}
        ${fila("Referencia broker", d.referencia || "automática")}
        ${fila("Incluye", o.incluidos)}
        ${fila("Recogida", `${d.oficina_recogida} · ${d.recogida}${d.vuelo ? " · vuelo " + d.vuelo : ""}`)}
        ${fila("Devolución", `${d.oficina_devolucion} · ${d.devolucion}`)}
        ${fila("Conductor", `${d.apellidos}, ${d.nombre}`)}
        ${fila("Nacimiento", d.nacimiento)}
        ${fila("Email", d.email)}
        ${fila("Móvil", d.movil)}
        ${fila("Observaciones", d.observaciones)}
        <tr><th>Precio cotizado</th><td><strong>${money(precio(o))}</strong>${o.descuento ? ` <s class="res-muted">${money(o.total)}</s>` : ` (${money(o.dia)}/día)`}</td></tr>
      </table>`;
    irA(3);
  }

  async function crear() {
    if (r.enviando) return;  // evita doble clic = doble reserva
    r.enviando = true;
    const btn = $("res-crear"), label = btn.textContent;
    btn.disabled = true; btn.textContent = "Creando…";
    const d = datosReserva(), cotizado = precio(r.elegida);
    try {
      const res = await api("/api/reserva", d);
      irA(4);
      if (res.error) {
        $("r-resultado").innerHTML = `
          <div class="res-error-box"><strong>No se ha creado la reserva.</strong><br>${escapeHtml(traducir(res.error))}</div>
          <p class="res-hint">Referencia enviada: ${escapeHtml(res.referencia || "—")}. Queda anotado en reservas.log.</p>`;
        return;
      }
      const dif = res.importe && cotizado !== null && Math.abs(+res.importe - cotizado) > 0.01;
      $("r-resultado").innerHTML = `
        <div class="res-ok-box">
          <span class="res-ok-label">Reserva creada</span>
          <span class="res-ok-num">${escapeHtml(res.numero)}</span>
          <span>${escapeHtml(res.estado_texto || res.estado)} · ${money(res.importe)} ${escapeHtml(res.moneda || "")}</span>
          <small>Referencia ${escapeHtml(res.referencia || "—")}</small>
        </div>
        ${dif ? `<div class="res-warn-box">Ojo: Rentway ha reservado por ${money(res.importe)} y la cotización era ${money(cotizado)}.</div>` : ""}
        <div class="res-actions">
          <button type="button" class="btn btn-ghost" id="r-copiar">Copiar nº</button>
          <button type="button" class="btn btn-ghost" id="r-verificar">Consultar estado</button>
          <button type="button" class="btn btn-ghost res-danger" id="r-cancelar">Cancelar esta reserva</button>
        </div>
        <div id="r-accion-res"></div>`;
      $("r-copiar").addEventListener("click", () => { copyToClipboard(res.numero); showToast("Número copiado"); });
      $("r-verificar").addEventListener("click", () => consultar(d.provider, res.numero, $("r-accion-res")));
      $("r-cancelar").addEventListener("click", () => cancelar(d.provider, res.numero, $("r-accion-res")));
    } catch (err) {
      console.error(err);
      irA(4);
      $("r-resultado").innerHTML = `<div class="res-error-box"><strong>Sin respuesta del servidor local.</strong><br>
        No sabemos si la reserva se creó: búscala en Rentway antes de repetirla.</div>`;
    } finally {
      r.enviando = false;
      btn.disabled = false; btn.textContent = label;
    }
  }

  function resetConductor() {
    ["r-nombre", "r-apellidos", "r-email", "r-movil", "r-vuelo", "r-obs", "r-ref"].forEach(id => { $(id).value = ""; });
  }

  /* ---------- consultar / cancelar ---------- */
  async function consultar(provider, numero, out) {
    if (!/^\d+$/.test(numero || "")) return showToast("Escribe el número de reserva");
    out.innerHTML = `<p class="res-muted">Consultando…</p>`;
    const res = await api("/api/reserva", { provider, accion: "V", numero });
    if (res.error) { out.innerHTML = `<p class="res-error">${escapeHtml(traducir(res.error))}</p>`; return; }
    out.innerHTML = `
      <div class="res-ok-box res-ok-small">
        <span class="res-ok-label">Reserva ${escapeHtml(res.numero)}</span>
        <span>${escapeHtml(res.estado_texto || res.estado)} · ${money(res.importe)}</span>
        ${res.referencia ? `<small>Referencia ${escapeHtml(res.referencia)}</small>` : ""}
      </div>
      ${res.estado !== "D" ? `<div class="res-actions"><button type="button" class="btn btn-ghost res-danger" data-cancel>Cancelar esta reserva</button></div>` : ""}
      <div data-cancel-out></div>`;
    out.querySelector("[data-cancel]")?.addEventListener("click", () =>
      cancelar(provider, res.numero, out.querySelector("[data-cancel-out]")));
  }

  async function cancelar(provider, numero, out) {
    // Confirmación en la propia página (sin confirm() del navegador)
    if (!out.dataset.confirm) {
      out.dataset.confirm = "1";
      out.innerHTML = `<div class="res-warn-box">¿Cancelar la reserva ${escapeHtml(numero)} en Rentway? Pulsa otra vez "Cancelar esta reserva" para confirmar.</div>`;
      return;
    }
    delete out.dataset.confirm;
    out.innerHTML = `<p class="res-muted">Cancelando…</p>`;
    const res = await api("/api/reserva", { provider, accion: "C", numero, motivo: "Cancelada desde el panel" });
    out.innerHTML = res.error
      ? `<p class="res-error">${escapeHtml(traducir(res.error))}</p>`
      : `<div class="res-ok-box res-ok-small"><span class="res-ok-label">Reserva ${escapeHtml(res.numero || numero)}</span><span>${escapeHtml(res.estado_texto || res.estado)}</span></div>`;
  }
})();
