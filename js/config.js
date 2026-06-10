/* ============================================
   Configuración de Supabase (auth + datos)
   --------------------------------------------
   La anon key es PÚBLICA por diseño: solo permite lo que
   autoricen las policies. NO es un secreto.
   Rellena estos dos valores con los de tu proyecto:
   Project Settings → API → Project URL / anon public key.
   ============================================ */
window.FLOTA_CONFIG = {
  supabaseUrl: "https://yrsynnhkgiwgiqckalxn.supabase.co",
  supabaseAnonKey: "sb_publishable_ln4H9OOkM752HKMmH-EI3g_7t_njfP7",
  bucket: "flota-data"
};
