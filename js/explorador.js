/* ============================================
   Explorador de precios — competencia vs Avis
   --------------------------------------------
   - Login-gated igual que el panel (auth.js llama a window.initFlotaApp).
   - Carga datos de la competencia (scraper) y las tarifas internas (rates.json
     del bucket privado), empareja por grupo y muestra la diferencia de precio.
   ============================================ */

const X = {
  competitor: "cicar", // competidor activo (clave de COMPETITORS)
  comp: null,        // JSON de la competencia (<competitor>-prices.json)
  rates: null,       // rates.json del bucket
  rateCodeUsed: null,
  mapping: {},       // { grupoCompetencia: grupoAvis }
};

// Competidores disponibles. file = nombre del JSON en el bucket / scraper.
const COMPETITORS = {
  cicar: { label: "CICAR", file: "cicar-prices.json" },
  cabreramedina: { label: "Cabrera Medina", file: "cabreramedina-prices.json" },
  goldcar: { label: "Goldcar", file: "goldcar-prices.json" },
};

// Clave de localStorage para el emparejamiento del competidor activo (uno por competidor).
function mappingKey() {
  return `flota-cmp-mapping-${X.competitor}-v2`;
}

// Emparejamiento por defecto de cada competidor → grupo Avis, por tamaño/segmento y transmisión.
// CICAR/Cabrera comparten esquema de grupos A–L (mismo motor de reservas). Goldcar usa otro
// (AA/A3/BB/CC/R/R2/D/D2/L/DD) y SÍ expone SIPP, pero el mapeo por defecto sigue siendo por
// segmento. Todo editable por el usuario y persistido en localStorage (uno por competidor).
const MAPPING_AL = {
  A: "SA",  // Fiat 500 (mini, manual)      → Hyundai i10 (MDMR)
  B: "SC",  // Opel Corsa (economy, manual) → VW Polo (EDMR)
  C: "SG",  // compacto manual (Ibiza/208)  → VW Taigo manual (CDMR)
  D: "SK",  // compacto AUTOMÁTICO          → VW Taigo Auto (CGAR)
  E: "SJ",  // SUV-B manual (Arona/Mokka)   → VW T-Cross manual (CGMR)
  F: "MJ",  // SUV/compacto automático      → Audi Q3 (DFAR)
  G: "EG",  // SUV medio (T-Roc/Renegade)   → VW T-Roc (CFMR)
  H: "MN",  // SUV-C (Tiguan/3008/Ateca)    → VW Tiguan (IFMR)
  I: "MD",  // 7 plazas / SUV grande        → Skoda Kodiaq 5+2 (FVAR)
  J: "LJ",  // premium (XC40/Formentor/508) → Audi Q5 (PFAR)
  K: "LP",  // lujo/grande (XC60/Stelvio)   → Audi Q8 (LFAR)
  L: "LP",  // top lujo (Wrangler/XC90/BMW) → Audi Q8 (LFAR)
};
const DEFAULT_MAPPINGS = {
  cicar: MAPPING_AL,
  cabreramedina: MAPPING_AL,
  goldcar: {
    AA: "SA",  // Kia Picanto (mini, manual)       → Hyundai i10
    A3: "SA",  // Hyundai i10 (mini, automático)   → Hyundai i10
    BB: "SA",  // Fiat 500 (mini, manual)          → Hyundai i10
    CC: "SC",  // Opel Corsa/Fiesta (economy)      → VW Polo
    R:  "SG",  // Taigo/2008/MG ZS (SUV-B manual)  → VW Taigo manual
    R2: "SK",  // Kamiq/Arona (SUV-B automático)   → VW Taigo Auto
    D:  "SG",  // Focus/Astra (compacto manual)    → VW Taigo manual
    D2: "SJ",  // KGM Tivoli (SUV familiar)        → VW T-Cross
    L:  "EG",  // Ateca/MG HS/T-Roc (SUV-C)        → VW T-Roc
    DD: "MJ",  // Arkana/Kuga/DS4 (SUV automático) → Audi Q3
  },
};
// Mapeo por defecto del competidor activo.
function defaultMapping() {
  return DEFAULT_MAPPINGS[X.competitor] || {};
}

/* ---- utilidades ---- */
function toISO(ddmmyyyy) {
  // "17/06/2026" -> "2026-06-17"
  const [d, m, y] = ddmmyyyy.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add("hidden"), 2800);
}

/* ---- carga de datos ---- */
async function loadCompetitorData() {
  // Producción: bucket privado. Desarrollo local: fichero del scraper.
  const file = COMPETITORS[X.competitor].file;
  try {
    return await window.downloadJSONFromBucket(file);
  } catch (_) {
    const res = await fetch(`scraper/${file}`, { cache: "no-store" });
    if (!res.ok) throw new Error("No se encontraron datos de la competencia");
    return res.json();
  }
}

