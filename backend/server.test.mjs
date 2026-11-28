import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createGateway, loadConfig, openMockStore, createSupabaseAdapter } from './server.mjs';
import { createHandler, createRestRpc, sha256 } from '../integration/supabase/functions/contracter-store/index.ts';

const sample = JSON.parse(await readFile(new URL('../docs/data/sample_case.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(await readFile(new URL('../legal_sources/catalog.json', import.meta.url), 'utf8'));
const testToken = 'TEST-ONLY-NOT-A-PROVIDER-KEY-32-CHARACTERS';
const config = (extra = {}) => loadConfig({ CONTRACTER_MODE:'mock', CONTRACTER_PORT:'0',
  CONTRACTER_DASHBOARD_TOKEN:testToken, CONTRACTER_SQLITE_PATH:':memory:', ...extra });
const auth = { Authorization:`Bearer ${testToken}` };
async function launch(t, options = {}) {
  const app = await createGateway({ config:config(), ...options });
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  t.after(() => app.close());
  return { ...app, base:`http://127.0.0.1:${app.server.address().port}` };
}
const post = (base, body, headers = {}) => ({ method:'POST', headers:{ ...auth, Origin:base,
  'Content-Type':'application/json', ...headers }, body:JSON.stringify(body) });

test('configuración live falla cerrada sin Supabase/token y rechaza origen inseguro', () => {
  assert.throws(() => loadConfig({ CONTRACTER_MODE:'live' }), /Live requiere/);
  assert.throws(() => config({ CONTRACTER_ALLOWED_ORIGINS:'http://example.invalid' }), /HTTP sólo/);
  assert.throws(() => config({ CONTRACTER_DASHBOARD_TOKEN:'corto' }), /32 caracteres/);
  assert.throws(() => config({ ELEVENLABS_AGENT_BRANCH_ID:'branch&id=other' }), { code:'CONFIG_VOICE_BRANCH' });
  assert.throws(() => config({ CONTRACTER_OPERATOR_ENABLED:'true', CONTRACTER_OPERATOR_TOKEN:testToken }), { code:'CONFIG_OPERATOR_TOKEN' });
});

test('SQLite sólo conserva fixture identificada, 13 roles y eventos; seed idempotente', async () => {
  const store = openMockStore();
  try {
    store.seed(sample,catalog); store.seed(sample,catalog);
    assert.deepEqual(store.counts(), { cases:1, outputs:13, costs:13, sources:7 });
    assert.deepEqual(await store.getCase(sample.case_id),sample);
    assert.equal(await store.getCase('99999999-9999-4999-8999-999999999999'),null);
  } finally { store.close(); }
});

test('API requiere bearer, preserva hash y declara conexiones sin verificar', async t => {
  const {base} = await launch(t);
  assert.equal((await fetch(base+'/cases/'+sample.case_id)).status,401);
  assert.equal((await fetch(base+'/cases/'+sample.case_id,{headers:{Authorization:'Bearer incorrecto'}})).status,401);
  const response = await fetch(base+'/cases/'+sample.case_id,{headers:auth});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),sample);
  const health = await (await fetch(base+'/health',{headers:auth})).json();
  assert.equal(health.mode,'mock');
  assert.equal(health.services.legal_sources.corpus_ingested,false);
  assert.equal(health.services.database.connectivity_verified,false);
});

test('inicio mock sin claves permite su fixture pública y mantiene voz/RAG cerrados', async t => {
  const {base}=await launch(t,{config:config({CONTRACTER_DASHBOARD_TOKEN:''})});
  const response=await fetch(base+'/api/cases/'+sample.case_id);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),sample);
  const health=await (await fetch(base+'/api/health')).json();
  assert.equal(health.mode,'mock');
  assert.equal(health.authentication,'unconfigured');
  assert.equal((await fetch(base+'/api/legal/search',post(base,{query:'pago'}))).status,401);
  assert.equal((await fetch(base+'/api/voice/session',post(base,{case_id:sample.case_id}))).status,401);
  assert.equal((await fetch(base+'/api/operator')).status,503);
});

