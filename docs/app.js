/* Contracter read-only frontend. Public configuration never contains provider keys.
   Reads cases/health only after an explicit action. Provider calls and approvals
   belong on the backend. Dynamic content uses textContent; server validation is mandatory. */
"use strict";

// PUBLIC values only. Prefer a same-origin reverse proxy (/api). To use a different
// backend origin, add its EXACT origin here and to connect-src in index.html,
// then configure CORS on that backend. Never put a token or API key in this object.
const PUBLIC_CONFIG = Object.freeze({
  apiBaseUrl: "",
  allowedApiOrigins: [],
  sourceConsultationWarningHours: 24
});
const VOICE_SDK = Object.freeze({
  script: "vendor/elevenlabs-client-1.35.0/lib.iife.js",
  integrity: "sha384-sUecpD4t4uadJZFqpJnSDeKxyARkn98eXj33hSiSFSPthBwaH/j1NH2P0XWYjw5K",
  inputWorklet: "vendor/elevenlabs-client-1.35.0/worklets/rawAudioProcessor.js",
  outputWorklet: "vendor/elevenlabs-client-1.35.0/worklets/audioConcatProcessor.js",
  resampler: "vendor/libsamplerate-2.1.2/libsamplerate.worklet.js"
});
const DEMO_URL = "data/sample_case.json";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const AUDITORS = ["Morty", "Harvey", "Murdock", "Lupin"];
const AGENTS = [
  ["Fury", "Orquestación y consenso"], ["Afton", "Seguridad de entrada"],
  ["House", "Auditoría conductual"], ["Jane", "Contexto del cliente"],
  ["Sherlock", "Investigación y fuentes"], ["Morty", "Claridad del texto"],
  ["Harvey", "Estrategia comercial"], ["Murdock", "Revisión normativa"],
  ["Lupin", "Vacíos y exposición"], ["Hamilton", "Propuesta contractual"],
  ["Jarvis", "Control de cambios"], ["Watson", "Síntesis ejecutiva"],
  ["Glenn", "Explicación práctica"]
];
const ROLES = Object.fromEntries(AGENTS);
const $ = (id) => document.getElementById(id);
const integerFormat = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
let renderRequest = 0;
let apiSessionToken = "";
let apiTokenOrigin = "";
let backendHealth = null;
let currentCase = null;
let activeApiControllers = [];
let currentBackendBase = "";
let voiceSession = null;
let voiceStarting = false;
let voiceConnected = false;
let voiceSequence = 0;
let voiceController = null;
let voiceSdkPromise = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function setText(id, value) { $(id).textContent = String(value ?? "Sin información"); }
function number(value) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function money(value, decimals = 4) { return "$" + number(value).toLocaleString("es-MX", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
function statusLabel(status) { return ({ ENTENDIDO: "ENTENDIDO", OBSERVADO: "CON OBSERVACIONES", PENDIENTE: "PENDIENTE" })[status] || "SIN VERIFICAR"; }
function setBadge(node, text, kind) { node.textContent = text; node.className = "badge badge-" + kind; }
function list(id, values, emptyText) {
  const items = Array.isArray(values) && values.length ? values : [emptyText];
  $(id).replaceChildren(...items.map((value) => element("li", "", value)));
}
function message(text, isError = false) {
  setText("load-message", text);
  $("load-message").classList.toggle("is-error", isError);
}

// A deliberately small display gate; this is not the strict Python validator.
// It prevents malformed files from breaking the page and bounds browser work.
function checkDisplayShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("El expediente debe ser un objeto JSON.");
  if (data.schema_version !== "1.0.0") throw new Error("Versión de esquema no compatible. Se espera 1.0.0.");
  for (const key of ["case_id", "title", "created_at"]) {
    if (typeof data[key] !== "string" || !data[key].trim()) throw new Error("Falta el campo de texto: " + key + ".");
  }
  for (const key of ["context", "security", "versions", "house", "fury", "human_approval", "reports", "costs", "jurisdiction", "publication"]) {
    if (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key])) throw new Error("Falta el objeto: " + key + ".");
  }
  for (const name of ["v1", "v2"]) {
    const version = data.versions[name];
    if (!version || typeof version.text !== "string" || typeof version.sha256 !== "string") throw new Error("La versión " + name + " requiere texto y huella SHA-256.");
    if (version.text.length > 250000 || version.text.split("\n").length > 2500) throw new Error("El texto supera el límite de visualización de 250 000 caracteres o 2 500 líneas.");
  }
  for (const [name, values] of [["audits", data.audits], ["changelog", data.changelog], ["costs.events", data.costs.events]]) {
    if (!Array.isArray(values) || values.length > 500 || values.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("La colección " + name + " no es válida o supera 500 entradas.");
  }
  if (!["mock", "live"].includes(data.mode)) throw new Error("El modo del expediente debe ser mock o live.");
  if (!data.reports.watson || typeof data.reports.watson.summary !== "string" || !data.reports.glenn || typeof data.reports.glenn.explanation !== "string") throw new Error("Faltan los reportes de Watson o Glenn.");
  for (const audit of data.audits) {
    if (typeof audit.agent !== "string" || !Array.isArray(audit.findings) || audit.findings.length > 500 || audit.findings.some((item) => !item || typeof item !== "object")) throw new Error("Hay una salida de auditoría mal formada.");
    for (const finding of audit.findings) {
      if (typeof finding.observation !== "string") throw new Error("Cada observación debe contener texto legible.");
    }
  }
  const textArrays = [data.context.objectives, data.reports.watson.key_risks, data.reports.watson.recommendations];
  if (textArrays.some((items) => !Array.isArray(items) || items.length > 500 || items.some((item) => typeof item !== "string"))) throw new Error("Las listas de contexto y reportes deben contener únicamente texto.");
  if (!Array.isArray(data.jurisdiction.sources) || data.jurisdiction.sources.length > 500) throw new Error("La lista de fuentes no es válida.");
  for (const source of data.jurisdiction.sources) {
    if (!source || typeof source !== "object" || ["id", "title", "url", "retrieved_at"].some((key) => typeof source[key] !== "string")) throw new Error("Las fuentes requieren referencia, título, URL y fecha de consulta.");
  }
  if (new Set(data.jurisdiction.sources.map((source) => source.id)).size !== data.jurisdiction.sources.length) throw new Error("Hay referencias de fuente duplicadas.");
  for (const [record, keys] of [[data.context, ["our_party", "counterparty", "our_role"]], [data.jurisdiction, ["country", "region"]]]) {
    if (keys.some((key) => typeof record[key] !== "string")) throw new Error("El contexto y la jurisdicción deben contener campos de texto.");
  }
  for (const change of data.changelog) {
    if (["id", "before", "after", "reason", "operational_impact"].some((key) => typeof change[key] !== "string") || ["line_v1", "line_v2"].some((key) => !Number.isInteger(change[key]) || change[key] < 0)) throw new Error("La bitácora debe contener texto y números de línea válidos. El cero representa una línea ausente por inserción o eliminación.");
  }
  if (["rounds", "max_rounds"].some((key) => !Number.isInteger(data.fury[key]) || data.fury[key] < 0)) throw new Error("Las rondas de Fury deben ser enteros no negativos.");
  const validCost = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (data.costs.currency !== "USD" || !["mock", "verified", "unverified"].includes(data.costs.pricing_status) || !validCost(data.costs.total_usd)) throw new Error("Los costos requieren moneda USD, estado de tarifas y un total numérico no negativo. Un costo desconocido no equivale a cero.");
  for (const event of data.costs.events) {
    if (["event_id", "agent", "model"].some((key) => typeof event[key] !== "string" || !event[key]) || ["cost_usd", "input_rate_per_million", "output_rate_per_million"].some((key) => !validCost(event[key])) || ["tokens_input", "tokens_output", "latency_ms"].some((key) => !Number.isSafeInteger(event[key]) || event[key] < 0)) throw new Error("Cada intervención requiere identificador, costos y tarifas numéricas, tokens y latencia no negativos. No se sustituirán valores faltantes por cero.");
  }
  if (new Set(data.costs.events.map((event) => event.event_id)).size !== data.costs.events.length) throw new Error("Hay intervenciones de costo duplicadas.");
  return data;
}

