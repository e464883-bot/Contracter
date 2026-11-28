/** Contracter: read-only local gateway, no packages and no provider calls at startup.
 * Node.js 24+. SQLite is a MOCK fixture store, never an implicit live fallback.
 * Secrets are read from the process environment and never returned or logged.
 */
import { createServer } from 'node:http';
import { readFile, realpath, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createOperatorSwitch } from './operator-switch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const now = () => new Date().toISOString();
const filled = v => typeof v === 'string' && v.trim() && !/TODO_|INSERT_KEY|YOUR_/i.test(v);

export class GatewayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function need(ok, status, code, message) { if (!ok) throw new GatewayError(status, code, message); }
function normalizeOrigin(input) {
  const u = new URL(input);
  need(!u.username && !u.password && u.pathname === '/' && !u.search && !u.hash,
    400, 'INVALID_ORIGIN', 'Se requiere un origen sin ruta, usuario ni parámetros.');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  need(u.protocol === 'https:' || (u.protocol === 'http:' && loopback),
    400, 'INVALID_ORIGIN', 'HTTP sólo se admite en loopback; use HTTPS en otro servidor.');
  return u.origin;
}

export function loadConfig(env = process.env) {
  const mode = env.CONTRACTER_MODE || 'mock';
  need(['mock', 'live'].includes(mode), 500, 'CONFIG_MODE', 'CONTRACTER_MODE debe ser mock o live.');
  const port = Number(env.CONTRACTER_PORT || 8780);
  need(Number.isInteger(port) && port >= 0 && port <= 65535, 500, 'CONFIG_PORT', 'Puerto inválido.');
  const token = env.CONTRACTER_DASHBOARD_TOKEN || '';
  need(!token || (filled(token) && token.length >= 32), 500, 'CONFIG_TOKEN', 'El token del gateway requiere al menos 32 caracteres.');
  const provider = mode === 'live' ? 'supabase' : 'sqlite';
  const secret = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  const storeReadToken = env.CONTRACTER_STORE_READ_TOKEN || '';
  need(!storeReadToken || /^[0-9a-f]{64}$/.test(storeReadToken), 500, 'CONFIG_STORE_READ_TOKEN',
    'El token de lectura requiere 64 caracteres hexadecimales.');
  const evaluationCaseId = (env.CONTRACTER_DASHBOARD_EVALUATION_CASE_ID || '').toLowerCase();
  need(!evaluationCaseId || (mode === 'live' && storeReadToken && UUID.test(evaluationCaseId)),
    500, 'CONFIG_EVALUATION_CASE', 'El panel de evaluación requiere un expediente UUID y lectura privada en modo live.');
  let supabaseUrl = '';
  if (filled(env.SUPABASE_URL)) {
    const u = new URL(env.SUPABASE_URL);
    need(u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash,
      500, 'CONFIG_SUPABASE_URL', 'SUPABASE_URL debe ser el origen HTTPS del proyecto.');
    supabaseUrl = u.origin;
  }
  const supabaseConfigured = Boolean(supabaseUrl && (filled(secret) || storeReadToken));
  need(mode !== 'live' || (supabaseConfigured && token), 500, 'LIVE_NOT_CONFIGURED',
    'Live requiere Supabase y autenticación del gateway. No se utiliza SQLite como reemplazo.');
  const origins = (env.CONTRACTER_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).map(normalizeOrigin);
  const elevenBranch = env.ELEVENLABS_AGENT_BRANCH_ID || '';
  need(!elevenBranch || /^[A-Za-z0-9_-]{1,120}$/.test(elevenBranch), 500,
    'CONFIG_VOICE_BRANCH', 'ELEVENLABS_AGENT_BRANCH_ID debe ser un identificador de rama.');
  const voiceEnabled = env.ELEVENLABS_ENABLED === 'true';
  const elevenKey = filled(env.ELEVENLABS_API_KEY) ? env.ELEVENLABS_API_KEY : '';
  const elevenAgent = filled(env.ELEVENLABS_AGENT_ID) ? env.ELEVENLABS_AGENT_ID : '';
  const liveVoiceContext = mode === 'live' && env.CONTRACTER_VOICE_LIVE_CONTEXT_ENABLED === 'true';
  const voiceChatId = liveVoiceContext ? env.CONTRACTER_TELEGRAM_CHAT_ID || '' : '';
  const voiceStoreToken = liveVoiceContext ? env.CONTRACTER_STORE_TELEGRAM_TOKEN || '' : '';
  need(!liveVoiceContext || (voiceEnabled && elevenKey && /^agent_[A-Za-z0-9_]+$/.test(elevenAgent) && elevenBranch
    && !evaluationCaseId && storeReadToken && /^[0-9a-f]{64}$/.test(voiceStoreToken)
    && voiceStoreToken !== storeReadToken && /^[1-9][0-9]{0,15}$/.test(voiceChatId)),
    500, 'CONFIG_LIVE_VOICE_CONTEXT',
    'La voz con expediente requiere una rama de ElevenLabs, lectura privada y un chat de Telegram autorizado con token propio.');
  const operatorEnabled = env.CONTRACTER_OPERATOR_ENABLED === 'true';
  const operatorToken = operatorEnabled ? env.CONTRACTER_OPERATOR_TOKEN || '' : '';
  need(!operatorEnabled || (/^[A-Za-z0-9_-]{32,128}$/.test(operatorToken) && filled(operatorToken)
    && operatorToken !== token), 500, 'CONFIG_OPERATOR_TOKEN',
  'Configura un token de operación privado y distinto del token de lectura.');
  return Object.freeze({
    mode, port, host: '127.0.0.1', token, provider, supabaseUrl, supabaseSecret: filled(secret) ? secret : '',
    supabaseConfigured, storeReadToken, evaluationCaseId, allowedOrigins: new Set(origins),
    operatorToken, operatorEnv: operatorEnabled ? Object.freeze(Object.fromEntries(Object.entries(env)
      .filter(([name]) => /^CONTRACTER_(OPERATOR_|TELEGRAM_|STORE_|GEMINI_)/.test(name)))) : null,
    sqlitePath: env.CONTRACTER_SQLITE_PATH || resolve(ROOT, 'backend/data/mock.sqlite'),
    voiceEnabled, elevenKey, elevenAgent, elevenBranch, liveVoiceContext, voiceChatId, voiceStoreToken,
    legalEnabled: env.CONTRACTER_LEGAL_RAG_ENABLED === 'true',
    configuredServices: {
      llm: Boolean(filled(env.LLM_BASE_URL) && filled(env.LLM_API_KEY) && filled(env.LLM_MODEL)),
      n8n: Boolean(filled(env.N8N_BASE_URL)),
      telegram: Boolean(filled(env.TELEGRAM_BOT_TOKEN)),
    },
  });
}