test('cambiar el operador requiere token propio, origen local y destino explícito', async t => {
  const token = 'operator-test-token-is-separate-32-characters';
  const auth = { Authorization:`Bearer ${token}` };
  const calls = [];
  const { base } = await launch(t, {
    config: config({ CONTRACTER_OPERATOR_ENABLED:'true', CONTRACTER_OPERATOR_TOKEN:token,
      CONTRACTER_ALLOWED_ORIGINS:'https://lectura.example.invalid' }),
    operatorFactory: () => ({
      async status() { return { active:'n8n', switching:false }; },
      async select(target) { calls.push(target); return { active:target, switching:false }; },
      async close() {},
    }),
  });
  const url = base + '/api/operator';
  assert.equal((await fetch(url, { headers:{ Authorization:`Bearer ${testToken}` } })).status, 401);
  assert.deepEqual(await (await fetch(url, { headers:auth })).json(), { active:'n8n', switching:false });
  assert.equal((await fetch(url, post(base,{ target:'node' },{ ...auth, Origin:'https://lectura.example.invalid' }))).status, 403);
  assert.equal((await fetch(url, post(base,{ target:'node', workflow_id:'otro' },auth))).status, 400);
  assert.deepEqual(calls, []);
  const response = await fetch(url, post(base,{ target:'node' },auth));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { active:'node', switching:false });
  assert.deepEqual(calls, ['node']);
});