function displayDate(value, withTime = true) {
  if (typeof value !== "string" || !value) return "Sin registro";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Fecha no válida";
  return new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", ...(withTime ? { timeStyle: "short" } : {}), timeZone: "America/Mexico_City" }).format(date);
}

function sourceUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

function renderLegalSources(data) {
  const sources = data.jurisdiction.sources;
  const status = data.jurisdiction.legal_basis_status;
  const catalog = backendHealth?.services?.legal_sources;
  setBadge($("legal-register-state"), sources.length === 0 ? "SIN CONFIGURAR" : status === "verified" ? "VERIFICACIÓN DECLARADA" : "REVISIÓN PENDIENTE", sources.length && status === "verified" ? "neutral" : "amber");
  const location = [data.jurisdiction.region, data.jurisdiction.country].filter(Boolean).join(", ");
  setText("legal-coverage", "Jurisdicción declarada: " + location + ". Se muestran sólo las referencias citadas en este expediente; no un catálogo completo de leyes.");
  setText("legal-source-count", integerFormat.format(sources.length));
  const dates = sources.map((source) => Date.parse(source.retrieved_at)).filter(Number.isFinite);
  const latest = dates.length ? Math.max(...dates) : null;
  setText("legal-last-read", latest === null ? "Sin registro" : displayDate(new Date(latest).toISOString()));
  $("legal-empty").hidden = sources.length > 0;
  $("legal-table-region").hidden = sources.length === 0;
  $("legal-source-rows").replaceChildren(...sources.map((source) => {
    const row = element("tr", "");
    const title = element("td", "");
    title.append(element("strong", "", source.title), element("span", "", "Referencia: " + source.id));
    const origin = element("td", "");
    const url = sourceUrl(source.url);
    if (url) {
      const link = element("a", "source-link", url.hostname);
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      link.setAttribute("aria-label", "Abrir fuente: " + source.title + " en " + url.hostname);
      origin.append(link);
    } else origin.append(element("span", "", "URL no válida para abrir"));
    row.append(title, origin, element("td", "", displayDate(source.retrieved_at)));
    return row;
  }));
  const threshold = PUBLIC_CONFIG.sourceConsultationWarningHours;
  const oldCount = dates.filter((date) => Date.now() - date > threshold * 3600000).length;
  const dateNote = oldCount ? " " + oldCount + " consulta(s) superan el umbral operativo de " + threshold + " h; revisar su actualización. Ese umbral no determina vigencia jurídica." : "";
  setText("legal-freshness-note", "La fecha es de consulta, no de reforma o entrada en vigor. Una URL y una fecha no prueban vigencia ni que la norma corresponda al caso." + dateNote);
  const syncLabels = { configured: "Configurada (declarado)", unconfigured: "Sin configurar", error: "Error reportado", unknown: "Sin comprobar" };
  setText("legal-sync-state", syncLabels[catalog?.status] || "Sin configurar");
  const lastSync = typeof catalog?.last_sync_at === "string" ? " Última sincronización reportada: " + displayDate(catalog.last_sync_at) + "." : " Sin fecha de sincronización reportada.";
  setText("legal-sync-detail", catalog ? "Estado reportado por el backend configurado; no se ha inferido una cobertura total." + lastSync : "No se ha recibido información de un servicio de actualización. No se presupone que exista una base con todas las leyes.");
}

