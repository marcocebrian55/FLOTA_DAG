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
}// ============================================
// Cotizador de Tarifas (SOAP Jimpisoft)
// ============================================

// Vincular eventos (puedes meter esto dentro de tu función bindEvents() actual)
document.addEventListener("DOMContentLoaded", () => {
  const btnCalc = document.getElementById("btn-calc-price");
  if (btnCalc) btnCalc.addEventListener("click", openPriceModal);

  document.querySelectorAll("[data-close-price]").forEach(el => {
    el.addEventListener("click", () => document.getElementById("price-modal").classList.add("hidden"));
  });

  const btnExec = document.getElementById("btn-execute-calc");
  if (btnExec) btnExec.addEventListener("click", executePriceCalculation);
});

// Sobrescribir updateSelectionUI para que también controle el botón de calcular
const originalUpdateSelectionUI = typeof updateSelectionUI === 'function' ? updateSelectionUI : null;
window.updateSelectionUI = function () {
  if (originalUpdateSelectionUI) originalUpdateSelectionUI();

  const btnCalc = document.getElementById("btn-calc-price");
  if (btnCalc) {
    btnCalc.disabled = state.selected.size === 0;
    btnCalc.classList.toggle("btn-disabled", state.selected.size === 0);
  }
};

function openPriceModal() {
  if (state.selected.size === 0) {
    showToast("Selecciona al menos un modelo para calcular");
    return;
  }

  document.getElementById("price-target-info").textContent =
    `Consultando tarifas para ${state.selected.size} modelo(s) seleccionado(s).`;

  // Poner fechas: Hoy y Mañana por defecto
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  document.getElementById("calc-pickup-date").value = today.toISOString().split('T')[0];
  document.getElementById("calc-dropoff-date").value = tomorrow.toISOString().split('T')[0];

  document.getElementById("price-results").style.display = "none";
  document.getElementById("price-modal").classList.remove("hidden");
}