function checkCase(data, expectedId, mode) {
  need(data && data.schema_version === '1.0.0' && data.case_id === expectedId && data.mode === mode,
    502, 'INVALID_CASE', 'El expediente no corresponde al identificador, esquema o modo solicitado.');
  for (const version of ['v1', 'v2']) {
    const v = data.versions?.[version];
    need(v && typeof v.text === 'string' && createHash('sha256').update(v.text).digest('hex') === v.sha256,
      502, 'INVALID_CASE_HASH', 'La integridad del texto contractual no coincide con su huella.');
  }
  need(data.human_approval?.required === true, 502, 'INVALID_CASE', 'Falta el control de aprobación humana.');
  if (mode === 'mock') need(data.human_approval.status === 'PENDING' && data.fury?.released === false,
    502, 'MOCK_APPROVAL_INVALID', 'Una fixture mock no puede atribuirse firma humana.');
  return data;
}

function demoVoiceBrief(voiceCase, config) {
  if (config.mode === 'mock') {
    const explanation = voiceCase.reports?.glenn?.explanation;
    if (typeof explanation !== 'string' || !explanation.trim()) return null;
    return 'Caso simulado de Contracter. ' + explanation.replace(/\s+/g, ' ').trim().slice(0, 600);
  }
  if (config.evaluationCaseId !== voiceCase.case_id || voiceCase.evaluation !== true
      || voiceCase.human_approval?.status !== 'PENDING' || voiceCase.fury?.released !== false) return null;
  const changes = Array.isArray(voiceCase.changelog) ? voiceCase.changelog.length : 0;
  return 'Expediente de evaluación de Contracter. ' + (changes === 1
    ? 'La propuesta V2 registra un cambio.' : 'La propuesta V2 registra ' + changes + ' cambios.')
    + ' La revisión humana sigue pendiente. La conversación sólo recibe este resumen de estado.';
}