function renderServiceStatus(health) {
  const labels = { configured: "Configurado (declarado)", unconfigured: "Sin configurar", error: "Error reportado", unknown: "Sin comprobar" };
  for (const service of ["llm", "n8n", "database", "telegram", "elevenlabs"]) {
    const status = health?.services?.[service]?.status;
    setText("integration-" + service, labels[status] || "Sin comprobar");
  }
  setText("integration-overall", health ? "REPORTADO" : "SIN PRUEBA");
  setText("integration-checked-at", health ? "Respuesta del backend: " + displayDate(health.checked_at) + " · America/Mexico_City. La configuración declarada no demuestra conectividad de cada proveedor." : "Sin respuesta de un backend. Abrir una consola no comprueba una integración.");
  if (currentCase) renderLegalSources(currentCase);
  updateVoiceAvailability();
}

function canStartVoice() {
  return Boolean(currentCase && currentBackendBase && apiSessionToken) &&
    backendHealth?.mode === currentCase.mode && backendHealth?.services?.elevenlabs?.status === "configured";
}

function updateVoiceAvailability() {
  $("voice-connect").disabled = !canStartVoice() || voiceStarting || Boolean(voiceSession);
  $("voice-disconnect").disabled = !voiceStarting && !voiceSession;
  if (!voiceSession && !voiceStarting) {
    setText("voice-status", canStartVoice()
      ? "Disponible para iniciar. Al pulsar Conectar voz se solicitará una sesión autorizada y permiso de micrófono."
      : "Para habilitar la voz, carga el expediente desde un backend configurado con ElevenLabs y acceso privado.");
  }
}

function validateSignedVoiceUrl(value) {
  if (typeof value !== "string") throw new Error("El servidor no entregó una sesión de voz válida.");
  let url;
  try { url = new URL(value); } catch { throw new Error("El servidor no entregó una sesión de voz válida."); }
  if (url.protocol !== "wss:" || url.hostname !== "api.elevenlabs.io" || (url.port && url.port !== "443") || url.pathname !== "/v1/convai/conversation" || url.username || url.password || url.hash) throw new Error("La sesión de voz no corresponde al servicio ElevenLabs permitido.");
  return url.href;
}

function loadVoiceSdk() {
  if (window.ElevenLabsClient?.Conversation?.startSession) return Promise.resolve(window.ElevenLabsClient);
  if (voiceSdkPromise) return voiceSdkPromise;
  voiceSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = VOICE_SDK.script;
    script.integrity = VOICE_SDK.integrity;
    script.crossOrigin = "anonymous";
    script.async = true;
    script.onload = () => window.ElevenLabsClient?.Conversation?.startSession ? resolve(window.ElevenLabsClient) : reject(new Error("El cliente de voz no está disponible."));
    script.onerror = () => { voiceSdkPromise = null; reject(new Error("No se pudo cargar el cliente local de voz. Comprueba los archivos del proyecto y su CSP.")); };
    document.head.append(script);
  });
  return voiceSdkPromise;
}

async function requestVoiceSession(base, caseId, token) {
  voiceController = new AbortController();
  const controller = voiceController;
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(base + "/voice/session", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ case_id: caseId }), credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error("No se autorizó la sesión de voz (HTTP " + response.status + "). Revisa el acceso al caso y la configuración del servidor.");
    const text = await response.text();
    if (text.length > 16384) throw new Error("Respuesta de voz no válida.");
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error("Respuesta de voz no válida."); }
    if (payload.case_id !== caseId) throw new Error("La sesión no corresponde al expediente solicitado.");
    const context = payload.context_linked === true ? payload.voice_context : null;
    if (payload.context_linked === true && (typeof context !== "string" || !context.trim() || context.length > 700)) {
      throw new Error("El contexto de evaluación no es válido.");
    }
    return { signedUrl: validateSignedVoiceUrl(payload.signed_url), context };
  } finally { clearTimeout(timer); if (voiceController === controller) voiceController = null; }
}

async function stopVoice(reason = "Sesión de voz cerrada.") {
  ++voiceSequence;
  voiceController?.abort();
  voiceController = null;
  const session = voiceSession;
  voiceSession = null;
  voiceStarting = false;
  voiceConnected = false;
  if (session) {
    try { session.setMicMuted(true); } catch { /* Cleanup continues without logging signed URLs. */ }
    try { await session.endSession(); } catch { /* The page never retries a connection automatically. */ }
  }
  updateVoiceAvailability();
  setText("voice-status", reason);
}

async function startVoice() {
  if (!canStartVoice() || voiceStarting || voiceSession) { updateVoiceAvailability(); return; }
  const sequence = ++voiceSequence;
  voiceStarting = true;
  updateVoiceAvailability();
  setText("voice-status", "Solicitando una sesión autorizada. El micrófono se activa sólo si aceptas su permiso.");
  try {
    const voiceInfo = await requestVoiceSession(currentBackendBase, currentCase.case_id, apiSessionToken);
    if (sequence !== voiceSequence || document.hidden) return;
    const sdk = await loadVoiceSdk();
    if (sequence !== voiceSequence || document.hidden) return;
    const session = await sdk.Conversation.startSession({
      signedUrl: voiceInfo.signedUrl,
      connectionType: "websocket",
      ...(voiceInfo.context ? { dynamicVariables: { contracter_context: voiceInfo.context } } : {}),
      workletPaths: { rawAudioProcessor: new URL(VOICE_SDK.inputWorklet, document.baseURI).href, audioConcatProcessor: new URL(VOICE_SDK.outputWorklet, document.baseURI).href },
      libsampleratePath: new URL(VOICE_SDK.resampler, document.baseURI).href,
      onConnect: () => { if (sequence === voiceSequence) { voiceConnected = true; setText("voice-status", "Conectado a ElevenLabs. Pulsa Desconectar para cerrar el micrófono." + (voiceInfo.context ? " La sesión incluye el resumen de evaluación." : " Esta sesión funciona sin acceso al expediente.")); } },
      onDisconnect: () => { if (sequence === voiceSequence) { voiceSession = null; voiceStarting = false; voiceConnected = false; updateVoiceAvailability(); setText("voice-status", "ElevenLabs cerró la sesión de voz."); } },
      onError: () => { if (sequence === voiceSequence) void stopVoice("La sesión de voz se interrumpió. Revisa permiso de micrófono, acceso y saldo en el proveedor."); }
    });
    if (sequence !== voiceSequence || document.hidden) { try { session.setMicMuted(true); await session.endSession(); } catch {} return; }
    voiceSession = session;
    voiceStarting = false;
    updateVoiceAvailability();
    if (!voiceConnected) setText("voice-status", "Esperando la confirmación de conexión de ElevenLabs…");
  } catch (error) {
    if (sequence !== voiceSequence) return;
    voiceStarting = false;
    updateVoiceAvailability();
    const safeMessage = error?.name === "NotAllowedError" ? "No se concedió permiso de micrófono. No hay una conversación activa." : error?.name === "AbortError" ? "La solicitud de voz se canceló o superó su tiempo límite." : "No se pudo iniciar la voz. Revisa el permiso de micrófono, la configuración del servidor y el acceso a ElevenLabs.";
    setText("voice-status", safeMessage);
  }
}

