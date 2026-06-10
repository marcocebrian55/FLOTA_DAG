/* ============================================
   Auth — Supabase (login real con JWT)
   --------------------------------------------
   - Sin sesión  -> se muestra la pantalla de login, el panel queda oculto.
   - Con sesión   -> se oculta el login y se inicializa el panel (initFlotaApp).
   El token se persiste en localStorage (supabase-js), así una recarga
   con sesión activa entra directa.
   ============================================ */

const FLOTA_BUCKET = (window.FLOTA_CONFIG && window.FLOTA_CONFIG.bucket) || "flota-data";

let supabaseClient = null;
let appInitialized = false;

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const cfg = window.FLOTA_CONFIG || {};
  if (!window.supabase || !cfg.supabaseUrl || cfg.supabaseUrl.startsWith("REEMPLAZAR")) {
    return null;
  }
  supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  return supabaseClient;
}

/* Descarga un JSON del bucket privado usando la sesión actual.
   Lo usan loadRateCodes() y ensureRatesData() en app.js. */
async function downloadJSONFromBucket(path) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase no configurado");
  const { data, error } = await sb.storage.from(FLOTA_BUCKET).download(path);
  if (error) throw error;
  return JSON.parse(await data.text());
}
window.downloadJSONFromBucket = downloadJSONFromBucket;

/* ---- UI: alternar entre pantalla de login y panel ---- */
function showLogin() {
  document.getElementById("login-screen")?.removeAttribute("hidden");
  document.getElementById("app-root")?.setAttribute("hidden", "");
}

function showApp(session) {
  document.getElementById("login-screen")?.setAttribute("hidden", "");
  document.getElementById("app-root")?.removeAttribute("hidden");

  const userLabel = document.getElementById("session-user");
  if (userLabel && session?.user) userLabel.textContent = session.user.email;

  if (!appInitialized && typeof window.initFlotaApp === "function") {
    appInitialized = true;
    window.initFlotaApp();
  }
}

function setLoginError(msg) {
  const el = document.getElementById("login-error");
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
}

async function handleLogin(e) {
  e.preventDefault();
  setLoginError("");

  const sb = getSupabase();
  if (!sb) {
    setLoginError("Configuración de Supabase incompleta. Revisa js/config.js.");
    return;
  }

  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const btn = document.getElementById("login-submit");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Entrando…";

  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.textContent = label;

  if (error) {
    setLoginError("Email o contraseña incorrectos.");
    return;
  }
  showApp(data.session);
}

async function handleLogout() {
  const sb = getSupabase();
  if (sb) await sb.auth.signOut();
  appInitialized = false;
  window.location.reload();
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("login-form")?.addEventListener("submit", handleLogin);
  document.getElementById("btn-logout")?.addEventListener("click", handleLogout);

  const sb = getSupabase();
  if (!sb) {
    setLoginError("Configuración de Supabase incompleta. Revisa js/config.js.");
    showLogin();
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (session) showApp(session);
  else showLogin();

  sb.auth.onAuthStateChange((_event, session) => {
    if (session) showApp(session);
    else showLogin();
  });
});
