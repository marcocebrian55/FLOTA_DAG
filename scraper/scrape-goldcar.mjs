// Scraper de precios públicos de Goldcar (rate shopping interno para Rentway/Avis).
// Goldcar es una SPA (Vue/Nuxt) pero expone una API JSON propia SIN token de auth.
// Flujo HTTP puro (sin navegador), igual de barato que CICAR/Cabrera:
//   1) GET /es-es/reservas/disponibilidad/      -> cookies (Akamai, no bloquea)
//   2) GET /api/v1/oficina/q/<EST>/es            -> datos de oficina (zonaVenta, tipo, nombre)
//   3) POST /api/v1/sesion  (campos EXPLÍCITOS)  -> fija fechas/oficina en la sesión
//   4) GET /api/v1/disponibilidad                -> array de grupos con modelo, SIPP y tarifas
// Uso responsable: datos públicos, baja frecuencia, pausas entre consultas.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://www.goldcar.es';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAUSE_MS = 2500;

// Tarifa de Goldcar que usamos como precio COMPARABLE frente a Avis/CICAR/Cabrera.
// "PackKeyngo" es la que Goldcar muestra como precio principal al cliente (incluye coberturas),
// la más equiparable a la tarifa estándar de los demás. Si no está, se cae a la más barata.
const COMPARABLE_TARIFF = 'PackKeyngo';

// Oficinas de aeropuerto (estación Avis equivalente). LPA = Aeropuerto de Gran Canaria.
export const OFFICES = [
  { code: 'LPA', avisStation: 'LPA', name: 'Gran Canaria Aeropuerto' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newJar() {
  const jar = {};
  return {
    absorb: (res) => { for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } },
    header: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

const num = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// Elige el precio total del coche según la tarifa comparable (con fallback a la más barata).
function pickPrice(v) {
  const tarifas = v.tarifas || {};
  const pref = tarifas[COMPARABLE_TARIFF];
  if (pref) return { total: num(pref.precioTotf_eur ?? pref.precio_total), tariff: COMPARABLE_TARIFF };
  // fallback: la tarifa disponible más barata por total
  let best = null;
  for (const [k, t] of Object.entries(tarifas)) {
    const total = num(t.precioTotf_eur ?? t.precio_total);
    if (total != null && (!best || total < best.total)) best = { total, tariff: k };
  }
  if (best) return best;
  return { total: num(v.precio_totalf), tariff: v.tarifa || null };
}

function parseVehicle(v, days) {
  const d = v.detalle || {};
  const { total, tariff } = pickPrice(v);
  return {
    group: v.grupo || d.Codigo || null,
    name: d.Descripcion || null,
    categories: [(v.categoria && v.categoria.Nombre) || d.CodigoCategoria].filter(Boolean),
    sipp: d.CodAcriss || null,                 // Goldcar SÍ expone SIPP/ACRISS
    pax: d.Plazas ? parseInt(d.Plazas, 10) : null,
    doors: d.Puertas ? parseInt(d.Puertas, 10) : null,
    transmission: d.Automatico ? 'automatic' : 'manual',
    tariff,
    totalPrice: total,
    perDay: (total != null && days) ? Math.round((total / days) * 100) / 100 : null,
  };
}

const api = (jar) => ({ 'User-Agent': UA, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01', Cookie: jar.header(), Referer: `${BASE}/es-es/reservas/disponibilidad/` });

function daysBetween(d1, d2) {
  const [a, b, c] = d1.split('/').map(Number);
  const [d, e, f] = d2.split('/').map(Number);
  return Math.round((Date.UTC(f, e - 1, d) - Date.UTC(c, b - 1, a)) / 86400000);
}
const toISODate = (ddmmyyyy) => { const [d, m, y] = ddmmyyyy.split('/'); return `${y}-${m}-${d}`; };

export async function scrapeOffice(office, pickup, dropoff) {
  const jar = newJar();
  jar.absorb(await fetch(`${BASE}/es-es/reservas/disponibilidad/`, { headers: { 'User-Agent': UA } }));

  const ro = await fetch(`${BASE}/api/v1/oficina/q/${office.code}/es`, { headers: api(jar) });
  jar.absorb(ro);
  const o = await ro.json();

  const sesionBody = {
    timestamp: new Date().toISOString(), Lang: 'es', Agencia: false, referer: 'web',
    pickupplace: office.code, pickupdate: toISODate(pickup.date), pickuptime: pickup.hour, edadUsu: 0,
    pickupplace_name: o.Fullname, pickupType: o.Tipo,
    dropoffplace: office.code, dropoffdate: toISODate(dropoff.date), dropofftime: dropoff.hour,
    busCortesia: o.Buscortesia || 0, zonaVenta: o.Idzonaventa,
    proveedor: o.Provider || 'goldcar', dropoffplace_name: o.Fullname, dropoffType: o.Tipo,
  };
  const rs = await fetch(`${BASE}/api/v1/sesion`, { method: 'POST', headers: api(jar), body: JSON.stringify(sesionBody) });
  jar.absorb(rs);
  const sesion = await rs.json();
  if (sesion.pickupdate !== toISODate(pickup.date)) throw new Error(`La sesión no aceptó la fecha (esperaba ${toISODate(pickup.date)}, devolvió ${sesion.pickupdate})`);

  const rd = await fetch(`${BASE}/api/v1/disponibilidad`, { headers: api(jar) });
  const data = await rd.json();
  const arr = Array.isArray(data) ? data : Object.values(data);
  const days = daysBetween(pickup.date, dropoff.date);
  const vehicles = arr
    .filter((v) => v && v.disponible)
    .map((v) => parseVehicle(v, days))
    .filter((v) => v.group && v.totalPrice);
  return { office, pickup, dropoff, days, count: vehicles.length, vehicles };
}

export async function scrapeAll({ offices = OFFICES, pickup, dropoff } = {}) {
  const results = [];
  for (const office of offices) {
    process.stderr.write(`[GOLDCAR] ${office.name} ${pickup.date}→${dropoff.date} ... `);
    try {
      const r = await scrapeOffice(office, pickup, dropoff);
      process.stderr.write(`${r.count} vehículos\n`);
      results.push(r);
    } catch (e) {
      process.stderr.write(`ERROR ${e.message}\n`);
    }
    await sleep(PAUSE_MS);
  }
  return { generatedAt: new Date().toISOString(), competitor: 'Goldcar', source: BASE, comparableTariff: COMPARABLE_TARIFF, queries: results };
}

function fmtDate(d) { return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; }
function todayPlus(days) { const d = new Date(); d.setDate(d.getDate() + days); return fmtDate(d); }

// CLI: node scrape-goldcar.mjs [dd/mm/yyyy ini] [dd/mm/yyyy fin]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pickup = { date: process.argv[2] || todayPlus(7), hour: '12:00' };
  const dropoff = { date: process.argv[3] || todayPlus(14), hour: '12:00' };
  const data = await scrapeAll({ pickup, dropoff });
  writeFileSync('goldcar-prices.json', JSON.stringify(data, null, 2));
  const total = data.queries.reduce((a, q) => a + q.count, 0);
  console.log(`\nGuardado goldcar-prices.json — ${data.queries.length} oficina(s), ${total} vehículos (tarifa ${COMPARABLE_TARIFF})`);
  console.log('Muestra:', JSON.stringify(data.queries[0]?.vehicles.slice(0, 3), null, 2));
}