$("voice-connect").addEventListener("click", startVoice);
$("voice-disconnect").addEventListener("click", () => void stopVoice());
document.addEventListener("visibilitychange", () => { if (document.hidden && (voiceStarting || voiceSession)) void stopVoice("La sesión se cerró al ocultar la página. No se reconecta automáticamente."); });
window.addEventListener("pagehide", () => { if (voiceStarting || voiceSession) void stopVoice("Sesión cerrada al salir de la página."); });

function renderDecision(data, consensus) {
  const reasons = [];
  if (data.mode === "mock") reasons.push("El expediente es una simulación.");
  if (data.evaluation) reasons.push("Este expediente de evaluación no admite aprobación jurídica.");
  if (data.security.status !== "CLEAN") reasons.push("Afton no ha declarado una entrada limpia.");
  if (consensus !== 4 || data.fury.status !== "CONSENSUS") reasons.push("El consenso de V2 está incompleto.");
  if (data.house.status !== "CLEAN" || data.house.contract_access !== false) reasons.push("House requiere revisión.");
  if (data.jurisdiction.legal_basis_status !== "verified" || !data.jurisdiction.sources.length) reasons.push("La base jurídica no está acreditada.");
  if (data.human_approval.status !== "APPROVED") reasons.push(data.human_approval.status === "REJECTED" ? "Hay un rechazo declarado del abogado." : "Falta la aprobación del abogado responsable.");
  setText("decision-title", reasons.length ? "V2 permanece retenida" : "El archivo declara una aprobación: verifica la evidencia en servidor");
  setText("decision-detail", reasons.length ? reasons.join(" ") : "Este panel no autentica al aprobador ni autoriza una publicación. La firma debe corresponder al hash exacto de V2.");
}

function renderVersions(data) {
  const changes = data.changelog;
  for (const [version, side] of [["v1", "old"], ["v2", "new"]]) {
    const changed = new Set(changes.map((change) => change["line_" + version]));
    const lines = data.versions[version].text.split("\n").map((line, index) => element("li", changed.has(index + 1) ? "changed-" + side : "", line || " "));
    $("version-" + version).replaceChildren(...lines);
    setText("hash-" + version, data.versions[version].sha256);
  }
  setText("changes-count", changes.length);
  const cards = changes.map((change, index) => {
    const article = element("article", "change-item");
    const heading = element("div", "change-top");
    const fromLine = change.line_v1 === 0 ? "V1 · sin línea (inserción)" : "V1 · línea " + change.line_v1;
    const toLine = change.line_v2 === 0 ? "V2 · sin línea (eliminación)" : "V2 · línea " + change.line_v2;
    heading.append(element("strong", "", change.id || "Cambio " + (index + 1)), element("span", "", fromLine + " → " + toLine));
    const before = change.line_v1 === 0 && change.before === "" ? "Sin texto anterior · línea insertada en V2." : change.before || "Línea vacía en V1.";
    const after = change.line_v2 === 0 && change.after === "" ? "Sin texto posterior · línea eliminada de V1." : change.after || "Línea vacía en V2.";
    article.append(heading, element("div", "change-text old", before), element("div", "change-text new", after), element("p", "", change.reason), element("p", "change-impact", "Implicación operativa: " + String(change.operational_impact ?? "Sin documentar")));
    return article;
  });
  $("changelog").replaceChildren(...(cards.length ? cards : [element("p", "muted", "No hay cambios registrados en este expediente.")]));
}

function renderPipeline(data, consensus) {
  const approved = data.human_approval.status === "APPROVED";
  const clean = data.house.status === "CLEAN" && data.house.contract_access === false;
  const safe = data.security.status === "CLEAN";
  const steps = [
    ["Entrada y seguridad", "Afton · perímetro", safe ? "done" : "blocked"],
    ["Revisión de V2", "Fury · " + consensus + "/4 auditores", consensus === 4 && data.fury.status === "CONSENSUS" ? "done" : "pending"],
    ["Control conductual", "House · salidas de agentes", clean ? "done" : "blocked"],
    ["Aprobación humana", approved ? "Declarada en el JSON" : "Abogado responsable", approved && data.mode === "live" ? "done" : data.human_approval.status === "REJECTED" ? "blocked" : "pending"]
  ];
  $("pipeline-steps").replaceChildren(...steps.map(([title, subtitle, state], index) => {
    const item = element("li", "pipeline-step");
    const marker = element("span", "step-marker is-" + state, state === "done" ? "✓" : state === "blocked" ? "!" : index + 1);
    marker.setAttribute("aria-label", state === "done" ? "Declarado conforme" : state === "blocked" ? "Bloqueado" : "Pendiente");
    const copy = element("div", "step-copy");
    copy.append(element("strong", "", title), element("span", "", subtitle));
    item.append(marker, copy);
    return item;
  }));
  setText("release-note", data.mode === "mock" ? "SIMULACIÓN · La propuesta permanece sujeta a revisión y firma del abogado. El consenso de prueba no autoriza una publicación de producción." : "ESTADO DECLARADO EN EL ARCHIVO · La identidad, la evidencia de aprobación y las condiciones de publicación deben validarse en el servidor.");
}