test('host/origen ajenos, secretos y cuerpos incorrectos se bloquean', async t => {
  const {base} = await launch(t);
  assert.equal((await fetch(base+'/health',{headers:{...auth,Origin:'https://evil.invalid'}})).status,403);
  const forgedHostStatus = await new Promise((resolve,reject) => {
    const req=httpRequest(base+'/health',{headers:{...auth,Host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(forgedHostStatus,421);
  assert.equal((await fetch(base+'/.env')).status,404);
  assert.equal((await fetch(base+'/backend/server.mjs')).status,404);
  assert.equal((await fetch(base+'/voice/session',post(base,{}))).status,400);
  assert.equal((await fetch(base+'/voice/session',post(base,{case_id:sample.case_id}))).status,503);
  assert.equal((await fetch(base+'/legal/search',post(base,{query:'pago',p_include_unreviewed:true}))).status,400);
  assert.equal((await fetch(base+'/legal/search',post(base,{query:'pago',municipality_code:'001'}))).status,400);
});

test('Supabase usa sólo clave servidor, filtro de caso y RPC territorial explícita', async () => {
  const seen=[];
  const adapter=createSupabaseAdapter(config({SUPABASE_URL:'https://project.example.invalid',SUPABASE_SECRET_KEY:'sb_secret_TEST_ONLY'}),async (url,options) => {
    seen.push({url:String(url),options});
    return Response.json(String(url).includes('/rpc/')?[]:[{case_json:sample}]);
  });
  assert.deepEqual(await adapter.getCase(sample.case_id),sample);
  assert.deepEqual(await adapter.searchLegal({p_query:'pago',p_limit:8,p_include_unreviewed:false}),[]);
  assert.match(seen[0].url,/id_caso=eq\.11111111/);
  assert.equal(seen[0].options.headers.apikey,'sb_secret_TEST_ONLY');
  assert.equal(seen[0].options.headers.Authorization,undefined);
  assert.equal(JSON.parse(seen[1].options.body).p_include_unreviewed,false);
});

test('la lectura privada conserva V2 y distingue un expediente ausente del servicio ausente', async t => {
  const storeToken = 'a'.repeat(64);
  const digest = await sha256(storeToken);
  const live = { ...sample, mode: 'live' };
  const syntheticId = '22222222-2222-4222-8222-222222222222';
  const missingId = '99999999-9999-4999-8999-999999999999';
  let serviceAvailable = true;
  let reads = 0;
  const rpc = createRestRpc('https://database.invalid', 'fixture-only', async (url, options) => {
    const args = JSON.parse(options.body);
    if (url.pathname.endsWith('/contracter_runtime_authorize')) {
      return Response.json(args.p_scope === 'dashboard' && args.p_token_sha256 === digest);
    }
    assert.equal(url.pathname, '/rest/v1/rpc/contracter_get_case');
    assert.equal(args.p_owner_chat_id, null);
    reads++;
    if (args.p_case_id === missingId) {
      return Response.json({ code: 'PT404', message: 'CASE_NOT_FOUND' }, { status: 404 });
    }
    const synthetic = args.p_case_id === syntheticId;
    return Response.json({ case: { ...live, case_id: args.p_case_id }, status: 'AWAITING_HUMAN', synthetic });
  });
  const handler = createHandler(rpc);
  const { base } = await launch(t, {
    config: config({ CONTRACTER_MODE: 'live', SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
      CONTRACTER_STORE_READ_TOKEN: storeToken }),
    fetchFn: async (url, options) => {
      assert.equal(url.pathname, '/functions/v1/contracter-store');
      assert.equal(options.headers.Authorization, 'Bearer ' + storeToken);
      assert.equal(options.headers.apikey, undefined);
      if (!serviceAvailable) {
        return Response.json({ code: 'NOT_FOUND', message: 'PRIVATE_UPSTREAM_DETAIL' }, { status: 404 });
      }
      return handler(new Request(url, options));
    },
  });
  const getCase = (id, headers) => fetch(base + '/api/cases/' + id, { headers });
  assert.equal((await getCase(live.case_id)).status, 401);
  assert.equal(reads, 0);
  const response = await getCase(live.case_id, auth);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const received = await response.json();
  assert.deepEqual(received.versions.v2, live.versions.v2);
  assert.deepEqual(received.human_approval, live.human_approval);
  assert.equal((await getCase(syntheticId, auth)).status, 404);
  assert.equal((await getCase(missingId, auth)).status, 404);
  serviceAvailable = false;
  const unavailable = await getCase(live.case_id, auth);
  assert.equal(unavailable.status, 502);
  const error = await unavailable.json();
  assert.equal(error.error, 'STORE_UNAVAILABLE');
  assert.doesNotMatch(error.message, /PRIVATE_UPSTREAM_DETAIL/);
});

test('el panel combina la lectura privada y la búsqueda revisada con credenciales separadas', async t => {
  const readToken = 'a'.repeat(64);
  const serverKey = 'sb_secret_TEST_ONLY';
  const liveCase = { ...sample, mode: 'live' };
  const common = {
    CONTRACTER_MODE: 'live', SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
    CONTRACTER_STORE_READ_TOKEN: readToken,
  };
  const fetchFn = async (url, options) => {
    if (url.pathname === '/functions/v1/contracter-store') {
      assert.equal(options.headers.Authorization, 'Bearer ' + readToken);
      assert.equal(options.headers.apikey, undefined);
      assert.deepEqual(JSON.parse(options.body), {
        operation: 'get_case', audience: 'dashboard', case_id: liveCase.case_id,
      });
      return Response.json({ case: liveCase, synthetic: false });
    }
    assert.equal(url.pathname, '/rest/v1/rpc/legal_search_fts');
    assert.equal(options.headers.apikey, serverKey);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(JSON.parse(options.body).p_include_unreviewed, false);
    return Response.json([{ title: 'Fuente revisada de prueba' }]);
  };
  const { base } = await launch(t, {
    config: config({ ...common, CONTRACTER_LEGAL_RAG_ENABLED: 'true', SUPABASE_SECRET_KEY: serverKey }),
    fetchFn,
  });
  const record = await fetch(base + '/api/cases/' + liveCase.case_id, { headers: auth });
  assert.equal(record.status, 200);
  assert.deepEqual(await record.json(), liveCase);
  const search = await fetch(base + '/api/legal/search', post(base, { query: 'pago' }));
  assert.equal(search.status, 200);
  assert.deepEqual((await search.json()).results, [{ title: 'Fuente revisada de prueba' }]);
  const health = await fetch(base + '/api/health', { headers: auth });
  assert.equal((await health.json()).services.legal_sources.retrieval_configured, true);

  for (const options of [{ CONTRACTER_LEGAL_RAG_ENABLED: 'true' }, { SUPABASE_SECRET_KEY: serverKey }]) {
    const { base: restrictedBase } = await launch(t, {
      config: config({ ...common, ...options }),
      fetchFn: () => assert.fail('La búsqueda desactivada no debe consultar el proveedor'),
    });
    const blocked = await fetch(restrictedBase + '/api/legal/search', post(restrictedBase, { query: 'pago' }));
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).error, 'LEGAL_UNCONFIGURED');
  }
});

test('un panel de evaluación sólo muestra el expediente sintético autorizado', async t => {
  const storeToken = 'a'.repeat(64);
  const evaluationId = sample.case_id;
  const live = { ...sample, mode: 'live' };
  const settings = { CONTRACTER_MODE: 'live', SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
    CONTRACTER_STORE_READ_TOKEN: storeToken, CONTRACTER_DASHBOARD_EVALUATION_CASE_ID: evaluationId };
  assert.throws(() => config({ ...settings, CONTRACTER_STORE_READ_TOKEN: '' }), { code: 'CONFIG_EVALUATION_CASE' });
  let reads = 0;
  let result = { synthetic: true, case: live };
  const { base } = await launch(t, {
    config: config(settings),
    fetchFn: async (url, options) => {
      reads++;
      assert.equal(url.pathname, '/functions/v1/contracter-store');
      assert.equal(options.headers.Authorization, 'Bearer ' + storeToken);
      assert.equal(JSON.parse(options.body).case_id, evaluationId);
      return Response.json(result);
    },
  });
  const url = base + '/api/cases/' + evaluationId;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(base + '/api/cases/22222222-2222-4222-8222-222222222222', { headers: auth })).status, 404);
  assert.equal(reads, 0);
  const response = await fetch(url, { headers: auth });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...live, evaluation: true });
  result = { synthetic: false, case: live };
  assert.equal((await fetch(url, { headers: auth })).status, 404);
  result = { synthetic: true, case: { ...live, human_approval: { ...live.human_approval, status: 'APPROVED' } } };
  assert.equal((await fetch(url, { headers: auth })).status, 404);
  assert.equal(reads, 3);
});

