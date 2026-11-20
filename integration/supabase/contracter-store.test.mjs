import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createHandler, createRestRpc, sha256 } from './functions/contracter-store/index.ts';

const runId = '11111111-1111-4111-8111-111111111111';
const v2Hash = '2'.repeat(64);
const key = randomBytes(32).toString('hex');
const now = new Date('2026-11-08T12:34:56.789Z');
const testTokens = Object.fromEntries(['audit','approval','telegram','dashboard']
  .map(scope => [scope, randomBytes(32).toString('hex')]));
const tokenDigests = Object.fromEntries(await Promise.all(Object.entries(testTokens)
  .map(async ([scope, token]) => [scope, await sha256(token)])));

function fixture(handlers = {}, signingKey = key) {
  const calls = [];
  const handler = createHandler(async (name, args) => {
    calls.push([name, args]);
    if (name === 'contracter_runtime_authorize') return args.p_token_sha256 === tokenDigests[args.p_scope];
    assert.ok(handlers[name], `unexpected RPC ${name}`);
    return handlers[name](args);
  }, signingKey, () => now);
  return { calls, async post(body, token = testTokens.audit) {
    const res = await handler(new Request('https://example.invalid/functions/v1/contracter-store', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    return [res.status, await res.json()];
  } };
}

test('claim takes audit scope and normalized owner, persist preserves accounting without fake V2', async () => {
  const store = fixture({ contracter_claim_run: args => ({ accepted: true, ...args }),
    contracter_persist_run: args => args.p_request });
  const claim = { operation: 'claim_run', run_id: runId, synthetic: true, owner_chat_id: -1234 };
  assert.deepEqual(await store.post(claim, testTokens.approval), [401, { error: 'UNAUTHORIZED', retryable: false }]);
  assert.equal(store.calls.length, 1);
  assert.deepEqual(await store.post(claim), [200, {
    accepted: true, p_run_id: runId, p_synthetic: true, p_owner_chat_id: '-1234',
  }]);
  const persist = { ...claim, operation: 'persist', status: 'HELD', case: null,
    reason: 'PROVIDER_CREDIT_BALANCE_EXHAUSTED', agent_logs: [], usage_events: [] };
  assert.deepEqual(await store.post(persist), [200, {
    run_id: runId, status: 'HELD', synthetic: true, owner_chat_id: '-1234', case: null,
    reason: 'PROVIDER_CREDIT_BALANCE_EXHAUSTED', agent_logs: [], usage_events: [],
  }]);
  assert.equal((await store.post({ ...persist, case: { invented: true } }))[0], 400);
});

test('legal search always restricts to reviewed material and validates real dates', async () => {
  const store = fixture({ legal_search_fts: args => [args] });
  const legal = { operation: 'legal_search', p_query: 'prueba', p_country_code: 'MX',
    p_entity_code: '09', p_municipality_code: null, p_as_of: '2026-11-08', p_limit: 8, p_include_unreviewed: true };
  const [status, body] = await store.post(legal);
  assert.equal(status, 200);
  assert.equal(body.results[0].p_include_unreviewed, false);
  assert.equal((await store.post({ ...legal, p_as_of: '2026-02-30' }))[0], 400);
});

const documentaryQuery = {
  operation: 'legal_documental_search', query: 'entrega',
  jurisdiction: { country: 'MX', region: 'Federal', entity_code: null, municipality_code: null, as_of: '2026-11-19' },
};
const documentaryRow = {
  source_id: 'mx_diputados_ccom_pilot', title: 'Código de Comercio', locator: 'Página 12, bloque 1',
  source_url: 'https://www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf',
  excerpt: 'Texto documental literal.\nConserva sus signos y espacios.',
  review_status: 'pending', effectivity_status: 'unknown',
  raw_sha256: 'PRIVATE_HASH', original_storage_path: 'PRIVATE_STORAGE', internal: 'PRIVATE_DETAILS',
};

test('documentary search requires Telegram scope, caps literal quotes and returns only documentary fields', async () => {
  const rows = [0, 1, 2].map(index => ({ ...documentaryRow, locator: 'Página ' + (index + 1),
    excerpt: documentaryRow.excerpt + 'x'.repeat(500) }));
  const store = fixture({ legal_search_fts: args => {
    assert.equal(args.p_include_unreviewed, true);
    assert.equal(args.p_query, 'entrega');
    assert.equal(args.p_country_code, 'MX');
    assert.equal(args.p_limit, 3);
    return rows;
  } });
  for (const token of [testTokens.audit, testTokens.approval, testTokens.dashboard]) {
    assert.equal((await store.post(documentaryQuery, token))[0], 401);
  }
  const [status, body] = await store.post({ ...documentaryQuery, limit: 3 }, testTokens.telegram);
  assert.equal(status, 200);
  assert.equal(body.results.length, 2);
  assert.deepEqual(body.results[0], {
    title: rows[0].title, locator: rows[0].locator, url: rows[0].source_url,
    quote: rows[0].excerpt.slice(0, 450), review_status: 'pending', effectivity_status: 'unknown',
  });
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|source_id|storage|raw_sha256|version_id/);
});

test('documentary search filters unlisted sources, noncanonical URLs, rejected reviews and malformed excerpts', async () => {
  const invalid = [
    { ...documentaryRow, source_id: 'unlisted_source' },
    { ...documentaryRow, source_id: 'toString' },
    { ...documentaryRow, source_url: 'https://www.diputados.gob.mx.evil.invalid/LeyesBiblio/pdf/CCom.pdf' },
    { ...documentaryRow, source_url: documentaryRow.source_url + '?token=PRIVATE_TOKEN' },
    { ...documentaryRow, source_url: 'https://user:pass@www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf' },
    { ...documentaryRow, review_status: 'rejected' },
    { ...documentaryRow, effectivity_status: 'approved' },
    { ...documentaryRow, excerpt: { private: 'PRIVATE_DETAILS' } },
    { ...documentaryRow, excerpt: 'x'.repeat(3001) },
  ];
  for (const row of invalid) {
    const store = fixture({ legal_search_fts: () => [row] });
    assert.deepEqual(await store.post(documentaryQuery, testTokens.telegram), [200, { results: [] }]);
  }
  const duplicate = fixture({ legal_search_fts: () => [documentaryRow, documentaryRow] });
  assert.equal((await duplicate.post(documentaryQuery, testTokens.telegram))[1].results.length, 1);
});

test('documentary arguments enforce dates and territorial/limit bounds while formal search stays reviewed-only', async () => {
  const store = fixture({ legal_search_fts: () => [] });
  const invalid = [
    { limit: 0 }, { limit: 4 }, { limit: null }, { limit: 1.5 }, { query: 'x' },
    { query: 'x'.repeat(1001) }, { p_include_unreviewed: true },
    { jurisdiction: { ...documentaryQuery.jurisdiction, country: 'US' } },
    { jurisdiction: { ...documentaryQuery.jurisdiction, as_of: '2026-02-30' } },
    { jurisdiction: { ...documentaryQuery.jurisdiction, municipality_code: '001' } },
    { jurisdiction: { ...documentaryQuery.jurisdiction, region: 'Entidad sin clave' } },
    { jurisdiction: { ...documentaryQuery.jurisdiction, include_unreviewed: true } },
  ];
  for (const patch of invalid) assert.equal((await store.post({ ...documentaryQuery, ...patch }, testTokens.telegram))[0], 400);
  assert.ok(store.calls.every(([name]) => name === 'contracter_runtime_authorize'));
  assert.deepEqual(await store.post(documentaryQuery, testTokens.telegram), [200, { results: [] }]);
  assert.equal(store.calls.findLast(([name]) => name === 'legal_search_fts')[1].p_limit, 2);
  const formal = { operation: 'legal_search', p_query: 'entrega', p_country_code: 'MX', p_entity_code: null,
    p_municipality_code: null, p_as_of: '2026-11-19', p_limit: 2, p_include_unreviewed: true };
  await store.post(formal);
  assert.equal(store.calls.findLast(([name]) => name === 'legal_search_fts')[1].p_include_unreviewed, false);
  const malformed = fixture({ legal_search_fts: () => ({ results: [documentaryRow], private: 'PRIVATE_DETAILS' }) });
  assert.deepEqual(await malformed.post(documentaryQuery, testTokens.telegram),
    [502, { error: 'LEGAL_DOCUMENTAL_RESPONSE', retryable: true }]);
});

test('private read scopes separate dashboard and Telegram chat', async () => {
  const store = fixture({ contracter_get_case: args => args });
  const query = { operation: 'get_case', audience: 'telegram', case_id: runId, owner_chat_id: '-44' };
  assert.deepEqual(await store.post(query, testTokens.telegram), [200, { p_case_id: runId, p_owner_chat_id: '-44' }]);
  assert.equal((await store.post({ ...query, owner_chat_id: null }, testTokens.telegram))[0], 400);
  assert.equal((await store.post({ ...query, audience: 'dashboard' }, testTokens.telegram))[0], 401);
  assert.deepEqual(await store.post({ ...query, audience: 'dashboard' }, testTokens.dashboard),
    [200, { p_case_id: runId, p_owner_chat_id: null }]);
});

const sessionState = () => ({
  active: { case_id: runId, document: 'Contrato ficticio de prueba.', title: 'Muestra',
    context: {}, jurisdiction: { region: 'Federal', entity_code: null, municipality_code: null },
    turns: [], provider: 'gemini' },
  pending: { case_id: runId, attachment: { file_id: 'Telegram_file-123', file_size: 120 } },
});

test('temporary sessions use only Telegram scope and preserve explicit reset and revision fields', async () => {
  const store = fixture({
    contracter_get_telegram_session: args => ({ revision: 0, last_message_id: null, state: null, ...args }),
    contracter_save_telegram_session: args => ({ revision: args.p_expected_revision + 1,
      last_message_id: args.p_message_id, state: args.p_state }),
  });
  const get = { operation: 'get_telegram_session', owner_chat_id: 1234 };
  for (const token of [testTokens.audit, testTokens.approval, testTokens.dashboard]) {
    assert.equal((await store.post(get, token))[0], 401);
  }
  assert.deepEqual(await store.post(get, testTokens.telegram),
    [200, { revision: 0, last_message_id: null, state: null, p_owner_chat_id: '1234' }]);
  const state = sessionState();
  state.active.clarification = 'La entrega será parcial.';
  state.active.last_audit_status = 'CONTEXT_REQUIRED';
  state.active.turns = [{ question: '¿Quién compra?', answer: 'La compradora ficticia.' }];
  const save = { operation: 'save_telegram_session', owner_chat_id: '1234',
    expected_revision: 0, message_id: 12, state };
  assert.deepEqual(await store.post(save, testTokens.telegram),
    [200, { revision: 1, last_message_id: 12, state }]);
  assert.deepEqual(await store.post({ ...save, expected_revision: 1, message_id: 13, state: null }, testTokens.telegram),
    [200, { revision: 2, last_message_id: 13, state: null }]);
  assert.equal(store.calls.findLast(([name]) => name === 'contracter_save_telegram_session')[1].p_state, null);
});

test('session payload bounds reject extra fields, malformed history and unsafe message coordinates before SQL', async () => {
  const store = fixture({});
  const valid = { operation: 'save_telegram_session', owner_chat_id: '1234',
    expected_revision: 0, message_id: 1, state: sessionState() };
  const badStates = [
    { ...sessionState(), history: [] },
    { active: null },
    { ...sessionState(), active: { ...sessionState().active, document: 'x'.repeat(12001) } },
    { ...sessionState(), active: { ...sessionState().active, document: 'x\n'.repeat(1500) + 'x' } },
    { ...sessionState(), active: { ...sessionState().active, provider: ['gemini'] } },
    { ...sessionState(), active: { ...sessionState().active, clarification: 'x'.repeat(501) } },
    { ...sessionState(), active: { ...sessionState().active, last_audit_status: 'APPROVED' } },
    { ...sessionState(), active: { ...sessionState().active, context: { confirmed: 'true' } } },
    { ...sessionState(), active: { ...sessionState().active, turns: Array(4).fill({ question: 'q', answer: 'a' }) } },
    { ...sessionState(), active: { ...sessionState().active, turns: [{ question: 'q', answer: 'x'.repeat(1201) }] } },
    { ...sessionState(), active: { ...sessionState().active,
      jurisdiction: { region: 'Federal', entity_code: null, municipality_code: '001' } } },
    { ...sessionState(), active: { ...sessionState().active,
      jurisdiction: { ...sessionState().active.jurisdiction, as_of: '2026-02-30' } } },
    { ...sessionState(), pending: { case_id: runId, attachment: { file_id: 'abc', file_size: 36001 } } },
    { ...sessionState(), pending: { case_id: runId, attachment: { file_id: '../token', file_size: 120 } } },
  ];
  for (const state of badStates) assert.equal((await store.post({ ...valid, state }, testTokens.telegram))[0], 400);
  for (const patch of [{ message_id: 0 }, { message_id: 1.5 }, { message_id: 2147483648 },
    { expected_revision: -1 }, { expected_revision: '0' }, { owner_chat_id: '-1234' }, { extra: true }]) {
    assert.equal((await store.post({ ...valid, ...patch }, testTokens.telegram))[0], 400);
  }
  assert.ok(store.calls.every(([name]) => name === 'contracter_runtime_authorize'));
});

test('session CAS errors remain conflicts without returning submitted history', async () => {
  const rpc = createRestRpc('https://example.invalid', 'fixture-only', async url =>
    url.pathname.endsWith('contracter_runtime_authorize') ? Response.json(true) :
      Response.json({ code: 'PT409', message: 'SESSION_CONFLICT', details: 'private contract' }, { status: 409 }));
  const result = await createHandler(rpc)(new Request('https://example.invalid', { method: 'POST',
    headers: { authorization: 'Bearer ' + testTokens.telegram, 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'save_telegram_session', owner_chat_id: '1234',
      expected_revision: 0, message_id: 12, state: null }),
  }));
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), { error: 'SESSION_CONFLICT', retryable: false });
});