function renderAudits(data) {
  $("audit-cards").replaceChildren(...AUDITORS.map((name) => {
    const matching = data.audits.filter((item) => item.agent === name);
    const audit = matching.length === 1 ? matching[0] : null;
    const card = element("article", "audit-card");
    const header = element("div", "audit-card-head");
    const identity = element("div", "");
    identity.append(element("h3", "", name), element("div", "audit-role", ROLES[name]));
    const badge = element("span", "badge");
    setBadge(badge, audit ? statusLabel(audit.status) : "SIN VERIFICAR", audit?.status === "ENTENDIDO" ? "teal" : "amber");
    header.append(identity, badge);
    const findings = audit?.findings || [];
    const first = findings[0];
    card.append(header, element("p", "", first?.observation || "Sin observaciones documentadas en esta salida."), element("div", "audit-findings", findings.length + " observación(es) · " + findings.filter((finding) => finding.resolved === true).length + " marcada(s) resuelta(s)"));
    return card;
  }));
  setText("audit-round", "RONDA " + String(data.fury.rounds ?? "—") + " / " + String(data.fury.max_rounds ?? "—"));
  $("agent-roster").replaceChildren(...AGENTS.map(([name, role]) => {
    const item = element("div", "roster-item");
    item.append(element("strong", "", name), element("span", "", role));
    return item;
  }));
}

function renderContext(data) {
  const fields = [["Nuestra parte", data.context.our_party], ["Contraparte", data.context.counterparty], ["Rol en el trato", data.context.our_role], ["Jurisdicción declarada", [data.jurisdiction.region, data.jurisdiction.country].filter(Boolean).join(", ")], ["Contexto de Jane", data.context.confirmed === true ? "Declarado confirmado en el JSON" : "Pendiente de confirmar"]];
  $("context-fields").replaceChildren(...fields.map(([label, value]) => {
    const group = element("div", "");
    group.append(element("dt", "", label), element("dd", "", value || "Sin documentar"));
    return group;
  }));
  list("context-objectives", data.context.objectives, "Sin objetivos documentados.");
  const sourceCount = data.jurisdiction.sources.length;
  setText("legal-basis-note", data.jurisdiction.legal_basis_status === "verified" ? "El archivo declara " + sourceCount + " fuente(s) verificadas. Este panel no comprueba su vigencia ni acredita el cumplimiento normativo." : "Sin verificación normativa real. Murdock necesita fuentes oficiales vigentes y revisión profesional antes de emitir un dictamen jurídico.");
}

function renderGuardrails(data) {
  const controls = [
    ["Afton · entrada", data.security.status === "CLEAN" ? "Entrada declarada limpia. La sanitización no garantiza inmunidad ante inyecciones." : "Entrada bloqueada o sin estado limpio.", data.security.status === "CLEAN" ? "done" : "blocked"],
    ["House · conducta", data.house.contract_access === false ? "Sólo evalúa salidas. El archivo declara que no recibió el contrato." : "El aislamiento documental no está acreditado.", data.house.status === "CLEAN" && data.house.contract_access === false ? "done" : "blocked"],
    ["Fury · liberación", data.fury.status === "CONSENSUS" ? "Consenso declarado sobre la huella de V2. La aprobación humana sigue siendo obligatoria." : "Propuesta retenida hasta resolver las observaciones.", data.fury.status === "CONSENSUS" ? "done" : "pending"],
    ["Abogado · aprobación", data.mode === "mock" ? "Sin firma humana real en este caso simulado." : "El estado proviene del JSON; requiere evidencia de aprobación verificada en servidor.", data.mode === "live" && data.human_approval.status === "APPROVED" ? "done" : "pending"]
  ];
  $("guardrail-list").replaceChildren(...controls.map(([title, description, state]) => {
    const item = element("div", "guardrail-item");
    const symbol = element("span", "guardrail-symbol" + (state === "done" ? "" : " is-" + state), state === "done" ? "✓" : "!");
    symbol.setAttribute("aria-hidden", "true");
    const copy = element("div", "");
    copy.append(element("strong", "", title), element("p", "", description));
    item.append(symbol, copy);
    return item;
  }));
}

function renderCosts(data) {
  const events = data.costs.events;
  const total = number(data.costs.total_usd);
  const sums = events.reduce((acc, event) => ({ input: acc.input + number(event.tokens_input), output: acc.output + number(event.tokens_output), latency: acc.latency + number(event.latency_ms), cost: acc.cost + number(event.cost_usd) }), { input: 0, output: 0, latency: 0, cost: 0 });
  setText("metric-cost", money(total, total === 0 ? 2 : 4));
  setText("cost-total", money(total, total === 0 ? 2 : 4) + " USD");
  setText("metric-cost-note", data.costs.pricing_status === "mock" ? "USD · costo simulado" : data.costs.pricing_status === "verified" ? "USD · tarifas declaradas verificadas" : "USD · tarifas sin verificar");
  setBadge($("cost-pricing"), data.costs.pricing_status === "mock" ? "SIMULADO" : data.costs.pricing_status === "verified" ? "DECLARADO VERIFICADO" : "TARIFAS SIN VERIFICAR", data.costs.pricing_status === "unverified" ? "amber" : "neutral");
  const mismatch = Math.abs(sums.cost - total) > 0.000000001;
  setText("cost-method", (data.costs.pricing_status === "mock" ? "Intervenciones de prueba: no se han enviado solicitudes a proveedores ni consumido tokens reales." : "Los importes son declarados por el expediente. El validador del servidor comprueba tarifas, cálculo y consistencia.") + (mismatch ? " Atención: el total declarado difiere de la suma de eventos." : ""));
  $("cost-rows").replaceChildren(...events.map((event) => {
    const row = element("tr", "");
    const identity = element("td", "");
    identity.append(element("strong", "", event.agent || "Sin agente"), element("span", "", event.model || "Sin modelo"));
    row.append(identity, element("td", "numeric", integerFormat.format(number(event.tokens_input))), element("td", "numeric", integerFormat.format(number(event.tokens_output))), element("td", "numeric", integerFormat.format(number(event.latency_ms)) + " ms"), element("td", "numeric", money(event.cost_usd, 6)));
    return row;
  }));
  setText("tokens-input-total", integerFormat.format(sums.input));
  setText("tokens-output-total", integerFormat.format(sums.output));
  setText("latency-total", integerFormat.format(sums.latency) + " ms");
  setText("cost-table-total", money(sums.cost, 6));
}