test('voz valida acceso al caso, URL exacta, límites y no declara contexto enlazado', async t => {
  let calls=0;
  const live={...sample,mode:'live'};
  const cfg=config({CONTRACTER_MODE:'live',SUPABASE_URL:'https://project.example.invalid',
    SUPABASE_SECRET_KEY:'sb_secret_TEST_ONLY',ELEVENLABS_ENABLED:'true',
    ELEVENLABS_AGENT_ID:'agent_TEST_ONLY',ELEVENLABS_API_KEY:'TEST_ONLY'});
  const store={getCase:async id => id===sample.case_id?live:null,log(){},close(){}};
  const {base}=await launch(t,{config:cfg,store,fetchFn:async (url,options) => {
    calls++; assert.equal(new URL(url).hostname,'api.elevenlabs.io');
    assert.equal(options.headers['xi-api-key'],'TEST_ONLY');
    return Response.json({signed_url:'wss://api.elevenlabs.io/v1/convai/conversation?token=TEST_ONLY'});
  }});
  assert.equal((await fetch(base+'/voice/session',post(base,{case_id:'99999999-9999-4999-8999-999999999999'}))).status,404);
  assert.equal(calls,0);
  const response=await fetch(base+'/voice/session',post(base,{case_id:sample.case_id}));
  const payload=await response.json(); assert.equal(response.status,200);
  assert.equal(payload.case_id,sample.case_id); assert.equal(payload.context_linked,false);
  assert.equal('api_key' in payload,false);
  assert.equal('voice_context' in payload,false);
  await fetch(base+'/voice/session',post(base,{case_id:sample.case_id}));
  await fetch(base+'/voice/session',post(base,{case_id:sample.case_id}));
  assert.equal((await fetch(base+'/voice/session',post(base,{case_id:sample.case_id}))).status,429);
  assert.equal(calls,3);
  assert.equal((await fetch(base+'/data/sample_case.json')).status,404);
});

