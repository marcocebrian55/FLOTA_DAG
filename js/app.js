/* ============================================
   FLOTA DAG — Lógica de la aplicación
   ============================================ */

// ============================================
// Estado global
// ============================================
const state = {
  agencia: null,
  vehiculos: [],
  filtered: [],
  filtros: {
    search: "",
    estado: "",
    combustible: ""
  }
};

// URL base pública de GitHub Pages (se calcula automáticamente)
const BASE_URL = (() => {
  // En producción (GitHub Pages): https://marcocebrian55.github.io/FLOTA_DAG/
  // En local (Live Server): http://127.0.0.1:5500/
  const { origin, pathname } = window.location;
  const path = pathname.endsWith("/") ? pathname : pathname.replace(/\/[^/]*$/, "/");
  return origin + path;
})();

// ============================================
// Inicialización
// ============================================
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("footer-year").textContent = new Date().getFullYear();
  bindEvents();
  await loadFleet();
});

// ============================================
// Carga de datos
// ============================================
async function loadFleet() {
  try {
    const res = await fetch("fleet.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    state.agencia = data.agencia || {};
    state.vehiculos = data.vehiculos || [];
    state.filtered = [...state.vehiculos];

    renderKPIs();
    renderGrid();
  } catch (err) {
    console.error("Error cargando fleet.json:", err);
    showToast("Error al cargar los datos de la flota", "error");
  }
}

// ============================================
// Renderizado
// ============================================
function renderKPIs() {
  const total = state.vehiculos.length;
  const disponibles = state.vehiculos.filter(v => v.estado === "disponible").length;
  const reservados = state.vehiculos.filter(v => v.estado === "reservado").length;
  const vendidos = state.vehiculos.filter(v => v.estado === "vendido").length;

  document.getElementById("kpi-total").textContent = total;
  document.getElementById("kpi-disponibles").textContent = disponibles;
  document.getElementById("kpi-reservados").textContent = reservados;
  document.getElementById("kpi-vendidos").textContent = vendidos;
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

  // Event listeners para botones "Copiar URL" de cada tarjeta
  grid.querySelectorAll(".card-url-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const url = btn.dataset.url;
      copyToClipboard(url);
      showToast("URL copiada al portapapeles");
    });
  });
}

function cardTemplate(v) {
  const imageUrl = v.imagen ? BASE_URL + v.imagen : null;
  const imageBlock = imageUrl
    ? `<div class="card-image" style="background-image:url('${escapeHtml(imageUrl)}')">
         <span class="card-badge badge-${v.estado}">${v.estado}</span>
       </div>`
    : `<div class="card-image">
         <div class="card-image-placeholder">Sin foto</div>
         <span class="card-badge badge-${v.estado}">${v.estado}</span>
       </div>`;

  const precio = v.precio != null
    ? new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v.precio)
    : "—";

  return `
    <article class="card">
      ${imageBlock}
      <div class="card-body">
        <div>
          <h3 class="card-title">${escapeHtml(v.marca)} ${escapeHtml(v.modelo)}</h3>
          <p class="card-version">${escapeHtml(v.version || "")}</p>
        </div>
        <div class="card-meta">
          <span class="tag">${v.anyo}</span>
          <span class="tag">${formatKm(v.km)} km</span>
          <span class="tag">${escapeHtml(v.combustible)}</span>
          <span class="tag">${escapeHtml(v.cambio)}</span>
        </div>
        <div class="card-footer">
          <span class="card-price">${precio}</span>
          <button class="card-url-btn" data-url="${escapeHtml(imageUrl || '')}" ${!imageUrl ? 'disabled' : ''}>
            Copiar URL foto
          </button>
        </div>
      </div>
    </article>
  `;
}