function render(data, imported, sourceLabel) {
  const notice = $("simulation-notice");
  const isMock = data.mode === "mock";
  const fromBackend = typeof sourceLabel === "string" && sourceLabel.startsWith("backend propio");
  if (!fromBackend && Object.hasOwn(data, "evaluation")) data = { ...data, evaluation: false };
  currentCase = data;
  notice.classList.toggle("is-live", !isMock);
  if (data.evaluation) {
    notice.querySelector("strong").textContent = "Expediente de evaluación";
    notice.querySelector("p").textContent = "Caso ficticio procesado por el flujo conectado. Se conserva para evaluación y no admite aprobación jurídica.";
    notice.querySelector(".outline-tag").textContent = "EVALUACIÓN";
  } else {
    notice.querySelector("strong").textContent = isMock ? "Entorno de simulación" : fromBackend ? "Expediente del backend · estado declarado" : "Expediente local · estado sin verificar";
    notice.querySelector("p").textContent = isMock ? "Datos ficticios para probar la tubería. No representan una auditoría jurídica ni una aprobación humana real." : "El contenido y los estados provienen de este archivo. Este navegador no verifica la identidad del aprobador, la firma ni la vigencia legal.";
    notice.querySelector(".outline-tag").textContent = isMock ? "MOCK" : fromBackend ? "BACKEND" : "LOCAL";
  }
  setText("case-reference", "EXPEDIENTE / " + data.case_id);
  setText("case-title", data.title);
  setText("case-parties", data.context.our_party + "  ·  " + data.context.counterparty);
  setText("case-source", "Fuente: " + (sourceLabel || (imported ? "archivo local seleccionado" : "data/sample_case.json · demostración")));
  setText("case-cutoff", "Corte del expediente: " + displayDate(data.created_at) + " · America/Mexico_City");
  const date = new Date(data.created_at);
  setText("case-date", Number.isNaN(date.getTime()) ? "Fecha no válida" : new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeZone: "America/Mexico_City" }).format(date));
  const approved = data.human_approval.status === "APPROVED";
  const rejected = data.human_approval.status === "REJECTED";
  setBadge($("approval-state"), isMock && approved ? "Aprobación declarada · simulada" : approved ? "Aprobación declarada · sin verificar" : rejected ? "Rechazo declarado en el archivo" : "Aprobación humana pendiente", rejected ? "red" : "amber");
  const consensus = AUDITORS.filter((name) => {
    const matches = data.audits.filter((audit) => audit.agent === name);
    return matches.length === 1 && matches[0].status === "ENTENDIDO" && matches[0].reviewed_version === "V2" && matches[0].reviewed_sha256 === data.versions.v2.sha256;
  }).length;
  setText("metric-consensus", consensus + " / 4");
  setText("metric-consensus-note", consensus === 4 ? "Conformidad declarada sobre V2" : "Auditores conformes con la huella de V2");
  renderDecision(data, consensus);
  setText("metric-changes", integerFormat.format(data.changelog.length));
  const houseClean = data.house.status === "CLEAN" && data.house.contract_access === false;
  setText("metric-house", houseClean ? "Limpio" : "Revisar");
  $("metric-house").style.color = houseClean ? "var(--teal)" : "var(--amber)";
  setText("metric-house-note", houseClean ? "Declarado en el expediente" : "Hay controles pendientes o cuarentena");
  renderPipeline(data, consensus);
  renderVersions(data);
  renderAudits(data);
  renderContext(data);
  renderGuardrails(data);
  renderCosts(data);
  renderLegalSources(data);
  setText("watson-summary", data.reports.watson.summary);
  list("watson-risks", data.reports.watson.key_risks, "Sin riesgos documentados. Esto no acredita ausencia de riesgo.");
  list("watson-actions", data.reports.watson.recommendations, "Sin acciones documentadas.");
  setText("glenn-explanation", data.reports.glenn.explanation);
  $("case-content").hidden = false;
  message(imported ? "Archivo leído sólo en este navegador. Los estados son declarados; ejecuta el validador antes de utilizar o publicar el expediente." : "");
}

function apiBase(value) {
  if (!value.trim()) throw new Error("Indica la URL base de tu backend. No hay un servidor preconfigurado.");
  if (location.protocol === "file:") throw new Error("La lectura del backend requiere servir esta página por HTTP(S). El selector de archivo local sigue disponible.");
  const url = new URL(value.trim(), location.origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new Error("Usa HTTPS para el backend (HTTP sólo en localhost), sin credenciales, consulta ni fragmento en la URL.");
  const allowedOrigins = new Set([location.origin, ...PUBLIC_CONFIG.allowedApiOrigins]);
  if (!allowedOrigins.has(url.origin)) throw new Error("Este origen no está autorizado. Configura su origen exacto en PUBLIC_CONFIG, connect-src y CORS del backend; no se permite un comodín.");
  return url.href.replace(/\/+$/, "");
}

async function readBackendJson(url, token) {
  const controller = new AbortController();
  activeApiControllers.push(controller);
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { method: "GET", cache: "no-store", credentials: "omit", headers: token ? { Authorization: "Bearer " + token } : {}, signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "El backend rechazó el acceso. Comprueba la autorización del expediente." : "El backend respondió HTTP " + response.status + ".");
    const content = await response.text();
    if (content.length > MAX_FILE_BYTES) throw new Error("La respuesta del backend supera 2 MB.");
    return JSON.parse(content);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("La consulta fue cancelada o superó 15 segundos. El expediente anterior se conserva.");
    if (error instanceof SyntaxError) throw new Error("El backend no devolvió un JSON válido.");
    if (error instanceof TypeError) throw new Error("No se pudo consultar el backend. Revisa URL, HTTPS, CSP, CORS y disponibilidad del servidor.");
    throw error;
  } finally { clearTimeout(timer); }
}

