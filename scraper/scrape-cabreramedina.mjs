// Scraper de precios públicos de Cabrera Medina (rate shopping interno para Rentway/Avis).
// Misma plataforma de reservas que CICAR (presupuestarForm -> booking1/booking2), pero el
// markup de las tarjetas es distinto: el modelo va en spans ...ModeloSeleccionado, no en una
// clase "thumbnailcoche". Cliente HTTP puro, sin navegador. Uso responsable: datos públicos,
// baja frecuencia, pausas entre consultas.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://www.cabreramedina.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PAUSE_MS = 2500; // cortesía entre consultas

// Oficinas de aeropuerto de Cabrera Medina equivalentes a las estaciones de Avis.
// Códigos extraídos del JSON de localizaciones embebido en /ES/action/booking1.
// G8 = "Aeropuerto Gran Canaria" (mismo código que CICAR), zona LPA, isla "Gran Canaria".
export const OFFICES = [
  { code: 'G8', zone: 'LPA', island: 'Gran Canaria', name: 'Gran Canaria Aeropuerto', avisStation: 'LPA' },
];

const EMPTY_FIELDS = ['reservaCodigo', 'reservaId', 'reservaModelo', 'reservaModeloNombre', 'reservaModeloGrupo', 'reservaModeloThumbnail', 'reservaModeloBaca', 'reservaModeloExtras', 'reservaModeloPrecioExtras', 'silla', 'elevador', 'baca', 'vuelo', 'dirTemp', 'notas', 'codDescuento', 'idOferta', 'promocion', 'saludo', 'nombre', 'apellidos', 'fecnacDia', 'fecnacMes', 'fecnacAno', 'dir', 'pais', 'idioma', 'documento', 'fecha_docDia', 'fecha_docMes', 'fecha_docAno', 'lugar_doc', 'pasaporte', 'telefono', 'movil', 'fax', 'email', 'passwordNuevo', 'notasConductor', 'idConductor'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newJar() {
  const jar = {};
  return {
    absorb: (res) => { for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } },
    header: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

function buildBody(office, pickup, dropoff) {
  const p = new URLSearchParams();
  p.append('reservaOficinaEnt', office.code);
  p.append('zona', office.zone);
  p.append('zonadev', office.zone);
  p.append('reservaIsla', office.island);
  p.append('reservaOficinaDev', office.code);
  p.append('fechaIni', pickup.date); p.append('horaIni', pickup.hour); p.append('minutoIni', '00');
  p.append('fechaFin', dropoff.date); p.append('horaFin', dropoff.hour); p.append('minutoFin', '00');
  for (const f of EMPTY_FIELDS) p.append(f, '');
  return p.toString();
}

// Cada vehículo es un <li class="... grupo_X ...">. Cortamos en cada <li que tenga clase grupo_.
function splitCards(html) {
  const cards = [];
  const re = /<li[^>]*class="[^"]*\bgrupo_\w+[^"]*"[^>]*>/g;
  const starts = [];
  let m;
  while ((m = re.exec(html)) !== null) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    cards.push(html.slice(starts[i], starts[i + 1] ?? html.length));
  }
  return cards;
}

function parseCard(chunk) {
  const classLine = (chunk.match(/<li[^>]*class="([^"]*grupo_[^"]*)"/) || [])[1] || '';
  const group = (classLine.match(/grupo_(\w+)/) || [])[1] || null;
  const categories = [...new Set([...classLine.matchAll(/categoria_(\w+)/g)].map((m) => m[1]))];
  const code = (chunk.match(/idModeloSeleccionado"[^>]*>([^<]+)</) || [])[1]?.trim() || null;
  let name = (chunk.match(/nombreModeloSeleccionado"[^>]*>([^<]+)</) || [])[1]
    || (chunk.match(/<h5[^>]*>([\s\S]*?)<\/h5>/) || [])[1] || '';
  name = name.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const img = (chunk.match(/thumbnails\/([\w.\-]+)/) || [])[1] || null;
  const priceRaw = (chunk.match(/precioSinFormato"[^>]*>([\d.,]+)/) || [])[1] || null;
  const totalPrice = priceRaw ? parseFloat(priceRaw.replace(/\./g, '').replace(',', '.')) : null;
  // pax: se cuenta por iconos images/pax.jpg dentro de la tarjeta (no hay clase pax_N)
  const pax = (chunk.match(/images\/pax\.jpg/g) || []).length || null;
  // transmisión: no aparece en la clase; algunas categorías la implican, pero la dejamos null.
  const transmission = null;
  return { group, categories, transmission, pax, code, name, img, totalPrice };
}

function daysBetween(d1, d2) {
  const [a, b, c] = d1.split('/').map(Number);
  const [d, e, f] = d2.split('/').map(Number);
  return Math.round((Date.UTC(f, e - 1, d) - Date.UTC(c, b - 1, a)) / 86400000);
}

export async function scrapeOffice(office, pickup, dropoff) {
  const jar = newJar();
  const r1 = await fetch(`${BASE}/ES/action/booking1`, { headers: { 'User-Agent': UA } });
  jar.absorb(r1);
  const body = buildBody(office, pickup, dropoff);
  const r2 = await fetch(`${BASE}/ES/action/booking2`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header(), Referer: `${BASE}/ES/action/booking1` },
    body,
  });
  const html = await r2.text();
  if (/Faltan algunos datos/.test(html)) throw new Error(`Sesión rechazada para oficina ${office.code} (faltan datos)`);
  const days = daysBetween(pickup.date, dropoff.date);
  const vehicles = splitCards(html)
    .map(parseCard)
    .filter((v) => v.group && v.totalPrice)
    .map((v) => ({ ...v, perDay: days ? Math.round((v.totalPrice / days) * 100) / 100 : null }));
  // dedup por código de modelo
  const seen = new Set();
  const unique = vehicles.filter((v) => (v.code && !seen.has(v.code) && seen.add(v.code)));
  return { office, pickup, dropoff, days, count: unique.length, vehicles: unique };
}

export async function scrapeAll({ offices = OFFICES, pickup, dropoff } = {}) {
  const results = [];
  for (const office of offices) {
    process.stderr.write(`[CABRERAMEDINA] ${office.name} ${pickup.date}→${dropoff.date} ... `);
    try {
      const r = await scrapeOffice(office, pickup, dropoff);
      process.stderr.write(`${r.count} vehículos\n`);
      results.push(r);
    } catch (e) {
      process.stderr.write(`ERROR ${e.message}\n`);
    }
    await sleep(PAUSE_MS);
  }
  return { generatedAt: new Date().toISOString(), competitor: 'Cabrera Medina', source: BASE, queries: results };
}

// Formatea una fecha como dd/mm/yyyy y desplaza N días desde hoy.
function fmtDate(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

// CLI: node scrape-cabreramedina.mjs [fechaIni] [fechaFin]
// Sin argumentos usa una ventana FUTURA (hoy+7 → hoy+14): la plataforma rechaza fechas pasadas.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pickup = { date: process.argv[2] || todayPlus(7), hour: '12' };
  const dropoff = { date: process.argv[3] || todayPlus(14), hour: '12' };
  const data = await scrapeAll({ pickup, dropoff });
  writeFileSync('cabreramedina-prices.json', JSON.stringify(data, null, 2));
  const total = data.queries.reduce((a, q) => a + q.count, 0);
  console.log(`\nGuardado cabreramedina-prices.json — ${data.queries.length} oficina(s), ${total} vehículos`);
  console.log('Muestra:', JSON.stringify(data.queries[0]?.vehicles.slice(0, 3), null, 2));
}
