/* ============================================
   Configuración del portal de agencias
   --------------------------------------------
   Todo lo que negocio puede querer cambiar sin tocar la lógica.
   Lo marcado PENDIENTE son valores provisionales a validar.
   ============================================ */

const PORTAL = {
  // Marcas: colores y nombre. Las oficinas son las mismas para las tres.
  marcas: {
    avis: { nombre: "AVIS", color: "#d4002a", colorOscuro: "#a80021", texto: "#ffffff" },
    budget: { nombre: "Budget", color: "#00285f", colorOscuro: "#001a40", texto: "#ffffff", acento: "#f68b1f" },
    xtravans: { nombre: "Xtravans", color: "#1f2937", colorOscuro: "#111827", texto: "#ffffff", acento: "#f59e0b" },
  },

  oficinas: [
    ["LPA", "Gran Canaria Aeropuerto"],
    ["TFS", "Tenerife Sur Aeropuerto"],
    ["TFN", "Tenerife Norte Aeropuerto"],
    ["FUE", "Fuerteventura Aeropuerto"],
    ["ACE", "Lanzarote Aeropuerto"],
    ["SPC", "La Palma Aeropuerto"],
    ["GMZ", "La Gomera Aeropuerto"],
    ["GOO", "La Gomera Muelle"],
    ["VDE", "El Hierro Aeropuerto"],
  ],

  // Países del conductor (código que se envía a Rentway → nombre)
  paises: [
    ["ES", "España"], ["GB", "Reino Unido"], ["DE", "Alemania"], ["FR", "Francia"], ["IT", "Italia"],
    ["NL", "Países Bajos"], ["BE", "Bélgica"], ["PT", "Portugal"], ["IE", "Irlanda"], ["CH", "Suiza"],
    ["AT", "Austria"], ["SE", "Suecia"], ["NO", "Noruega"], ["DK", "Dinamarca"], ["FI", "Finlandia"],
    ["PL", "Polonia"], ["US", "Estados Unidos"], ["OT", "Otro"],
  ],

  // PENDIENTE (política comercial): gastos de cancelación por tarifa.
  // Se elige la primera regla cuyo "tarifa" encaje (prefijo o "*").
  // Cada tramo: si faltan MENOS de "horas" para la recogida → se cobra "pct" % del importe.
  // De momento solo se MUESTRA el cálculo al cancelar; no se cobra nada.
  cancelacion: [
    { tarifa: "*", tramos: [{ horas: 24, pct: 100 }, { horas: 48, pct: 50 }] },
  ],

  // PENDIENTE (legal): enlaces de condiciones y privacidad, y si la aceptación es obligatoria.
  condicionesUrl: "",
  privacidadUrl: "",
  terminosObligatorios: true,

  // Antelación mínima para modificar o cancelar desde el portal (horas). PENDIENTE de negocio.
  horasMinimasCambio: 0,
};