async function ensureRates() {
  if (X.rates) return X.rates;
  X.rates = await window.downloadJSONFromBucket("rates.json");
  return X.rates;
}

/* ---- lógica de tarifa interna (portada de app.js) ---- */
function pickSeason(seasons, pickupDate, reservationDate) {
  if (!seasons || !seasons.length) return null;
  const pu = new Date(pickupDate + "T12:00:00");
  const rv = new Date(reservationDate);
  const inRange = (d, a, b) => d >= new Date(a) && d <= new Date(b);
  const candidates = seasons.filter(s => inRange(pu, s.sd, s.ed) && inRange(rv, s.rf, s.rt));
  if (candidates.length) {
    candidates.sort((a, b) => (new Date(a.ed) - new Date(a.sd)) - (new Date(b.ed) - new Date(b.sd)));
    return candidates[0];
  }
  const byPickup = seasons.filter(s => inRange(pu, s.sd, s.ed));
  return byPickup.length ? byPickup[0] : null;
}

function computeLocalPrice(rate, grupo, pickupDate, dropoffDate) {
  const days = Math.round((new Date(dropoffDate) - new Date(pickupDate)) / 86400000) || 1;
  const season = pickSeason(rate.seasons, pickupDate, new Date());
  if (!season) return { error: "Sin validez para esa fecha" };
  const groups = rate.matrix[season.id];
  if (!groups) return { error: "Sin matriz para esa validez" };
  const g = groups.find(x => x.g === grupo);
  if (!g) return { error: `Grupo ${grupo} no tarifado` };
  const band = g.b.find(b => b[0] <= days && days <= b[1]);
  if (!band) return { error: `Sin tramo para ${days} días` };
  const dailyValue = band[2];
  const additional = band[3] || 0;
  const totalValue = +(dailyValue * days + additional).toFixed(2);
  return { dailyValue, totalValue, days };
}

/* ---- emparejamiento de grupos ---- */
function loadMapping() {
  try { X.mapping = JSON.parse(localStorage.getItem(mappingKey())) || {}; }
  catch (_) { X.mapping = {}; }
}
function saveMapping() {
  localStorage.setItem(mappingKey(), JSON.stringify(X.mapping));
}

function competitorGroups() {
  const q = X.comp?.queries?.[0];
  if (!q) return [];
  return [...new Set(q.vehicles.map(v => v.group).filter(Boolean))].sort();
}

function avisGroupsForRate() {
  const rate = X.rates?.rates?.[X.rateCodeUsed];
  if (!rate) return [];
  const all = new Set();
  for (const sid of Object.keys(rate.matrix || {})) {
    for (const g of rate.matrix[sid]) all.add(g.g);
  }
  return [...all].sort();
}

function renderMapping() {
  const grid = document.getElementById("x-mapping-grid");
  const avisGroups = avisGroupsForRate();
  grid.innerHTML = "";
  for (const cg of competitorGroups()) {
    if (!(cg in X.mapping)) {
      const def = defaultMapping()[cg];
      X.mapping[cg] = avisGroups.includes(def) ? def : "";
    }
    const row = document.createElement("div");
    row.className = "mapping-row";
    const opts = ['<option value="">— sin emparejar —</option>']
      .concat(avisGroups.map(g => `<option value="${g}"${X.mapping[cg] === g ? " selected" : ""}>${g}</option>`))
      .join("");
    row.innerHTML = `<span class="mapping-from">${cg}</span><span class="mapping-arrow">→</span>
      <select class="select mapping-select" data-cg="${cg}">${opts}</select>`;
    grid.appendChild(row);
  }
  grid.querySelectorAll(".mapping-select").forEach(sel => {
    sel.addEventListener("change", () => {
      X.mapping[sel.dataset.cg] = sel.value;
      saveMapping();
      render();
    });
  });
}