test('voz del caso de muestra requiere token, origen y habilitación y sólo comparte el resumen público', async t => {
  const agentKey = 'TEST_SERVER_VOICE_KEY';
  let calls = 0;
  const {base} = await launch(t, {
    config:config({ ELEVENLABS_ENABLED:'true', ELEVENLABS_AGENT_ID:'agent_TEST_ONLY',
      ELEVENLABS_AGENT_BRANCH_ID:'branch_TEST_ONLY', ELEVENLABS_API_KEY:agentKey }),
    fetchFn:async (url, options) => {
      calls++;
      assert.equal(url.origin, 'https://api.elevenlabs.io');
      assert.equal(url.pathname, '/v1/convai/conversation/get-signed-url');
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        agent_id:'agent_TEST_ONLY', include_conversation_id:'true', branch_id:'branch_TEST_ONLY',
      });
      assert.equal(options.headers['xi-api-key'], agentKey);
      assert.equal(options.body, undefined);
      return Response.json({ signed_url:'wss://api.elevenlabs.io/v1/convai/conversation?token=SIGNED_TEST' });
    },
  });
  const voice = base + '/api/voice/session';
  const input = { case_id:sample.case_id };
  const withoutOrigin = post(base, input);
  delete withoutOrigin.headers.Origin;
  assert.equal((await fetch(voice, withoutOrigin)).status, 403);
  assert.equal((await fetch(voice, post(base, input, { Authorization:'Bearer incorrecto' }))).status, 401);
  assert.equal((await fetch(voice, post(base, input, { Origin:'https://wrong.invalid' }))).status, 403);
  assert.equal((await fetch(voice, post(base, { ...input, voice_context:'Contenido de prueba del cliente' }))).status, 400);
  assert.equal((await fetch(voice, post(base, { case_id:'99999999-9999-4999-8999-999999999999' }))).status, 404);
  const health = await (await fetch(base + '/api/health', { headers:auth })).json();
  assert.equal(health.services.elevenlabs.status, 'configured');
  assert.equal(health.services.elevenlabs.connectivity_verified, false);
  assert.equal(calls, 0);
  const result = await fetch(voice, post(base, input));
  assert.equal(result.status, 200);
  const payload = await result.json();
  assert.equal(payload.case_id, sample.case_id);
  assert.equal(payload.context_linked, true);
  assert.equal(payload.voice_context, 'Caso simulado de Contracter. ' + sample.reports.glenn.explanation);
  assert.equal(JSON.stringify(payload).includes(agentKey), false);
  assert.equal('versions' in payload, false);
  assert.equal(calls, 1);
});