test('Telegram approval signs the exact checked V2 and only with approval scope', async () => {
  const store = fixture({ contracter_lookup_approval: () => ({ status: 'PENDING', case_id: runId, v2_sha256: v2Hash }),
    contracter_redeem_approval: args => args });
  const nonce = '3'.repeat(32);
  const update = { operation: 'redeem_approval', callback_query: {
    id: 'callback123', data: `ca:a:${nonce}`, from: { id: 22 }, message: { chat: { id: -44 } },
  } };
  assert.equal((await store.post(update, testTokens.audit))[0], 401);
  const [status, body] = await store.post(update, testTokens.approval);
  assert.equal(status, 200);
  assert.equal(body.p_nonce_sha256, await sha256(nonce));
  assert.equal(body.p_actor_id, '22');
  assert.equal(body.p_chat_id, '-44');
  const canonical = JSON.stringify({ approved_at: now.toISOString(), approved_sha256: v2Hash,
    approver: 'telegram:22', case_id: runId, evidence_reference: 'telegram-callback:callback123' });
  assert.equal(body.p_signature, createHmac('sha256', key).update(canonical).digest('hex'));
  const reject = { ...update, callback_query: { ...update.callback_query, data: `ca:r:${nonce}` } };
  const [, rejected] = await store.post(reject, testTokens.approval);
  assert.equal(rejected.p_signature, null);
});