function checkHealthShape(value) {
  if (!value || typeof value !== "object" || !["ok", "degraded"].includes(value.status) || !["mock", "live"].includes(value.mode) || typeof value.checked_at !== "string" || !Number.isFinite(Date.parse(value.checked_at)) || !value.services || typeof value.services !== "object" || Array.isArray(value.services)) throw new Error("La respuesta /health no tiene el formato de estado esperado.");
  return value;
}

$("api-base").value = PUBLIC_CONFIG.apiBaseUrl;
$("backend-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  let base, id;
  try {
    base = apiBase($("api-base").value);
    id = $("api-case-id").value.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Introduce un ID de expediente con formato UUID.");
  } catch (error) { setText("backend-message", error.message); return; }
  await stopVoice("Sesión cerrada al cambiar la consulta del backend.");
  currentBackendBase = "";
  backendHealth = null;
  renderServiceStatus(null);
  const request = ++renderRequest;
  activeApiControllers.forEach((controller) => controller.abort());
  activeApiControllers = [];
  const origin = new URL(base).origin;
  if (apiTokenOrigin !== origin) apiSessionToken = "";
  apiTokenOrigin = origin;
  if ($("api-token").value) apiSessionToken = $("api-token").value.trim();
  $("api-token").value = "";
  $("load-server").disabled = true;
  setText("backend-message", "Consultando estado y expediente, sin modificar datos…");
  setBadge($("backend-status"), "CONSULTANDO", "neutral");
  try {
    const results = await Promise.allSettled([readBackendJson(base + "/health", apiSessionToken), readBackendJson(base + "/cases/" + encodeURIComponent(id), apiSessionToken)]);
    if (request !== renderRequest) return;
    const [healthResult, caseResult] = results;
    const notices = [];
    if (healthResult.status === "fulfilled") {
      backendHealth = checkHealthShape(healthResult.value);
      renderServiceStatus(backendHealth);
      setText("connection-label", "Backend respondió · " + backendHealth.mode);
      setText("connection-chip", "BACKEND · " + backendHealth.mode.toUpperCase());
      notices.push("Estado recibido del backend.");
    } else notices.push("Estado sin comprobar: " + healthResult.reason.message);
    if (caseResult.status === "fulfilled") {
      const receivedCase = checkDisplayShape(caseResult.value);
      currentBackendBase = base;
      render(receivedCase, false, "backend propio · " + new URL(base).host);
      message("Expediente recibido del backend configurado. Los dictámenes y la firma siguen sujetos a validación del servidor.");
      notices.push("Expediente cargado en modo " + caseResult.value.mode + ".");
    } else notices.push("No se cambió el expediente mostrado: " + caseResult.reason.message);
    const hasAnyResponse = results.some((result) => result.status === "fulfilled");
    setBadge($("backend-status"), hasAnyResponse ? "RESPUESTA RECIBIDA" : "SIN RESPUESTA", hasAnyResponse ? "neutral" : "amber");
    setText("backend-message", notices.join(" "));
  } catch (error) {
    if (request === renderRequest) {
      setBadge($("backend-status"), "REVISAR RESPUESTA", "amber");
      setText("backend-message", error.message + " No se ha autorizado ninguna publicación.");
    }
  } finally { if (request === renderRequest) $("load-server").disabled = false; }
});

function clearBackendContext(label, chip, badge, detail) {
  currentBackendBase = "";
  activeApiControllers.forEach((controller) => controller.abort());
  activeApiControllers = [];
  apiSessionToken = "";
  apiTokenOrigin = "";
  $("api-token").value = "";
  $("load-server").disabled = false;
  backendHealth = null;
  renderServiceStatus(null);
  setBadge($("backend-status"), badge, "neutral");
  setText("connection-label", label);
  setText("connection-chip", chip);
  setText("backend-message", detail);
}

$("clear-session").addEventListener("click", () => {
  ++renderRequest;
  clearBackendContext("Backend sin consultar", "SIN SESIÓN DE API", "ACCESO BORRADO", "Acceso temporal borrado y consultas pendientes canceladas. El expediente ya mostrado se conserva.");
  void stopVoice("Sesión cerrada y acceso temporal borrado.");
});

