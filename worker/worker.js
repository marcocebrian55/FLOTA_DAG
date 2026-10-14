// =====================================================================
//  Worker Cloudflare — Proxy de precios FLOTA_DAG (Jimpisoft SOAP)
//
//  Las credenciales NO están en el código: se leen de Variables and
//  Secrets del Worker (Settings → Variables and Secrets):
//    RW_COMPANY   companyCode           (texto)   p.ej. 200037
//    RW_CUSTOMER  customerCode          (texto)   p.ej. 1
//    RW_USER      username              (texto)
//    RW_PASS      password              (SECRET)
//    RW_RATE      tarifa (opcional)     (texto)   vacío = la que devuelva Jimpisoft
//                 admite {station}, p.ej. "ADT{station}" → ADTLPA
//
//  Entrada: POST JSON {provider, groupID, pickupDate, dropoffDate, station}
//  Salida:  XML de Jimpisoft tal cual, o JSON {error} si algo falla aquí.
// =====================================================================

const SOAP_URL = "https://ws-soap-api.jimpisoft.com/getMultiplePrices.asmx";
const SOAP_ACTION = "http://www.jimpisoft.pt/Rentway_Reservations_WS/getMultiplePrices/MultiplePrices";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Proveedores aceptados desde el panel. Todos usan las credenciales RW_*;
// "booking" se mantiene para no romper versiones antiguas del panel.
const PROVIDERS = ["directo", "booking"];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const isCode = s => /^[A-Za-z0-9]{1,10}$/.test(s || "");

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return json({ error: "Método no permitido" }, 405);

    const { RW_COMPANY, RW_CUSTOMER, RW_USER, RW_PASS, RW_RATE = "" } = env;
    if (!RW_COMPANY || !RW_CUSTOMER || !RW_USER || !RW_PASS) {
      return json({ error: "Worker sin credenciales configuradas" }, 500);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: "Petición no válida" }, 400); }

    const { provider = "directo", groupID, pickupDate, dropoffDate, station } = body;
    if (!PROVIDERS.includes(provider)) return json({ error: `Proveedor no disponible: ${provider}` }, 400);
    if (!isCode(groupID) || !isCode(station) || !isDate(pickupDate) || !isDate(dropoffDate)) {
      return json({ error: "Parámetros no válidos" }, 400);
    }

    const rateCode = RW_RATE.replace("{station}", station);

    const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tns="http://www.jimpisoft.pt/Rentway_Reservations_WS/getMultiplePrices">
  <soap:Header/>
  <soap:Body>
    <tns:MultiplePrices>
      <tns:objRequest>
        <tns:companyCode>${RW_COMPANY}</tns:companyCode>
        <tns:customerCode>${RW_CUSTOMER}</tns:customerCode>
        <tns:username>${RW_USER}</tns:username>
        <tns:password>${RW_PASS}</tns:password>
        <tns:groupID>${groupID}</tns:groupID>
        ${rateCode ? `<tns:rateCode>${rateCode}</tns:rateCode>` : ""}
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
      const res = await fetch(SOAP_URL, {
        method: "POST",
        headers: { "Content-Type": `application/soap+xml; charset=utf-8; action="${SOAP_ACTION}"` },
        body: soap,
      });
      return new Response(await res.text(), {
        status: res.status,
        headers: { ...CORS, "Content-Type": "text/xml; charset=utf-8" },
      });
    } catch (err) {
      return json({ error: "No se pudo contactar con Jimpisoft" }, 502);
    }
  },
};