// ============================================
// Filtros
// ============================================
function applyFilters() {
  const { search, estado, combustible } = state.filtros;
  const q = search.toLowerCase().trim();

  state.filtered = state.vehiculos.filter(v => {
    if (estado && v.estado !== estado) return false;
    if (combustible && v.combustible !== combustible) return false;
    if (q) {
      const haystack = [
        v.marca, v.modelo, v.version, v.matricula, v.color, v.categoria
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  renderGrid();
}

// ============================================
// Generación de XML
// ============================================
function generateXML() {
  const ag = state.agencia || {};
  const fecha = new Date().toISOString();

  const escapeXml = s => String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  const vehiculosXml = state.vehiculos.map(v => {
    const imagenUrl = v.imagen ? BASE_URL + v.imagen : "";
    return `  <vehiculo>
    <id>${escapeXml(v.id)}</id>
    <matricula>${escapeXml(v.matricula)}</matricula>
    <marca>${escapeXml(v.marca)}</marca>
    <modelo>${escapeXml(v.modelo)}</modelo>
    <version>${escapeXml(v.version)}</version>
    <anyo>${escapeXml(v.anyo)}</anyo>
    <km>${escapeXml(v.km)}</km>
    <combustible>${escapeXml(v.combustible)}</combustible>
    <cambio>${escapeXml(v.cambio)}</cambio>
    <categoria>${escapeXml(v.categoria)}</categoria>
    <puertas>${escapeXml(v.puertas)}</puertas>
    <color>${escapeXml(v.color)}</color>
    <precio>${escapeXml(v.precio)}</precio>
    <estado>${escapeXml(v.estado)}</estado>
    <imagen>${escapeXml(imagenUrl)}</imagen>
    <descripcion>${escapeXml(v.descripcion)}</descripcion>
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
  <total_vehiculos>${state.vehiculos.length}</total_vehiculos>
${vehiculosXml}
</flota>`;
}

function openXmlModal() {
  const xml = generateXML();
  document.getElementById("xml-output").value = xml;
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
  a.download = `flota_dag_${fecha}.xml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("XML descargado");
}

// ============================================
// Copiar URLs de todas las imágenes
// ============================================
function copyAllUrls() {
  const urls = state.vehiculos
    .filter(v => v.imagen)
    .map(v => `${v.marca} ${v.modelo} (${v.matricula}): ${BASE_URL}${v.imagen}`)
    .join("\n");

  if (!urls) {
    showToast("No hay URLs de imágenes para copiar");
    return;
  }

  copyToClipboard(urls);
  showToast(`${state.vehiculos.filter(v => v.imagen).length} URLs copiadas`);
}

// ============================================
// Utilidades
// ============================================
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text);
  } else {
    // Fallback para entornos no-HTTPS o navegadores antiguos
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
  // Force reflow para que la transición funcione
  void toast.offsetWidth;
  toast.classList.add("visible");

  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.classList.add("hidden"), 250);
  }, 2200);
}

function formatKm(n) {
  if (n == null) return "—";
  return new Intl.NumberFormat("es-ES").format(n);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================
// Event listeners
// ============================================
function bindEvents() {
  // Filtros
  document.getElementById("filter-search").addEventListener("input", e => {
    state.filtros.search = e.target.value;
    applyFilters();
  });
  document.getElementById("filter-estado").addEventListener("change", e => {
    state.filtros.estado = e.target.value;
    applyFilters();
  });
  document.getElementById("filter-combustible").addEventListener("change", e => {
    state.filtros.combustible = e.target.value;
    applyFilters();
  });

  // Botones header
  document.getElementById("btn-xml").addEventListener("click", openXmlModal);
  document.getElementById("btn-copy-urls").addEventListener("click", copyAllUrls);

  // Modal
  document.querySelectorAll("[data-close]").forEach(el => {
    el.addEventListener("click", closeXmlModal);
  });
  document.getElementById("btn-copy-xml").addEventListener("click", () => {
    const xml = document.getElementById("xml-output").value;
    copyToClipboard(xml);
    showToast("XML copiado al portapapeles");
  });
  document.getElementById("btn-download-xml").addEventListener("click", downloadXml);

  // Cerrar modal con Escape
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeXmlModal();
  });
}