async function loadDemo() {
  const request = ++renderRequest;
  clearBackendContext("Demostración local", "DEMO · SIN CONEXIÓN", "SIN CONSULTAR", "Demostración local. Consulta el backend explícitamente para cargar un expediente del servidor.");
  await stopVoice("Voz desactivada al abrir la demostración.");
  message("Cargando el expediente de demostración…");
  $("reset-demo").disabled = true;
  try {
    if (location.protocol === "file:") throw new Error("Abre el expediente manualmente con «Abrir expediente JSON» y elige docs/data/sample_case.json. La carga automática requiere un servidor HTTP local.");
    const response = await fetch(DEMO_URL, { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error("No se encontró el ejemplo (HTTP " + response.status + "). Usa el selector para abrir un expediente JSON.");
    const content = await response.text();
    if (content.length > MAX_FILE_BYTES) throw new Error("El expediente de demostración supera el tamaño admitido.");
    const data = checkDisplayShape(JSON.parse(content));
    if (request === renderRequest) render(data, false);
  } catch (error) {
    if (request === renderRequest) message(error instanceof SyntaxError ? "El JSON de demostración no es válido." : error.message, true);
  } finally {
    if (request === renderRequest) $("reset-demo").disabled = false;
  }
}

$("case-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const request = ++renderRequest;
  $("reset-demo").disabled = false;
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error("El archivo supera el límite de 2 MB. Selecciona un expediente más pequeño.");
    const data = checkDisplayShape(JSON.parse(await file.text()));
    if (request === renderRequest) {
      await stopVoice("Voz desactivada al abrir un archivo local.");
      clearBackendContext("Archivo local · sin conexión", "ARCHIVO LOCAL", "SIN CONSULTAR", "El archivo se leyó en este navegador. No es una respuesta del backend.");
      render(data, true);
    }
  } catch (error) {
    if (request === renderRequest) message(error instanceof SyntaxError ? "No se pudo leer el archivo: no contiene JSON válido. El expediente anterior se conserva." : error.message + " El expediente anterior se conserva.", true);
  } finally {
    event.target.value = "";
  }
});
$("reset-demo").addEventListener("click", loadDemo);

// The chooser prepares a Telegram command. Provider selection and billing stay server-side.
const providerCommands = Object.freeze({
  gemini: "/evaluar gemini consulta",
  openai: "/evaluar openai confirmar",
  gateway: "/evaluar gateway"
});
const providerNotes = Object.freeze({
  gemini: "El comando estará disponible cuando se publique el flujo de evaluación.",
  openai: "Al enviar el comando, el bot recibe tu confirmación para usar la API de OpenAI. Verifica el saldo antes de enviarlo.",
  gateway: "El comando identifica la ruta de respaldo. La integración y su crédito disponible siguen en validación."
});
const providerOptions = $("provider-options");
const openAiConsent = $("provider-openai-consent");
const openAiConfirm = $("provider-openai-confirm");
const providerCommand = $("provider-command");
const providerCopy = $("provider-copy");
const providerScope = $("provider-scope");

function showProviderCommand(provider) {
  const isGemini = provider === "gemini";
  const isFullAudit = providerScope.value === "full";
  const scopeNote = isFullAudit ? "Auditoría del caso ficticio. " : "Consulta breve con el caso ficticio. ";
  providerCommand.value = isGemini && isFullAudit ? "/evaluar gemini" : providerCommands[provider];
  setText("provider-note", (isGemini ? scopeNote : "") + providerNotes[provider]);
  $("provider-gemini-mode").hidden = !isGemini;
  $("provider-handoff").hidden = false;
  $("provider-openai-confirmation").hidden = true;
  providerCopy.disabled = false;
}

providerOptions.addEventListener("change", (event) => {
  const provider = event.target.value;
  if (!Object.hasOwn(providerCommands, provider)) return;
  openAiConsent.checked = false;
  openAiConfirm.disabled = true;
  if (provider === "openai") {
    providerCommand.value = "";
    providerCopy.disabled = true;
    $("provider-handoff").hidden = true;
    $("provider-openai-confirmation").hidden = false;
    setText("provider-status", "Confirma la facturación separada para preparar el comando de OpenAI directo.");
    return;
  }
  showProviderCommand(provider);
  setText("provider-status", "Comando preparado para " + (provider === "gemini" ? "Gemini Free." : "Gateway n8n."));
});

providerScope.addEventListener("change", () => {
  showProviderCommand("gemini");
  setText("provider-status", "Comando de Gemini actualizado.");
});

openAiConsent.addEventListener("change", () => {
  openAiConfirm.disabled = !openAiConsent.checked;
});

openAiConfirm.addEventListener("click", () => {
  if (!$("provider-openai").checked || !openAiConsent.checked) return;
  showProviderCommand("openai");
  setText("provider-status", "OpenAI directo confirmado para este comando de Telegram.");
  providerCommand.focus();
});

providerCopy.addEventListener("click", async () => {
  const command = providerCommand.value;
  if (!command || $("provider-handoff").hidden) return;
  try {
    await navigator.clipboard.writeText(command);
    if (providerCommand.value === command) setText("provider-status", "Comando copiado. Pégalo en el chat privado del bot de Telegram.");
  } catch {
    if (providerCommand.value !== command) return;
    providerCommand.focus();
    providerCommand.select();
    setText("provider-status", "El navegador bloqueó la copia automática. Copia el comando seleccionado con tu teclado o el menú del dispositivo.");
  }
});

function resetProviderChooser() {
  $("provider-gemini").checked = true;
  providerScope.value = "quick";
  providerScope.disabled = false;
  openAiConsent.checked = false;
  openAiConfirm.disabled = true;
  setText("provider-status", "");
  showProviderCommand("gemini");
  providerOptions.disabled = false;
}
resetProviderChooser();
window.addEventListener("pageshow", (event) => { if (event.persisted) resetProviderChooser(); });

const tabs = [$("compare-tab"), $("changes-tab")];
function activateTab(selected, focus = false) {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.classList.toggle("is-active", active);
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute("aria-controls")).hidden = !active;
  }
  if (focus) selected.focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateTab(tab));
  tab.addEventListener("keydown", (event) => {
    let target;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") target = tabs[1 - index];
    if (event.key === "Home") target = tabs[0];
    if (event.key === "End") target = tabs[1];
    if (target) { event.preventDefault(); activateTab(target, true); }
  });
});

// Anchor navigation remains usable without this enhancement.
if ("IntersectionObserver" in window) {
  const links = [...document.querySelectorAll(".nav-link")];
  const observer = new IntersectionObserver((entries) => {
    const current = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!current) return;
    links.forEach((link) => {
      const active = link.getAttribute("href") === "#" + current.target.id;
      link.classList.toggle("is-current", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }, { rootMargin: "-5% 0px -65% 0px", threshold: 0 });
  ["overview", "versions", "reports", "legal-sources", "team", "costs"].forEach((id) => observer.observe($(id)));
}

loadDemo();