async function executePriceCalculation() {
  const rateCode = document.getElementById("calc-rate").value.trim();
  const pickupDate = document.getElementById("calc-pickup-date").value;
  const dropoffDate = document.getElementById("calc-dropoff-date").value;
  const station = document.getElementById("calc-station").value || "LPA";

  const resultsDiv = document.getElementById("price-results");
  const statusMessage = document.getElementById("price-status-message");

  // Resetear estados visuales
  resultsDiv.style.display = "none";
  statusMessage.style.display = "block";
  statusMessage.style.background = "#27272a";
  statusMessage.style.color = "#e4e4e7";
  statusMessage.textContent = "Conectando con la API de Rentway... Por favor, espera.";

  if (state.selected.size === 0) {
    statusMessage.style.background = "#7f1d1d";
    statusMessage.textContent = "Error: No hay modelos seleccionados.";
    return;
  }

  // Conseguir datos del coche seleccionado para la interfaz
  const seleccionados = state.vehiculos.filter(v => state.selected.has(v.id));
  const coche = seleccionados[0];
  const grupoID = coche.grupo;

  const soapRequest = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tns="http://www.jimpisoft.pt/Rentway_Reservations_WS/getMultiplePrices">
  <soap:Header/>
  <soap:Body>
    <tns:MultiplePrices>
      <tns:objRequest>
        <tns:companyCode>200037</tns:companyCode>
        <tns:customerCode>18</tns:customerCode>
        <tns:username>Booking</tns:username>
        <tns:password>0NPwqRKSNf47S6f</tns:password>
        <tns:groupID>${grupoID}</tns:groupID>
        ${rateCode ? `<tns:rateCode>${rateCode}</tns:rateCode>` : ''}
        <tns:pickUp>
          <tns:Date>${pickupDate}T10:00:00</tns:Date>
          <tns:rentalStation>${station}</tns:rentalStation>
        </tns:pickUp>
        <tns:dropOff>
          <tns:Date>${dropoffDate}T10:00:00</tns:Date>
          <tns:rentalStation>${station}</tns:rentalStation>
        </tns:dropOff>
      </tns:objRequest>
    </tns:MultiplePrices>
  </soap:Body>
</soap:Envelope>`;

  try {
    const wsUrl = "https://small-moon-0352.mcebrian-334.workers.dev";
    const response = await fetch(wsUrl, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body: soapRequest
    });
    const responseText = await response.text();
    console.log("RESPUESTA JIMPISOFT:", responseText);

    // Parsear el XML recibido
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(responseText, "text/xml");

    // Verificar si el propio servidor de Jimpisoft devolvió un error de negocio
    const errorCode = xmlDoc.querySelector("errorCode")?.textContent?.trim();
    if (errorCode && errorCode !== "0" && errorCode !== "") {
      const mensajes = {
        "ERROR: PICKUP STATION DOES NOT EXIST!": "La estación de recogida no existe. Verifica el ID de oficina.",
        "ERROR: USER OR PASSWORD INCORRECT": "Credenciales incorrectas.",
        "ERROR: PICKUP DATE CANNOT BE LOWER THAN TODAY": "La fecha de recogida no puede ser anterior a hoy.",
        "ERROR: RATE CODE DOES NOT EXIST!": "El código de tarifa no existe.",
        "ERROR: NO RATE IS AVAILABLE FOR YOUR SELECTION. ": "No hay tarifa disponible para esta selección. Deja el campo vacío para obtener la mejor tarifa.",
        "ERROR: NO RATE IS AVAILABLE FOR YOUR SELECTION.": "No hay tarifa disponible para esta selección. Deja el campo vacío para obtener la mejor tarifa.",
      };
      const msg = mensajes[errorCode] || `Error Rentway: ${errorCode}`;
      statusMessage.style.display = "block";
      statusMessage.style.background = "#7f1d1d";
      statusMessage.style.color = "#fca5a5";
      statusMessage.textContent = msg;
      return;
    }

    // Extraer campos reales del diffgram de Rentway
    const totalValueText    = xmlDoc.querySelector("previewValue")?.textContent || "0";
    const dailyValueText    = xmlDoc.querySelector("totalDayValueWithTax")?.textContent || "0";
    const daysText          = xmlDoc.querySelector("nrDays")?.textContent;
    const actualRateCode    = xmlDoc.querySelector("rateCode")?.textContent || rateCode;

    const d1 = new Date(pickupDate);
    const d2 = new Date(dropoffDate);
    const calculatedDays = Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) || 1;
    const finalDays = daysText ? parseInt(daysText) : calculatedDays;

    const totalValue = parseFloat(totalValueText) || 0;
    const dailyValue = parseFloat(dailyValueText) || (totalValue / finalDays);

    const currencyFormatter = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });

    // Pintar resultados
    document.getElementById("res-model-name").textContent = coche.nombre_completo || `${coche.marca} ${coche.modelo}`;
    document.getElementById("res-dates").textContent = `Del ${formatDateSpan(pickupDate)} al ${formatDateSpan(dropoffDate)}`;
    document.getElementById("res-rate-badge").textContent = `Tarifa: ${actualRateCode}`;
    document.getElementById("res-total-days").textContent = `${finalDays} ${finalDays === 1 ? 'día' : 'días'}`;
    document.getElementById("res-price-day").textContent = `${currencyFormatter.format(dailyValue)} / día`;
    document.getElementById("res-price-total").textContent = currencyFormatter.format(totalValue);

    // Ocultar mensaje de carga y mostrar tarjeta visual
    statusMessage.style.display = "none";
    resultsDiv.style.display = "block";

  } catch (err) {
    console.error("Fallo en la petición:", err);
    statusMessage.style.background = "#7f1d1d";
    statusMessage.style.color = "#fca5a5";
    statusMessage.textContent = "Error de conexión con el Proxy: " + err.message;
  }
}
function formatDateSpan(dateStr) {
  if (!dateStr) return "—";
  const parts = dateStr.split("-");
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}