test('voz de evaluación live comparte sólo el estado del expediente sintético seleccionado', async t => {
  const confidential = 'contenido marcado para permanecer sólo en expediente';
  const live = { ...sample, mode:'live', reports:{ ...sample.reports, glenn:{ explanation:confidential } } };
  const storeToken = 'a'.repeat(64);
  let synthetic = true;
  let signedSessions = 0;
  const {base} = await launch(t, {
    config:config({ CONTRACTER_MODE:'live', SUPABASE_URL:'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
      CONTRACTER_STORE_READ_TOKEN:storeToken, CONTRACTER_DASHBOARD_EVALUATION_CASE_ID:sample.case_id,
      ELEVENLABS_ENABLED:'true', ELEVENLABS_AGENT_ID:'agent_TEST_ONLY', ELEVENLABS_API_KEY:'TEST_ONLY' }),
    fetchFn:async (url, options) => {
      if (url.hostname === 'aaaaaaaaaaaaaaaaaaaa.supabase.co') {
        assert.equal(JSON.parse(options.body).case_id, sample.case_id);
        return Response.json({ synthetic, case:live });
      }
      signedSessions++;
      assert.equal(url.hostname, 'api.elevenlabs.io');
      assert.equal(options.body, undefined);
      return Response.json({ signed_url:'wss://api.elevenlabs.io/v1/convai/conversation?token=SIGNED_TEST' });
    },
  });
  const voice = base + '/api/voice/session';
  assert.equal((await fetch(voice, post(base, { case_id:'99999999-9999-4999-8999-999999999999' }))).status, 404);
  assert.equal(signedSessions, 0);
  const res = await fetch(voice, post(base, { case_id:live.case_id }));
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.context_linked, true);
  assert.match(payload.voice_context, /Expediente de evaluación de Contracter/);
  assert.equal(payload.voice_context.includes(confidential), false);
  assert.equal(payload.voice_context.includes(sample.case_id), false);
  assert.equal(signedSessions, 1);
  synthetic = false;
  assert.equal((await fetch(voice, post(base, { case_id:live.case_id }))).status, 404);
  assert.equal(signedSessions, 1);
});

const liveVoiceSettings = {
  CONTRACTER_MODE: 'live', SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
  CONTRACTER_STORE_READ_TOKEN: '1'.repeat(64), CONTRACTER_STORE_TELEGRAM_TOKEN: '2'.repeat(64),
  CONTRACTER_TELEGRAM_CHAT_ID: '123', CONTRACTER_VOICE_LIVE_CONTEXT_ENABLED: 'true',
  ELEVENLABS_ENABLED: 'true', ELEVENLABS_AGENT_ID: 'agent_TEST_ONLY',
  ELEVENLABS_AGENT_BRANCH_ID: 'branch_TEST_ONLY', ELEVENLABS_API_KEY: 'TEST_VOICE',
};

test('voz privada exige rama, tokens de alcance distintos, chat privado y ausencia del modo evaluación', () => {
  for (const invalid of [
    { ELEVENLABS_AGENT_BRANCH_ID: '' },
    { CONTRACTER_STORE_READ_TOKEN: '', SUPABASE_SECRET_KEY: 'sb_secret_TEST_ONLY' },
    { CONTRACTER_STORE_TELEGRAM_TOKEN: liveVoiceSettings.CONTRACTER_STORE_READ_TOKEN },
    { CONTRACTER_TELEGRAM_CHAT_ID: '-123' },
    { CONTRACTER_DASHBOARD_EVALUATION_CASE_ID: sample.case_id },
  ]) {
    assert.throws(() => config({ ...liveVoiceSettings, ...invalid }), { code: 'CONFIG_LIVE_VOICE_CONTEXT' });
  }
});