/* ---- render de la tabla comparativa ---- */
function render() {
  const q = X.comp?.queries?.[0];
  const body = document.getElementById("x-table-body");
  const empty = document.getElementById("x-empty");
  if (!q || !q.vehicles.length) {
    body.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const pickupISO = document.getElementById("x-pickup").value;
  const dropoffISO = document.getElementById("x-dropoff").value;
  const rate = X.rates?.rates?.[X.rateCodeUsed];
  const search = (document.getElementById("x-filter-search").value || "").toLowerCase();

  let cheaper = 0, pricier = 0;
  const rows = [];

  for (const v of q.vehicles) {
    if (search && !(`${v.name} ${v.group}`.toLowerCase().includes(search))) continue;

    // Goldcar expone GRUPOS (varios modelos equivalentes por fila), no modelos sueltos como CICAR/Cabrera.
    const groupTag = X.competitor === "goldcar"
      ? ' <span class="model-tag" title="Goldcar agrupa varios modelos equivalentes bajo un mismo grupo; no es un modelo único">grupo</span>'
      : "";
    const avisGroup = X.mapping[v.group] || "";
    let avisTotal = null, avisDay = null, avisNote = "";
    if (rate && avisGroup) {
      const r = computeLocalPrice(rate, avisGroup, pickupISO, dropoffISO);
      if (r.error) { avisNote = r.error; }
      else if (!r.totalValue) { avisNote = "no tarifado"; } // valor 0 = grupo no vendido en esta tarifa
      else { avisTotal = r.totalValue; avisDay = +(r.totalValue / r.days).toFixed(2); }
    } else if (!avisGroup) {
      avisNote = "sin emparejar";
    }

    // Diferencia en lenguaje claro: la competencia ¿es más cara o más barata que Avis?
    //  - más cara que nosotros  = verde (somos competitivos)
    //  - más barata que nosotros = rojo (amenaza de precio)
    let deltaCell = '<span class="muted">—</span>';
    if (avisTotal != null && v.totalPrice) {
      const delta = ((v.totalPrice - avisTotal) / avisTotal) * 100;
      const pct = Math.abs(delta).toFixed(0);
      let cls, label;
      if (delta > 1) { cls = "pos"; label = `${pct}% más cara`; pricier++; }
      else if (delta < -1) { cls = "neg"; label = `${pct}% más barata`; cheaper++; }
      else { cls = "neu"; label = "precio similar"; }
      deltaCell = `<span class="delta delta-${cls}">${label}</span>`;
    }

    rows.push(`<tr>
      <td><span class="grp-badge">${v.group}</span></td>
      <td>${v.name || "—"}${groupTag}</td>
      <td class="num">${v.pax ?? "—"}</td>
      <td class="num">${v.totalPrice != null ? v.totalPrice.toFixed(2) + " €" : "—"}</td>
      <td class="num">${v.perDay != null ? v.perDay.toFixed(2) + " €" : "—"}</td>
      <td>${avisGroup ? `<span class="grp-badge grp-avis">${avisGroup}</span>` : '<span class="muted">—</span>'}</td>
      <td class="num">${avisTotal != null ? avisTotal.toFixed(2) + " €" : `<span class="muted">${avisNote}</span>`}</td>
      <td class="num">${avisDay != null ? avisDay.toFixed(2) + " €" : "—"}</td>
      <td class="num">${deltaCell}</td>
    </tr>`);
  }

  body.innerHTML = rows.join("");
  document.getElementById("x-kpi-total").textContent = q.vehicles.length;
  document.getElementById("x-kpi-cheaper").textContent = cheaper;
  document.getElementById("x-kpi-pricier").textContent = pricier;
}

/* ---- comparar (recalcula con la tarifa/fechas actuales) ---- */
async function compare() {
  const btn = document.getElementById("x-refresh");
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Comparando…";
  try {
    await ensureRates();
    X.rateCodeUsed = (document.getElementById("x-ratecode").value || "ALPA").trim().toUpperCase() || "ALPA";
    if (!X.rates.rates[X.rateCodeUsed]) {
      showToast(`La tarifa "${X.rateCodeUsed}" no existe`);
      return;
    }
    renderMapping();
    render();
    showToast(`Comparado con tarifa ${X.rateCodeUsed}`);
  } catch (e) {
    showToast(e.message || "Error al cargar tarifas");
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

/* ---- carga datos del competidor activo y compara ---- */
async function loadAndCompare() {
  try {
    X.comp = await loadCompetitorData();
  } catch (e) {
    X.comp = null;
    showToast(e.message);
    document.getElementById("x-empty").classList.remove("hidden");
    return;
  }

  const q = X.comp.queries?.[0];
  if (q) {
    document.getElementById("x-pickup").value = toISO(q.pickup.date);
    document.getElementById("x-dropoff").value = toISO(q.dropoff.date);
    document.getElementById("x-kpi-date").textContent =
      new Date(X.comp.generatedAt).toLocaleDateString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  await compare();
}

/* ---- arranque (lo invoca auth.js tras el login) ---- */
window.initFlotaApp = async function initExplorador() {
  document.getElementById("footer-year").textContent = new Date().getFullYear();
  loadMapping();

  document.getElementById("x-refresh").addEventListener("click", compare);
  document.getElementById("x-filter-search").addEventListener("input", render);
  document.getElementById("x-competitor").addEventListener("change", (e) => {
    X.competitor = e.target.value;
    loadMapping(); // cada competidor tiene su propio emparejamiento persistido
    loadAndCompare();
  });
  document.getElementById("x-toggle-mapping").addEventListener("click", () => {
    document.getElementById("x-mapping").toggleAttribute("hidden");
  });
  document.getElementById("x-mapping-reset").addEventListener("click", () => {
    X.mapping = {};
    saveMapping();
    renderMapping();
    render();
    showToast("Emparejamiento restablecido");
  });

  await loadAndCompare();
};
