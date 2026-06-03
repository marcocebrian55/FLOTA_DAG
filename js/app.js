/* ============================================
   Rentway — Catálogo de modelos
   ============================================ */

const state = {
  agencia: null,
  vehiculos: [],
  filtered: [],
  selected: new Set(),
  filtros: { search: "", categoria: "", tipo: "" }
};

const BASE_URL = (() => {
  const { origin, pathname } = window.location;
  const path = pathname.endsWith("/") ? pathname : pathname.replace(/\/[^/]*$/, "/");
  return origin + path;
})();

function resolveImageUrl(imagen) {
  if (!imagen) return null;
  if (/^https?:\/\//i.test(imagen)) return imagen;
  return BASE_URL + imagen.replace(/^\/+/, "");
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("footer-year").textContent = new Date().getFullYear();
  bindEvents();
  await loadFleet();
});

async function loadFleet() {
  try {
    const res = await fetch("fleet.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    state.agencia = data.agencia || {};
    state.vehiculos = data.vehiculos || [];
    state.filtered = [...state.vehiculos];

    // Por defecto, todos seleccionados
    state.selected = new Set();

    populateCategoriaFilter();
    renderKPIs();
    renderGrid();
    updateSelectionUI();
  } catch (err) {
    console.error("Error cargando fleet.json:", err);
    showToast("Error al cargar los datos");
  }
}

function populateCategoriaFilter() {
  const select = document.getElementById("filter-categoria");
  const categorias = [...new Set(state.vehiculos.map(v => v.categoria))].sort();
  categorias.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    select.appendChild(opt);
  });
}

function renderKPIs() {
  const total = state.vehiculos.length;
  const categorias = new Set(state.vehiculos.map(v => v.categoria)).size;
  const especial = state.vehiculos.filter(v => v.tipo === "ESPECIAL").length;
  const noEspecial = state.vehiculos.filter(v => v.tipo === "NO ESPECIAL").length;

  document.getElementById("kpi-total").textContent = total;
  document.getElementById("kpi-categorias").textContent = categorias;
  document.getElementById("kpi-especial").textContent = especial;
  document.getElementById("kpi-no-especial").textContent = noEspecial;
}

function renderGrid() {
  const grid = document.getElementById("fleet-grid");
  const empty = document.getElementById("empty-state");

  if (state.filtered.length === 0) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  grid.innerHTML = state.filtered.map(cardTemplate).join("");

  // Listeners para botones "Copiar URL"
  grid.querySelectorAll(".card-url-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      copyToClipboard(btn.dataset.url);
      showToast("URL copiada al portapapeles");
    });
  });

  // Listeners para checkboxes
  grid.querySelectorAll(".card-checkbox").forEach(cb => {
    cb.addEventListener("change", e => {
      const id = cb.dataset.id;
      if (cb.checked) state.selected.add(id);
      else state.selected.delete(id);
      cb.closest(".card").classList.toggle("card-selected", cb.checked);
      updateSelectionUI();
    });
  });

  // Click en la tarjeta (no en botón ni checkbox) también marca/desmarca
  grid.querySelectorAll(".card").forEach(card => {
    card.addEventListener("click", e => {
      // Ignorar clicks en el checkbox (ya gestionado) o en el botón de URL
      if (e.target.closest(".card-checkbox") || e.target.closest(".card-url-btn")) return;
      const cb = card.querySelector(".card-checkbox");
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
    });
  });
}