function privateVoiceBrief(voiceCase) {
  const changes = Array.isArray(voiceCase.changelog) ? voiceCase.changelog.length : 0;
  const sources = Array.isArray(voiceCase.jurisdiction?.sources) ? voiceCase.jurisdiction.sources.length : 0;
  const approval = voiceCase.human_approval;
  let status = 'La decisión de revisión humana no pudo confirmarse.';
  if (approval.status === 'PENDING' && voiceCase.fury?.released === false) {
    status = 'La revisión humana sigue pendiente.';
  } else if (approval.approved_sha256 === voiceCase.versions.v2.sha256) {
    if (approval.status === 'APPROVED' && voiceCase.fury?.released === true) {
      status = 'El expediente registra aprobación humana de esta V2.';
    } else if (approval.status === 'REJECTED' && voiceCase.fury?.released === false) {
      status = 'El expediente registra rechazo de esta V2 en la revisión humana.';
    }
  }
  return `Expediente privado autorizado de Contracter. El sistema conservó la V1 y guardó una propuesta V2. Cambios registrados: ${changes}. Fuentes registradas: ${sources}. ${status} Este resumen sólo contiene el estado del expediente.`;
}

export function openMockStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS mock_cases(case_id TEXT PRIMARY KEY, payload TEXT NOT NULL, loaded_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mock_agent_outputs(case_id TEXT NOT NULL REFERENCES mock_cases(case_id), agent TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source='sample_fixture'), payload TEXT NOT NULL, PRIMARY KEY(case_id,agent));
    CREATE TABLE IF NOT EXISTS mock_cost_events(event_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES mock_cases(case_id),
      payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS legal_source_catalog(source_id TEXT PRIMARY KEY, payload TEXT NOT NULL, loaded_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gateway_events(id INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL, kind TEXT NOT NULL, case_id TEXT);
  `);
  return {
    seed(sample, catalog) {
      checkCase(sample, sample.case_id, 'mock');
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO mock_cases VALUES(?,?,?) ON CONFLICT(case_id) DO UPDATE SET payload=excluded.payload,loaded_at=excluded.loaded_at')
          .run(sample.case_id, JSON.stringify(sample), now());
        const outputs = {
          Afton: sample.security, Fury: sample.fury, House: sample.house, Jane: sample.context,
          Sherlock: sample.jurisdiction, Hamilton: sample.versions.v2, Jarvis: sample.changelog,
          Watson: sample.reports.watson, Glenn: sample.reports.glenn,
          ...Object.fromEntries(sample.audits.map(a => [a.agent, a])),
        };
        const insertOutput = db.prepare('INSERT INTO mock_agent_outputs VALUES(?,?,?,?) ON CONFLICT(case_id,agent) DO UPDATE SET payload=excluded.payload');
        for (const [agent, value] of Object.entries(outputs)) insertOutput.run(sample.case_id, agent, 'sample_fixture', JSON.stringify(value));
        const insertCost = db.prepare('INSERT INTO mock_cost_events VALUES(?,?,?) ON CONFLICT(event_id) DO UPDATE SET payload=excluded.payload');
        for (const event of sample.costs.events) insertCost.run(event.event_id, sample.case_id, JSON.stringify(event));
        const insertSource = db.prepare('INSERT INTO legal_source_catalog VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET payload=excluded.payload,loaded_at=excluded.loaded_at');
        for (const source of catalog.sources || []) insertSource.run(source.source_id, JSON.stringify(source), now());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async getCase(id) { const row = db.prepare('SELECT payload FROM mock_cases WHERE case_id=?').get(id); return row ? JSON.parse(row.payload) : null; },
    log(kind, caseId = null) { db.prepare('INSERT INTO gateway_events(occurred_at,kind,case_id) VALUES(?,?,?)').run(now(), kind, caseId); },
    counts() { return { cases: db.prepare('SELECT count(*) AS n FROM mock_cases').get().n,
      outputs: db.prepare('SELECT count(*) AS n FROM mock_agent_outputs').get().n,
      costs: db.prepare('SELECT count(*) AS n FROM mock_cost_events').get().n,
      sources: db.prepare('SELECT count(*) AS n FROM legal_source_catalog').get().n }; },
    close() { db.close(); },
  };
}

async function boundedJson(response, { limit = MAX_JSON_BYTES, allowNotFound = false } = {}) {
  need(response.ok || (allowNotFound && response.status === 404), 502,
    'PROVIDER_RESPONSE', 'El proveedor rechazó la solicitud. Revise su configuración privada.');
  const reader = response.body?.getReader();
  need(reader, 502, 'PROVIDER_RESPONSE', 'El proveedor no devolvió contenido JSON.');
  let total = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      need(total <= limit, 502, 'PROVIDER_TOO_LARGE', 'La respuesta del proveedor supera el límite permitido.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new GatewayError(502, 'PROVIDER_JSON', 'El proveedor devolvió JSON inválido.'); }
}

export function createSupabaseAdapter(config, fetchFn = fetch) {
  need(config.supabaseConfigured && config.supabaseSecret, 503, 'DATABASE_UNCONFIGURED', 'Supabase aún no está configurado.');
  const headers = { apikey: config.supabaseSecret, Accept: 'application/json' };
  // Modern sb_secret_ keys are not JWTs. Only the legacy JWT uses Bearer.
  if (!config.supabaseSecret.startsWith('sb_secret_')) headers.Authorization = `Bearer ${config.supabaseSecret}`;
  const request = async (path, options = {}) => {
    const response = await fetchFn(new URL(path, config.supabaseUrl), {
      ...options, headers: { ...headers, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    return boundedJson(response);
  };
  return {
    async getCase(id) {
      const path = `/rest/v1/cases?select=case_json&id_caso=eq.${encodeURIComponent(id)}&limit=2`;
      const rows = await request(path);
      need(Array.isArray(rows) && rows.length <= 1, 502, 'DATABASE_RESULT', 'Resultado de expediente inesperado.');
      return rows[0]?.case_json || null;
    },
    async searchLegal(args) {
      const rows = await request('/rest/v1/rpc/legal_search_fts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
      });
      need(Array.isArray(rows) && rows.length <= args.p_limit, 502, 'DATABASE_RESULT', 'Resultado de búsqueda inesperado.');
      return rows;
    },
    log() {}, // Access telemetry belongs in the private host logger; no private payloads logged here.
    close() {},
  };
}

export function createScopedReadAdapter(config, fetchFn = fetch) {
  const url = new URL('/functions/v1/contracter-store', config.supabaseUrl);
  need(/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) && config.storeReadToken, 500,
    'CONFIG_STORE_URL', 'La lectura con alcance requiere el origen oficial del proyecto Supabase.');
  const legalSearch = config.legalEnabled && config.supabaseSecret
    ? { searchLegal: createSupabaseAdapter(config, fetchFn).searchLegal }
    : {};
  async function readStoredCase(caseId, audience, accessToken, ownerChatId) {
    const body = { operation: 'get_case', audience, case_id: caseId };
    if (ownerChatId) body.owner_chat_id = ownerChatId;
    const response = await fetchFn(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await boundedJson(response, { allowNotFound: true });
    if (response.status === 404) {
      need(result?.error === 'CASE_NOT_FOUND', 502, 'STORE_UNAVAILABLE',
        'El servicio privado de expedientes no está disponible.');
      return null;
    }
    need(result && typeof result.synthetic === 'boolean' && result.case?.case_id === caseId, 502,
      'DATABASE_RESULT', 'Resultado de expediente inesperado.');
    return result;
  }
  return {
    async getCase(caseId) {
      if (config.evaluationCaseId && caseId !== config.evaluationCaseId) return null;
      const result = await readStoredCase(caseId, 'dashboard', config.storeReadToken);
      if (!result) return null;
      if (config.evaluationCaseId) {
        return result.synthetic && result.case.human_approval?.status === 'PENDING'
          && result.case.fury?.released === false ? { ...result.case, evaluation: true } : null;
      }
      return result.synthetic ? null : result.case;
    },
    async getVoiceCase(caseId) {
      if (!config.liveVoiceContext) return null;
      const result = await readStoredCase(caseId, 'telegram', config.voiceStoreToken, config.voiceChatId);
      return result?.synthetic === false ? result.case : null;
    },
    ...legalSearch,
    log() {},
    close() {},
  };
}

async function readBody(req) {
  need((req.headers['content-type'] || '').split(';')[0].trim() === 'application/json',
    415, 'JSON_REQUIRED', 'Se requiere application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    need(size <= 4096, 413, 'BODY_TOO_LARGE', 'Solicitud demasiado grande.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    need(body && typeof body === 'object' && !Array.isArray(body), 400, 'INVALID_BODY', 'Se requiere un objeto JSON.');
    return body;
  } catch (e) { if (e instanceof GatewayError) throw e; throw new GatewayError(400, 'INVALID_JSON', 'JSON inválido.'); }
}
function authenticate(req, token) {
  need(token, 401, 'AUTH_UNCONFIGURED', 'Configure el token privado del gateway para leer expedientes.');
  const value = req.headers.authorization || '';
  const supplied = Buffer.from(value);
  const expected = Buffer.from(`Bearer ${token}`);
  need(supplied.length === expected.length && timingSafeEqual(supplied, expected), 401, 'UNAUTHORIZED', 'Autenticación requerida.');
}
function searchArgs(body) {
  need(Object.keys(body).every(k => ['query','entity_code','municipality_code','as_of','limit'].includes(k)),
    400, 'INVALID_FILTER', 'Filtro desconocido; no se permite recuperar borradores sin revisión.');
  need(typeof body.query === 'string' && body.query.trim().length >= 3 && body.query.length <= 500,
    400, 'INVALID_QUERY', 'La consulta requiere entre 3 y 500 caracteres.');
  const entity = body.entity_code ?? null;
  need(entity === null || /^(0[1-9]|[12]\d|3[0-2])$/.test(entity), 400, 'INVALID_ENTITY', 'Entidad inválida.');
  const municipality = body.municipality_code ?? null;
  need(municipality === null || (entity && /^\d{3}$/.test(municipality)), 400, 'INVALID_MUNICIPALITY', 'El municipio requiere código de entidad y tres dígitos.');
  const date = body.as_of || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  need(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(date).valueOf()) && new Date(date).toISOString().slice(0,10) === date,
    400, 'INVALID_DATE', 'La fecha de referencia debe ser YYYY-MM-DD.');
  const limit = body.limit ?? 8;
  need(Number.isInteger(limit) && limit >= 1 && limit <= 20, 400, 'INVALID_LIMIT', 'Límite entre 1 y 20.');
  return { p_query: body.query.trim(), p_country_code: 'MX', p_entity_code: entity,
    p_municipality_code: municipality, p_as_of: date, p_limit: limit, p_include_unreviewed: false };
}

export async function createGateway({ config = loadConfig(), fetchFn = fetch, store: suppliedStore,
  operatorFactory = createOperatorSwitch,
  docsRoot = resolve(ROOT, 'docs'), catalogPath = resolve(ROOT, 'legal_sources/catalog.json') } = {}) {
  const operator = config.operatorEnv ? operatorFactory({ env: config.operatorEnv, fetchFn }) : null;
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const sample = config.mode === 'mock'
    ? JSON.parse(await readFile(resolve(ROOT, 'docs/data/sample_case.json'), 'utf8')) : null;
  let store = suppliedStore;
  if (!store) {
    if (config.mode === 'mock') {
      if (config.sqlitePath !== ':memory:') await mkdir(dirname(resolve(config.sqlitePath)), { recursive: true });
      store = openMockStore(config.sqlitePath);
      store.seed(sample, catalog);
    } else store = config.storeReadToken
      ? createScopedReadAdapter(config, fetchFn) : createSupabaseAdapter(config, fetchFn);
  }
  const docs = await realpath(docsRoot);
  const voiceWindow = [];
  const voiceConfigured = Boolean(config.voiceEnabled && config.token && config.elevenKey
    && /^agent_[A-Za-z0-9_]+$/.test(config.elevenAgent));
  const configured = (value, extra = {}) => ({ status: value ? 'configured' : 'unconfigured',
    connectivity_verified: false, ...extra });
  const health = () => ({ status: 'degraded', mode: config.mode, checked_at: now(),
    services: {
      ...Object.fromEntries(Object.entries(config.configuredServices).map(([k,v]) => [k, configured(v)])),
      database: configured(true, { provider: config.provider, local_fixture_only: config.mode === 'mock' }),
      elevenlabs: configured(voiceConfigured, { enabled: config.voiceEnabled,
        live_case_context: voiceConfigured && config.liveVoiceContext && typeof store.getVoiceCase === 'function' }),
      legal_sources: { status: 'unconfigured', retrieval_configured: config.mode === 'live' && config.legalEnabled && Boolean(store.searchLegal),
        coverage: catalog.coverage?.status || 'unknown', catalogued_sources: catalog.sources?.length || 0,
        catalogued_entities: catalog.entities?.length || 0, last_sync_at: null, corpus_ingested: false,
        note: 'Catálogo de procedencia; la ingestión y vigencia jurídica no están acreditadas por este gateway.' },
    },
    note: 'Configured sólo indica configuración presente, no una prueba de conexión ni de validez jurídica.',
  });
  const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
    '.mjs':'text/javascript; charset=utf-8',
    '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.ico':'image/x-icon' };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const json = (status, payload) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); };
    try {
      const ownOrigin = `http://127.0.0.1:${server.address()?.port || config.port}`;
      const localOrigins = new Set([ownOrigin, ownOrigin.replace('127.0.0.1','localhost')]);
      need(localOrigins.has(`http://${req.headers.host}`), 421, 'INVALID_HOST', 'Host no permitido. Use el servidor loopback.');
      const origin = req.headers.origin;
      if (origin) {
        need(localOrigins.has(origin) || config.allowedOrigins.has(origin), 403, 'ORIGIN_DENIED', 'Origen no permitido.');
        if (!localOrigins.has(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary','Origin'); }
      }
      if (req.method === 'OPTIONS') {
        need(Boolean(origin), 403, 'ORIGIN_REQUIRED', 'Falta el origen de la solicitud.');
        res.writeHead(204, { 'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers':'Authorization, Content-Type', 'Access-Control-Max-Age':'600' }); res.end(); return;
      }
      const url = new URL(req.url, ownOrigin);
      const path = url.pathname.replace(/^\/api(?=\/)/, '');
      if (path === '/operator') {
        need(['GET', 'POST'].includes(req.method), 405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
        need(operator, 503, 'OPERATOR_UNCONFIGURED', 'El selector de operador requiere configurar el servidor local.');
        authenticate(req, config.operatorToken);
        need(!origin || localOrigins.has(origin), 403, 'ORIGIN_DENIED', 'Usa el selector desde el panel local.');
        if (req.method === 'GET') { json(200, await operator.status()); return; }
        need(localOrigins.has(origin), 403, 'ORIGIN_REQUIRED', 'Abre el selector en el panel local.');
        const body = await readBody(req);
        need(Object.keys(body).length === 1 && ['n8n', 'node'].includes(body.target),
          400, 'INVALID_OPERATOR', 'Selecciona n8n o el motor Node.js.');
        json(200, await operator.select(body.target)); return;
      }
      if (path === '/health' && req.method === 'GET') {
        if (config.token) authenticate(req, config.token);
        const data = health();
        if (!config.token) { data.authentication = 'unconfigured'; for (const service of Object.values(data.services)) service.status = 'unknown'; }
        json(200, data); return;
      }
      const caseMatch = path.match(/^\/cases\/([^/]+)$/);
      if (caseMatch && req.method === 'GET') {
        // The default mock is the same public fixture served in docs/data.
        // A configured token is still enforced; live always requires authentication.
        if (config.mode === 'live' || config.token) authenticate(req, config.token);
        need(UUID.test(caseMatch[1]), 400, 'INVALID_CASE_ID', 'Identificador de expediente inválido.');
        const data = await store.getCase(caseMatch[1].toLowerCase());
        need(data, 404, 'CASE_NOT_FOUND', 'Expediente no encontrado.');
        checkCase(data, caseMatch[1].toLowerCase(), config.mode);
        store.log('case_read', data.case_id);
        json(200, data); return;
      }
      if (path === '/legal/search' && req.method === 'POST') {
        authenticate(req, config.token);
        need(Boolean(origin), 403, 'ORIGIN_REQUIRED', 'La consulta requiere un origen permitido.');
        const args = searchArgs(await readBody(req));
        need(config.mode === 'live' && config.legalEnabled && config.supabaseConfigured && store.searchLegal,
          503, 'LEGAL_UNCONFIGURED', 'La búsqueda legal todavía no está habilitada.');
        const results = await store.searchLegal(args);
        json(200, { query: args.p_query, country_code: 'MX', as_of: args.p_as_of, checked_at: now(), results,
          source: 'supabase_fts', note: 'Recuperación documental revisada; no garantiza cobertura total ni constituye un dictamen jurídico.' }); return;
      }
      if (path === '/voice/session' && req.method === 'POST') {
        authenticate(req, config.token);
        need(Boolean(origin), 403, 'ORIGIN_REQUIRED', 'La voz requiere un origen permitido.');
        const body = await readBody(req);
        need(Object.keys(body).every(key => key === 'case_id' || key === 'share_case_summary')
          && typeof body.case_id === 'string' && UUID.test(body.case_id)
          && (!own(body, 'share_case_summary') || typeof body.share_case_summary === 'boolean'),
          400, 'INVALID_BODY', 'Se requiere case_id válido. El agente y el propietario del expediente se fijan en el servidor.');
        need(voiceConfigured, 503, 'VOICE_UNCONFIGURED', 'ElevenLabs aún no está habilitado para este gateway.');
        if (config.liveVoiceContext) {
          need(body.share_case_summary === true, 400, 'VOICE_CONSENT_REQUIRED',
            'Confirma que deseas compartir con ElevenLabs un resumen limitado del expediente.');
          need(typeof store.getVoiceCase === 'function', 503, 'VOICE_CONTEXT_UNCONFIGURED',
            'No se ha configurado la verificación del propietario para hablar sobre este expediente.');
        } else if (config.mode === 'live' && !config.evaluationCaseId) {
          need(body.share_case_summary !== true, 503, 'VOICE_CONTEXT_UNCONFIGURED',
            'La voz con expediente todavía no está habilitada para este gateway.');
        }
        const caseId = body.case_id.toLowerCase();
        const voiceCase = sample ? (sample.case_id === caseId ? sample : null)
          : config.liveVoiceContext ? await store.getVoiceCase(caseId) : await store.getCase(caseId);
        need(voiceCase, 404, 'CASE_NOT_FOUND', 'Expediente no encontrado.');
        checkCase(voiceCase, caseId, config.mode);
        const voiceContext = config.liveVoiceContext ? privateVoiceBrief(voiceCase) : demoVoiceBrief(voiceCase, config);
        const cutoff = Date.now() - 60000;
        while (voiceWindow.length && voiceWindow[0] < cutoff) voiceWindow.shift();
        need(voiceWindow.length < 3, 429, 'VOICE_RATE_LIMIT', 'Límite de sesiones de voz. Intente después de un minuto.');
        voiceWindow.push(Date.now());
        const endpoint = new URL('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url');
        endpoint.searchParams.set('agent_id', config.elevenAgent);
        endpoint.searchParams.set('include_conversation_id','true');
        if (config.elevenBranch) endpoint.searchParams.set('branch_id', config.elevenBranch);
        const response = await fetchFn(endpoint, { method:'GET', headers:{'xi-api-key':config.elevenKey},
          redirect:'error', signal:AbortSignal.timeout(10000) });
        const data = await boundedJson(response, { limit: 32768 });
        let signed;
        try { signed = new URL(data.signed_url); } catch { throw new GatewayError(502,'VOICE_RESPONSE','Respuesta de voz inválida.'); }
        need(signed.protocol === 'wss:' && signed.hostname === 'api.elevenlabs.io' &&
          (!signed.port || signed.port === '443') && signed.pathname === '/v1/convai/conversation' &&
          !signed.username && !signed.password && !signed.hash,
          502, 'VOICE_RESPONSE', 'Destino de voz no permitido.');
        // Do not log or persist signed URLs: they authorize a private conversation.
        json(200, { signed_url: signed.href, agent_id:config.elevenAgent, case_id:voiceCase.case_id,
          obtained_at:now(), single_use_requested:true, context_linked:voiceContext !== null,
          note:voiceContext ? 'Sesión de voz preparada con un resumen limitado.' : 'Sesión de voz preparada sin acceso al expediente.',
          ...(voiceContext ? { voice_context:voiceContext } : {}) }); return;
      }
      need(req.method === 'GET' || req.method === 'HEAD', 405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
      need(!url.search && !url.hash, 400, 'STATIC_QUERY_DENIED', 'Los archivos estáticos no aceptan parámetros.');
      const relative = decodeURIComponent(url.pathname) === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      need(!relative.split(/[\\/]/).some(part => !part || part.startsWith('.')), 404, 'NOT_FOUND', 'Archivo no encontrado.');
      const candidate = resolve(docs, relative);
      need(candidate.startsWith(docs + sep), 404, 'NOT_FOUND', 'Archivo no encontrado.');
      const file = await realpath(candidate).catch(() => null);
      need(file && file.startsWith(docs + sep) && mime[extname(file)], 404, 'NOT_FOUND', 'Archivo no encontrado.');
      // docs/data contains only the public mock fixture. Private cases live in the DB.
      need(!relative.startsWith('data/') || (relative === 'data/sample_case.json' && config.mode === 'mock'),
        404, 'NOT_FOUND', 'Expedientes privados sólo a través de la API autenticada.');
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type':mime[extname(file)] });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const operatorError = error?.name === 'OperatorSwitchError';
      const trustedError = error instanceof GatewayError || operatorError;
      const status = trustedError ? error.status : 502;
      const code = trustedError ? error.code : 'GATEWAY_ERROR';
      json(status, { error:code, message:trustedError ? error.message : 'Error del gateway; revise la configuración privada.' });
    }
  });
  return { server, config, store, health, async close() {
    try { await new Promise((ok, fail) => server.close(e => e ? fail(e) : ok())); }
    finally {
      try { await operator?.close(); } finally { store.close(); }
    }
  } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const gateway = await createGateway();
    gateway.server.listen(gateway.config.port, gateway.config.host, () => {
      console.log(`Contracter: http://127.0.0.1:${gateway.server.address().port} · modo ${gateway.config.mode}`);
      console.log('No se han probado conexiones externas. Configuración presente no equivale a conectividad.');
    });
    gateway.server.on('error', () => { console.error('No se pudo abrir el servidor loopback de Contracter.'); process.exitCode=1; gateway.store.close(); });
    const stop = () => gateway.close().then(() => process.exit(0)).catch(() => process.exit(1));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) {
    console.error(error instanceof GatewayError ? `${error.code}: ${error.message}` : 'No se pudo iniciar Contracter.');
    process.exitCode = 1;
  }
}