test('voz privada comparte sólo estado de una V2 del chat configurado con consentimiento para esa sesión', async t => {
  const confidential = 'PRIVATE_CONTENT_NOT_FOR_PROVIDER';
  const caseId = sample.case_id;
  const live = { ...sample, mode: 'live', title: confidential,
    reports: { ...sample.reports, glenn: { explanation: confidential } } };
  let plan = 'missing';
  let reads = 0;
  let signedSessions = 0;
  const { base } = await launch(t, {
    config: config(liveVoiceSettings),
    fetchFn: async (url, options) => {
      if (url.origin === liveVoiceSettings.SUPABASE_URL) {
        reads++;
        assert.equal(options.headers.Authorization, 'Bearer ' + liveVoiceSettings.CONTRACTER_STORE_TELEGRAM_TOKEN);
        assert.deepEqual(JSON.parse(options.body), { operation: 'get_case', audience: 'telegram',
          case_id: caseId, owner_chat_id: liveVoiceSettings.CONTRACTER_TELEGRAM_CHAT_ID });
        if (plan === 'missing') return Response.json({ error: 'CASE_NOT_FOUND' }, { status: 404 });
        const rawCase = plan === 'tampered' ? { ...live, versions: { ...live.versions,
          v2: { ...live.versions.v2, text: confidential } } } : live;
        return Response.json({ synthetic: plan === 'synthetic', case: rawCase });
      }
      signedSessions++;
      assert.equal(url.origin, 'https://api.elevenlabs.io');
      assert.equal(url.searchParams.get('branch_id'), 'branch_TEST_ONLY');
      assert.equal(url.searchParams.has('case_id'), false);
      assert.equal(options.body, undefined);
      return Response.json({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?token=SIGNED_TEST' });
    },
  });
  const voice = base + '/api/voice/session';
  const health = await (await fetch(base + '/api/health', { headers: auth })).json();
  assert.equal(health.services.elevenlabs.live_case_context, true);
  assert.equal((await fetch(voice, post(base, { case_id: caseId }))).status, 400);
  assert.equal((await fetch(voice, post(base, { case_id: caseId, share_case_summary: false }))).status, 400);
  const input = { case_id: caseId, share_case_summary: true };
  assert.equal((await fetch(voice, post(base, input, { Authorization: 'Bearer incorrecto' }))).status, 401);
  assert.equal((await fetch(voice, post(base, { ...input, owner_chat_id: '999' }))).status, 400);
  assert.equal(reads, 0);
  assert.equal((await fetch(voice, post(base, input))).status, 404);
  plan = 'synthetic';
  assert.equal((await fetch(voice, post(base, input))).status, 404);
  plan = 'tampered';
  assert.equal((await fetch(voice, post(base, input))).status, 502);
  assert.equal(signedSessions, 0);
  plan = 'valid';
  const response = await fetch(voice, post(base, input));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.case_id, caseId);
  assert.equal(payload.context_linked, true);
  assert.match(payload.voice_context, /Expediente privado autorizado/);
  assert.match(payload.voice_context, /La revisión humana sigue pendiente/);
  assert.ok(payload.voice_context.length <= 700);
  assert.equal(payload.voice_context.includes(caseId), false);
  assert.equal(JSON.stringify(payload).includes(confidential), false);
  assert.equal(reads, 4);
  assert.equal(signedSessions, 1);
});

test('pedir contexto privado sin habilitarlo no abre una sesión de voz de respaldo', async t => {
  const { base } = await launch(t, {
    config: config({ ...liveVoiceSettings, CONTRACTER_VOICE_LIVE_CONTEXT_ENABLED: 'false' }),
    fetchFn: async () => assert.fail('No debe llamar al proveedor ni buscar el caso'),
  });
  const health = await (await fetch(base + '/api/health', { headers: auth })).json();
  assert.equal(health.services.elevenlabs.live_case_context, false);
  const response = await fetch(base + '/api/voice/session', post(base, { case_id: sample.case_id, share_case_summary: true }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'VOICE_CONTEXT_UNCONFIGURED');
});

test('voz rechaza subdominios ajenos y nunca imprime la respuesta secreta', async t => {
  const cfg=config({CONTRACTER_MODE:'live',SUPABASE_URL:'https://project.example.invalid',SUPABASE_SECRET_KEY:'sb_secret_TEST_ONLY',
    ELEVENLABS_ENABLED:'true',ELEVENLABS_AGENT_ID:'agent_TEST_ONLY',ELEVENLABS_API_KEY:'TEST_ONLY'});
  const {base}=await launch(t,{config:cfg,store:{getCase:async()=>({...sample,mode:'live'}),log(){},close(){}},
    fetchFn:async()=>Response.json({signed_url:'wss://api.elevenlabs.io.evil.invalid/v1/convai/conversation?secret=PRIVATE_TEST'})});
  const res=await fetch(base+'/voice/session',post(base,{case_id:sample.case_id}));
  assert.equal(res.status,502); assert.equal((await res.text()).includes('PRIVATE_TEST'),false);
});