function cardTemplate(v) {
  const imageUrl = resolveImageUrl(v.imagen);
  const tipoBadge = v.tipo === "ESPECIAL" ? "badge-especial" : "badge-no-especial";
  const isSelected = state.selected.has(v.id);

  const imageBlock = imageUrl
    ? `<div class="card-image" style="background-image:url('${escapeHtml(imageUrl)}')">
         <span class="card-badge ${tipoBadge}">${v.tipo}</span>
       </div>`
    : `<div class="card-image">
         <div class="card-image-placeholder">Sin foto</div>
         <span class="card-badge ${tipoBadge}">${v.tipo}</span>
       </div>`;

  return `
    <article class="card ${isSelected ? 'card-selected' : ''}">
      <label class="card-checkbox-wrap" onclick="event.stopPropagation()">
        <input type="checkbox" class="card-checkbox" data-id="${escapeHtml(v.id)}" ${isSelected ? 'checked' : ''} />
        <span class="card-checkbox-custom"></span>
      </label>
      ${imageBlock}
      <div class="card-body">
        <div>
          <h3 class="card-title">${escapeHtml(v.nombre_completo || (v.marca + ' ' + v.modelo))}</h3>
          <p class="card-version">${escapeHtml(v.categoria)}</p>
        </div>
        <div class="card-meta">
          <span class="tag">Grupo ${escapeHtml(v.grupo)}</span>
          <span class="tag">SIPP ${escapeHtml(v.sipp)}</span>
        </div>
        <div class="card-price-slot" data-price-id="${escapeHtml(v.id)}">${priceBlockHtml(v.id)}</div>
        <div class="card-footer">
          <span class="card-matricula">${escapeHtml(v.id)}</span>
          <button class="card-url-btn" data-url="${escapeHtml(imageUrl || '')}" ${!imageUrl ? 'disabled' : ''}>
            Copiar URL foto
          </button>
        </div>
      </div>
    </article>
  `;
}