test('unconfigured signer fails closed, settled callbacks replay without signing', async () => {
  const store = fixture({ contracter_lookup_approval: () => ({ status: 'APPROVED', case_id: runId,
    v2_sha256: v2Hash, replayed: true }) }, '');
  assert.deepEqual(await store.post({ operation: 'issue_approval', case_id: runId,
    chat_id: '-44', approver_id: '22' }, testTokens.approval),
    [503, { error: 'APPROVAL_SIGNER_DISABLED', retryable: true }]);
  const [status, replay] = await store.post({ operation: 'redeem_approval', callback_query: {
    id: 'callback123', data: `ca:a:${'3'.repeat(32)}`, from: { id: 22 }, message: { chat: { id: -44 } },
  } }, testTokens.approval);
  assert.equal(status, 200);
  assert.equal(replay.replayed, true);
});

test('busy is retryable while sensitive DB errors never return raw details', async () => {
  const body = { operation: 'claim_run', run_id: runId, synthetic: true };
  const request = () => new Request('https://example.invalid', { method: 'POST',
    headers: { authorization: `Bearer ${testTokens.audit}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const service = createRestRpc('https://example.invalid', 'fixture-only', async url =>
    url.pathname.endsWith('contracter_runtime_authorize') ? Response.json(true) :
      Response.json({ code: 'PT409', message: 'RUN_BUSY', details: 'private fields' }, { status: 409 }));
  const busy = await createHandler(service)(request());
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: 'RUN_BUSY', retryable: true });
  const untrusted = createRestRpc('https://example.invalid', 'fixture-only', async () =>
    Response.json({ code: 'unknown', message: 'contract excerpt' }, { status: 500 }));
  const failed = await createHandler(untrusted)(request());
  assert.deepEqual(await failed.json(), { error: 'RUNTIME_UNAVAILABLE', retryable: true });
});