function applyFilters() {
  const { search, categoria, tipo } = state.filtros;
  const q = search.toLowerCase().trim();

  state.filtered = state.vehiculos.filter(v => {
    if (categoria && v.categoria !== categoria) return false;
    if (tipo && v.tipo !== tipo) return false;
    if (q) {
      const haystack = [
        v.marca, v.modelo, v.nombre_completo, v.grupo, v.sipp, v.categoria
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  renderGrid();
}

// ============================================
// Selección
// ============================================
function updateSelectionUI() {
  document.getElementById("selection-count").textContent = state.selected.size;
  document.getElementById("selection-total").textContent = state.vehiculos.length;

  // Habilitar/deshabilitar botón XML
  const btnXml = document.getElementById("btn-xml");
  btnXml.disabled = state.selected.size === 0;
  btnXml.classList.toggle("btn-disabled", state.selected.size === 0);
}

function selectAll() {
  state.selected = new Set(state.vehiculos.map(v => v.id));
  refreshCheckboxes();
  updateSelectionUI();
  showToast(`${state.selected.size} modelos seleccionados`);
}

function selectVisible() {
  state.filtered.forEach(v => state.selected.add(v.id));
  refreshCheckboxes();
  updateSelectionUI();
  showToast(`Añadidos ${state.filtered.length} visibles a la selección`);
}

function selectNone() {
  state.selected.clear();
  refreshCheckboxes();
  updateSelectionUI();
  showToast("Selección limpiada");
}

function refreshCheckboxes() {
  document.querySelectorAll(".card-checkbox").forEach(cb => {
    const isChecked = state.selected.has(cb.dataset.id);
    cb.checked = isChecked;
    cb.closest(".card").classList.toggle("card-selected", isChecked);
  });
}

// ============================================
// Generación de XML (solo de seleccionados)
// ============================================
function getSelectedVehicles() {
  return state.vehiculos.filter(v => state.selected.has(v.id));
}

function generateXML() {
  const ag = state.agencia || {};
  const fecha = new Date().toISOString();
  const seleccionados = getSelectedVehicles();

  const escapeXml = s => String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  const vehiculosXml = seleccionados.map(v => {
    const imagenUrl = resolveImageUrl(v.imagen) || "";
    return `  <vehiculo>
    <id>${escapeXml(v.id)}</id>
    <categoria>${escapeXml(v.categoria)}</categoria>
    <grupo>${escapeXml(v.grupo)}</grupo>
    <sipp>${escapeXml(v.sipp)}</sipp>
    <tipo>${escapeXml(v.tipo)}</tipo>
    <marca>${escapeXml(v.marca)}</marca>
    <modelo>${escapeXml(v.modelo)}</modelo>
    <nombre_completo>${escapeXml(v.nombre_completo)}</nombre_completo>
    <imagen>${escapeXml(imagenUrl)}</imagen>
    <estado>${escapeXml(v.estado)}</estado>
  </vehiculo>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<flota>
  <agencia>
    <nombre>${escapeXml(ag.nombre)}</nombre>
    <telefono>${escapeXml(ag.telefono)}</telefono>
    <email>${escapeXml(ag.email)}</email>
    <ubicacion>${escapeXml(ag.ubicacion)}</ubicacion>
  </agencia>
  <fecha_generacion>${fecha}</fecha_generacion>
  <total_vehiculos>${seleccionados.length}</total_vehiculos>
${vehiculosXml}
</flota>`;
}

function openXmlModal() {
  if (state.selected.size === 0) {
    showToast("Selecciona al menos un modelo");
    return;
  }
  document.getElementById("xml-output").value = generateXML();
  document.getElementById("xml-count").textContent =
    `(${state.selected.size} ${state.selected.size === 1 ? 'modelo' : 'modelos'})`;
  document.getElementById("xml-modal").classList.remove("hidden");
}

function closeXmlModal() {
  document.getElementById("xml-modal").classList.add("hidden");
}

function downloadXml() {
  const xml = document.getElementById("xml-output").value;
  const blob = new Blob([xml], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const fecha = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rentway_catalogo_${fecha}.xml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("XML descargado");
}

function copyAllUrls() {
  const seleccionados = getSelectedVehicles().filter(v => v.imagen);
  if (seleccionados.length === 0) {
    showToast("No hay URLs para copiar en la selección");
    return;
  }
  const urls = seleccionados
    .map(v => `${v.nombre_completo} (${v.grupo} - ${v.sipp}): ${resolveImageUrl(v.imagen)}`)
    .join("\n");

  copyToClipboard(urls);
  showToast(`${seleccionados.length} URLs copiadas`);
}

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text);
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  void toast.offsetWidth;
  toast.classList.add("visible");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.classList.add("hidden"), 250);
  }, 2200);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function bindEvents() {
  document.getElementById("filter-search").addEventListener("input", e => {
    state.filtros.search = e.target.value;
    applyFilters();
  });
  document.getElementById("filter-categoria").addEventListener("change", e => {
    state.filtros.categoria = e.target.value;
    applyFilters();
  });
  document.getElementById("filter-tipo").addEventListener("change", e => {
    state.filtros.tipo = e.target.value;
    applyFilters();
  });

  document.getElementById("btn-xml").addEventListener("click", openXmlModal);
  document.getElementById("btn-copy-urls").addEventListener("click", copyAllUrls);

  document.getElementById("btn-select-all").addEventListener("click", selectAll);
  document.getElementById("btn-select-visible").addEventListener("click", selectVisible);
  document.getElementById("btn-select-none").addEventListener("click", selectNone);

  document.querySelectorAll("[data-close]").forEach(el => {
    el.addEventListener("click", closeXmlModal);
  });
  document.getElementById("btn-copy-xml").addEventListener("click", () => {
    copyToClipboard(document.getElementById("xml-output").value);
    showToast("XML copiado al portapapeles");
  });
  document.getElementById("btn-download-xml").addEventListener("click", downloadXml);

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeXmlModal();
  });
}

// ============================================
// Cotizador multi-modelo (SOAP Jimpisoft)
// ============================================
const PRICE_WS_URL = "https://small-moon-0352.mcebrian-334.workers.dev";
const PRICE_CONCURRENCY = 4;

const RENTWAY_ERRORS = {
  "ERROR: PICKUP STATION DOES NOT EXIST!": "La oficina de recogida no existe.",
  "ERROR: USER OR PASSWORD INCORRECT": "Credenciales incorrectas.",
  "ERROR: PICKUP DATE CANNOT BE LOWER THAN TODAY": "La recogida no puede ser anterior a hoy.",
  "ERROR: RATE CODE DOES NOT EXIST!": "El código de tarifa no existe.",
  "ERROR: NO RATE IS AVAILABLE FOR YOUR SELECTION. ": "Sin tarifa disponible para estas fechas.",
  "ERROR: NO RATE IS AVAILABLE FOR YOUR SELECTION.": "Sin tarifa disponible para estas fechas."
};

state.prices = {}; // id -> {loading} | {error} | {dailyValue, totalValue, days, rateCode}

document.addEventListener("DOMContentLoaded", () => {
  const iso = d => d.toISOString().split("T")[0];
  const addDays = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
  const today = new Date();
  // Jimpisoft rechaza recogidas en el día actual: por defecto, recogida mañana
  const pickupDefault = addDays(today, 1);
  const dropoffDefault = addDays(today, 4);

  const pickupEl = document.getElementById("q-pickup");
  const dropoffEl = document.getElementById("q-dropoff");
  const stationEl = document.getElementById("q-station");
  const providerEl = document.getElementById("q-provider");
  const btn = document.getElementById("btn-get-prices");

  if (pickupEl) { pickupEl.value = iso(pickupDefault); pickupEl.min = iso(pickupDefault); }
  if (dropoffEl) { dropoffEl.value = iso(dropoffDefault); dropoffEl.min = iso(addDays(today, 2)); }
  if (btn) btn.addEventListener("click", obtenerPrecios);

  // Al cambiar fechas, oficina o proveedor, los precios mostrados quedan obsoletos
  [pickupEl, dropoffEl, stationEl, providerEl].forEach(el => {
    if (el) el.addEventListener("change", clearPrices);
  });
});

function clearPrices() {
  state.prices = {};
  document.querySelectorAll(".card-price-slot").forEach(slot => { slot.innerHTML = ""; });
}

// ============================================
// Modo Directa: tarifas internas (cálculo local)
// ============================================
state.mode = "directa";          // "directa" | "brokers"
state.rateCodes = [];            // [{code, desc, brand}]
state.ratesData = null;          // dataset completo (lazy)

document.addEventListener("DOMContentLoaded", () => {
  setupModeTabs();
  loadRateCodes();
});

function setupModeTabs() {
  const tabDir = document.getElementById("mode-directa");
  const tabBrk = document.getElementById("mode-brokers");
  if (!tabDir || !tabBrk) return;
  const apply = mode => {
    state.mode = mode;
    tabDir.classList.toggle("mode-tab-active", mode === "directa");
    tabBrk.classList.toggle("mode-tab-active", mode === "brokers");
    tabDir.setAttribute("aria-selected", mode === "directa");
    tabBrk.setAttribute("aria-selected", mode === "brokers");
    document.querySelectorAll("[data-mode]").forEach(el => {
      el.hidden = el.getAttribute("data-mode") !== mode;
    });
    clearPrices();
  };
  tabDir.addEventListener("click", () => apply("directa"));
  tabBrk.addEventListener("click", () => apply("brokers"));
  apply("directa");
}

async function loadRateCodes() {
  const input = document.getElementById("q-ratecode");
  const brandEl = document.getElementById("q-brand");
  const descEl = document.getElementById("ratecode-desc");
  if (!input) return;
  try {
    const res = await fetch("data/rate-codes.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.rateCodes = (await res.json()).codes || [];
  } catch (err) {
    console.error("Error cargando rate-codes.json:", err);
    showToast("No se pudo cargar el catálogo de tarifas");
    return;
  }
  const fillDatalist = () => {
    const brand = brandEl ? brandEl.value : "";
    const list = document.getElementById("ratecode-list");
    list.innerHTML = state.rateCodes
      .filter(c => !brand || c.brand === brand)
      .map(c => `<option value="${escapeHtml(c.code)}">${escapeHtml(c.desc)}</option>`)
      .join("");
  };
  fillDatalist();

  // Tarifa por defecto: se APLICA si el campo se deja vacío, pero NO se prerrellena,
  // porque el datalist nativo filtraría el desplegable a esa única coincidencia.
  state.defaultRate = "ADTLPA";
  const def = state.rateCodes.find(c => c.code === state.defaultRate);
  const showNote = () => {
    if (!descEl) return;
    const v = input.value.trim().toUpperCase();
    if (!v) {
      descEl.textContent = def ? `Por defecto: ${def.code} · ${def.desc}` : "";
    } else {
      const match = state.rateCodes.find(c => c.code.toUpperCase() === v);
      descEl.textContent = match ? `${match.desc} · ${match.brand}` : "";
    }
  };
  showNote();

  if (brandEl) brandEl.addEventListener("change", () => {
    const brand = brandEl.value;
    const v = input.value.trim().toUpperCase();
    // Si la tarifa escrita no pertenece a la marca elegida, se borra (no es válida para esa marca)
    if (brand && v) {
      const cur = state.rateCodes.find(c => c.code.toUpperCase() === v);
      if (cur && cur.brand !== brand) input.value = "";
    }
    fillDatalist();
    showNote();
    clearPrices();
  });
  input.addEventListener("input", () => { showNote(); clearPrices(); });
}

async function ensureRatesData() {
  if (state.ratesData) return state.ratesData;
  const res = await fetch("data/rates.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  state.ratesData = await res.json();
  return state.ratesData;
}

// Elige la temporada (validez) cuyo rango de alquiler contiene la recogida
// y cuya ventana de reserva contiene la fecha de reserva (hoy).
function pickSeason(seasons, pickupDate, reservationDate) {
  if (!seasons || !seasons.length) return null;
  const pu = new Date(pickupDate + "T12:00:00");
  const rv = new Date(reservationDate);
  const inRange = (d, a, b) => d >= new Date(a) && d <= new Date(b);
  const candidates = seasons.filter(s =>
    inRange(pu, s.sd, s.ed) && inRange(rv, s.rf, s.rt)
  );
  if (candidates.length) {
    // la de rango de alquiler más estrecho (más específica)
    candidates.sort((a, b) =>
      (new Date(a.ed) - new Date(a.sd)) - (new Date(b.ed) - new Date(b.sd))
    );
    return candidates[0];
  }
  // fallback: solo por fecha de recogida (ignora ventana de reserva)
  const byPickup = seasons.filter(s => inRange(pu, s.sd, s.ed));
  return byPickup.length ? byPickup[0] : null;
}

function computeLocalPrice(rate, grupo, pickupDate, dropoffDate) {
  const days = Math.round((new Date(dropoffDate) - new Date(pickupDate)) / 86400000) || 1;
  const season = pickSeason(rate.seasons, pickupDate, new Date());
  if (!season) return { error: "Sin validez para esa fecha de recogida" };
  const groups = rate.matrix[season.id];
  if (!groups) return { error: "Sin matriz para esa validez" };
  const g = groups.find(x => x.g === grupo);
  if (!g) return { error: `Grupo ${grupo} no tarifado` };
  const band = g.b.find(b => b[0] <= days && days <= b[1]);
  if (!band) return { error: `Sin tramo para ${days} días` };
  const dailyValue = band[2];
  const additional = band[3] || 0;
  const totalValue = +(dailyValue * days + additional).toFixed(2);
  return { dailyValue, totalValue, days, rateCode: state._rateCodeUsed };
}

async function obtenerPreciosDirecta() {
  const pickupDate = document.getElementById("q-pickup").value;
  const dropoffDate = document.getElementById("q-dropoff").value;
  let code = (document.getElementById("q-ratecode").value || "").trim().toUpperCase();
  if (!code) code = state.defaultRate || "";

  if (!pickupDate || !dropoffDate) { showToast("Indica fecha de recogida y devolución"); return; }
  if (new Date(dropoffDate) <= new Date(pickupDate)) {
    showToast("La devolución debe ser posterior a la recogida"); return;
  }
  if (!code) { showToast("Escribe o elige un código de tarifa"); return; }

  const btn = document.getElementById("btn-get-prices");
  const label = btn.textContent;
  btn.disabled = true; btn.classList.add("btn-disabled"); btn.textContent = "Calculando…";

  try {
    const data = await ensureRatesData();
    const rate = data.rates[code];
    if (!rate) { showToast(`El código "${code}" no existe`); return; }
    state._rateCodeUsed = code;

    let targets = getSelectedVehicles();
    if (targets.length === 0) targets = [...state.vehiculos];

    targets.forEach(v => {
      state.prices[v.id] = computeLocalPrice(rate, v.grupo, pickupDate, dropoffDate);
      updateCardPrice(v.id);
    });
    showToast(`Precios calculados · ${code} (${targets.length} ${targets.length === 1 ? "modelo" : "modelos"})`);
  } catch (err) {
    console.error("Error cálculo local:", err);
    showToast("No se pudieron calcular los precios");
  } finally {
    btn.disabled = false; btn.classList.remove("btn-disabled"); btn.textContent = label;
  }
}

function priceBlockHtml(id) {
  const p = state.prices[id];
  if (!p) return "";
  if (p.loading) return `<div class="card-price loading">Consultando precio…</div>`;
  if (p.error) return `<div class="card-price error">${escapeHtml(p.error)}</div>`;
  const fmt = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
  const rate = p.rateCode ? ` · ${escapeHtml(p.rateCode)}` : "";
  return `<div class="card-price">
      <span class="price-day">${fmt.format(p.dailyValue)}<small>/día</small></span>
      <span class="price-total">Total ${fmt.format(p.totalValue)} · ${p.days} ${p.days === 1 ? "día" : "días"}${rate}</span>
    </div>`;
}

function updateCardPrice(id) {
  const slot = document.querySelector(`.card-price-slot[data-price-id="${id}"]`);
  if (slot) slot.innerHTML = priceBlockHtml(id);
}

async function obtenerPrecios() {
  if (state.mode === "directa") return obtenerPreciosDirecta();

  const pickupDate = document.getElementById("q-pickup").value;
  const dropoffDate = document.getElementById("q-dropoff").value;
  const station = document.getElementById("q-station").value || "LPA";
  const provider = document.getElementById("q-provider")?.value || "booking";

  if (!pickupDate || !dropoffDate) { showToast("Indica fecha de recogida y devolución"); return; }
  if (new Date(dropoffDate) <= new Date(pickupDate)) {
    showToast("La devolución debe ser posterior a la recogida");
    return;
  }

  // Modelos a cotizar: los seleccionados, o toda la flota si no hay selección
  let targets = getSelectedVehicles();
  if (targets.length === 0) targets = [...state.vehiculos];

  targets.forEach(v => { state.prices[v.id] = { loading: true }; updateCardPrice(v.id); });

  const btn = document.getElementById("btn-get-prices");
  const label = btn.textContent;
  btn.disabled = true;
  btn.classList.add("btn-disabled");
  btn.textContent = "Consultando…";

  await runPool(targets, PRICE_CONCURRENCY, async v => {
    state.prices[v.id] = await fetchVehiclePrice(v, { pickupDate, dropoffDate, station, provider });
    updateCardPrice(v.id);
  });

  btn.disabled = false;
  btn.classList.remove("btn-disabled");
  btn.textContent = label;
  showToast(`Precios actualizados (${targets.length} ${targets.length === 1 ? "modelo" : "modelos"})`);
}

async function runPool(items, size, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

async function fetchVehiclePrice(v, { pickupDate, dropoffDate, station, provider }) {
  // El Worker añade las credenciales del proveedor y construye el SOAP server-side.
  try {
    const response = await fetch(PRICE_WS_URL, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, groupID: v.grupo, pickupDate, dropoffDate, station })
    });

    // El Worker responde JSON en caso de error de configuración/proveedor
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      return { error: RENTWAY_ERRORS[data.error] || data.error || "Error del proveedor" };
    }

    const xmlDoc = new DOMParser().parseFromString(await response.text(), "text/xml");

    const errorCode = xmlDoc.querySelector("errorCode")?.textContent?.trim();
    if (errorCode && errorCode !== "0") {
      return { error: RENTWAY_ERRORS[errorCode] || `Error: ${errorCode}` };
    }

    const totalValue = parseFloat(xmlDoc.querySelector("previewValue")?.textContent || "0") || 0;
    if (!totalValue) return { error: "Sin tarifa disponible" };

    const daysText = xmlDoc.querySelector("nrDays")?.textContent;
    const calcDays = Math.round((new Date(dropoffDate) - new Date(pickupDate)) / 86400000) || 1;
    const days = daysText ? parseInt(daysText, 10) : calcDays;
    const dailyValue = parseFloat(xmlDoc.querySelector("totalDayValueWithTax")?.textContent || "0") || (totalValue / days);
    const actualRate = xmlDoc.querySelector("rateCode")?.textContent?.trim() || "";

    return { dailyValue, totalValue, days, rateCode: actualRate };
  } catch (err) {
    console.error("Error cotizando", v.id, err);
    return { error: "Error de conexión" };
  }
}