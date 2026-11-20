import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEMINI_MODEL, GEMINI_URL } from './live-transport.mjs';
import { createStandby, loadStandbyConfig } from './telegram-standby.mjs';

const chatId = '123456789';
const storeUrl = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/contracter-store';
const botToken = '123456789:' + 'A'.repeat(35);
const telegramToken = '1'.repeat(64);
const auditToken = '2'.repeat(64);
const geminiKey = 'AIza' + 'B'.repeat(35);
const env = {
  CONTRACTER_TELEGRAM_BOT_TOKEN: botToken,
  CONTRACTER_TELEGRAM_CHAT_ID: chatId,
  CONTRACTER_TELEGRAM_OWNER_ID: chatId,
  CONTRACTER_STORE_URL: storeUrl,
  CONTRACTER_STORE_TELEGRAM_TOKEN: telegramToken,
  CONTRACTER_STORE_AUDIT_TOKEN: auditToken,
  CONTRACTER_GEMINI_API_KEY: geminiKey,
};
const config = loadStandbyConfig(env);
const document = 'Acuerdo de suministro\n1. El pago vence en 30 días.';
const now = () => Date.parse('2026-11-19T18:00:00Z');

function message(id, content, actor = Number(chatId)) {
  return { update_id: id, message: { message_id: id, chat: { id: Number(chatId), type: 'private' },
    from: { id: actor }, ...content } };
}

function geminiAnswer(payload) {
  const input = JSON.parse(payload.contents[0].parts[0].text);
  const { properties } = payload.generationConfig.responseFormat.text.schema;
  let output;
  if (properties.limitations) output = { status: 'CLEAN', findings: [], limitations: [] };
  else if (properties.route) output = { route: 'QA' };
  else if (properties.target_agent) {
    assert.equal(input.structurally_clean, true);
    output = { phase: input.phase, target_agent: input.agent, status: 'CLEAN', anomaly_score: 0,
      clinical_notes: 'Salida de prueba válida.', interrogation_question: null, quarantine_action: 'NONE' };
  } else if (properties.agent_name) {
    const agent_name = input.new_finding_id_prefix.split('-')[0];
    const legal = agent_name === 'Murdock';
    output = { agent_name, iteration: input.iteration, reviewed_version: input.version, reviewed_sha256: input.sha256,
      consensus_reached: !legal, status_for_fury: legal ? 'REQUIERE_CAMBIOS' : 'ENTENDIDO',
      observations: [], previous_resolutions: [], reassurance_for_morty: [],
      ...(legal ? { legal_citations: [], required_standard_clauses: [], answer_citations: [] }
        : { answer: input.prior_conversation?.length ? 'El plazo pactado es de treinta días.' : 'El pago vence en 30 días.' }) };
  } else {
    assert(properties.operational_agents);
    output = { operational_agents: ['Harvey'], legal_source_ids: [] };
  }
  return Response.json({ modelVersion: GEMINI_MODEL,
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(output) }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 } });
}

function fixture({ webhook = false, conflict = false, answer = false, poll = () => assert.fail('Unexpected poll') } = {}) {
  let session = { revision: 0, last_message_id: null, state: null };
  const calls = [];
  const replies = [];
  const errors = [];
  const telegram = result => Response.json({ ok: true, result });
  const fetchFn = async (target, options = {}) => {
    const url = String(target);
    const payload = options.body ? JSON.parse(options.body) : null;
    const headers = new Headers(options.headers);
    if (url === GEMINI_URL) {
      calls.push('gemini');
      assert.equal(headers.get('x-goog-api-key'), geminiKey);
      assert.equal(headers.get('authorization'), null);
      if (answer) return geminiAnswer(payload);
      return Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, { status: 429 });
    }
    if (url === storeUrl) {
      calls.push(payload.operation);
      if (payload.operation !== 'legal_search') assert.equal(payload.owner_chat_id, chatId);
      switch (payload.operation) {
        case 'get_telegram_session':
          assert.equal(headers.get('authorization'), 'Bearer ' + telegramToken);
          return Response.json(session);
        case 'save_telegram_session':
          assert.equal(headers.get('authorization'), 'Bearer ' + telegramToken);
          assert.equal(payload.expected_revision, session.revision);
          if (conflict) return Response.json({}, { status: 409 });
          session = { revision: session.revision + 1, last_message_id: payload.message_id, state: payload.state };
          return Response.json(session);
        case 'claim_run':
          assert.equal(headers.get('authorization'), 'Bearer ' + auditToken);
          assert.equal(payload.synthetic, true);
          return Response.json({ accepted: true });
        case 'legal_search':
          assert.equal(headers.get('authorization'), 'Bearer ' + auditToken);
          assert.equal(payload.p_include_unreviewed, false);
          return Response.json({ results: [], as_of: payload.p_as_of });
        case 'persist':
          assert.equal(headers.get('authorization'), 'Bearer ' + auditToken);
          assert.equal(payload.status, answer ? 'QA' : 'HELD');
          assert.equal(payload.case, null);
          return Response.json({ run_id: payload.run_id, status: payload.status, case_id: null });
      }
    }
    if (url === 'https://api.telegram.org/file/bot' + botToken + '/documents/file_1.txt') {
      calls.push('download');
      assert.equal(headers.get('authorization'), null);
      return new Response(document);
    }
    assert.equal(new URL(url).origin, 'https://api.telegram.org');
    const method = url.split('/').at(-1);
    calls.push(method);
    switch (method) {
      case 'getWebhookInfo': return telegram({ url: webhook ? 'https://example.invalid/webhook' : '' });
      case 'getUpdates': return telegram(poll(payload));
      case 'getFile':
        assert.equal(payload.file_id, 'fixture_file_id');
        return telegram({ file_path: 'documents/file_1.txt', file_size: Buffer.byteLength(document) });
      case 'sendMessage':
        assert.equal(String(payload.chat_id), chatId);
        replies.push(payload.text);
        return telegram({ message_id: replies.length });
    }
    assert.fail('Unexpected service operation');
  };
  // Capture mock assertions so a sanitized transport failure cannot hide them.
  const recordingFetch = async (...args) => {
    try {
      return await fetchFn(...args);
    } catch (error) {
      errors.push(error);
      throw error;
    }
  };
  return { client: createStandby({ config, fetchFn: recordingFetch, now }), calls, replies, errors, session: () => session };
}

test('startup refuses to poll or remove an active webhook', async () => {
  const { client, calls, errors } = fixture({ webhook: true });
  assert.deepEqual(await client.check(), { webhookActive: true });
  await assert.rejects(client.run({ signal: new AbortController().signal }), { code: 'TELEGRAM_WEBHOOK_ACTIVE' });
  assert.deepEqual(calls, ['getWebhookInfo', 'getWebhookInfo']);
  assert.deepEqual(errors, []);
});

test('unknown Telegram sender cannot read the store or reach a model', async () => {
  const { client, calls } = fixture();
  assert.equal((await client.processUpdate(message(1, { text: '/expediente' }, 456))).status, 'ignored');
  assert.deepEqual(calls, []);
});

test('polling confirms processed updates and stops on an abort signal', async () => {
  const controller = new AbortController();
  let polls = 0;
  const { client, calls, replies, errors } = fixture({ poll(input) {
    assert.deepEqual(input.allowed_updates, ['message']);
    assert.equal(input.timeout, 25);
    switch (++polls) {
      case 1:
        assert.equal(input.offset, undefined);
        return [message(41, { text: '/estado' }), message(40, { text: '/start' }, 456)];
      case 2:
        assert.equal(input.offset, 42);
        return [];
      default:
        assert.equal(input.offset, undefined);
        controller.abort();
        return [];
    }
  } });
  await client.run({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]) });
  assert.deepEqual(calls, ['getWebhookInfo', 'getUpdates', 'get_telegram_session', 'sendMessage', 'getUpdates', 'getUpdates']);
  assert.equal(replies.length, 1);
  assert.deepEqual(errors, []);
});

test('opens the supplied file, remembers context, and resets the chat', async () => {
  const { client, calls, replies, errors, session } = fixture();
  await client.processUpdate(message(1, { text: '/expediente' }));
  assert.match(replies.at(-1), /Todavía no abrimos un expediente/);
  await client.processUpdate(message(2, { document: { file_name: 'contrato.txt', mime_type: 'text/plain',
    file_size: Buffer.byteLength(document), file_id: 'fixture_file_id' } }));
  assert.match(replies.at(-1), /Confirmar/);
  assert.equal(session().state.active, null);
  await client.processUpdate(message(3, { text: 'Confirmar' }));
  assert.match(replies.at(-1), /Abrí el expediente/);
  assert.equal(session().state.active.document, document);
  assert(calls.includes('getFile') && calls.includes('download'));
  await client.processUpdate(message(4, { text: 'Soy comprador y quiero aclarar el pago' }));
  assert.equal(session().state.active.context.our_role, 'comprador');
  await client.processUpdate(message(5, { text: '/reset' }));
  assert.match(replies.at(-1), /Restablecí la conversación/);
  assert.equal(session().state, null);
  assert(!calls.includes('gemini'));
  assert.deepEqual(errors, []);
});

test('a Gemini quota response preserves the active case and persists the held run', async () => {
  const { client, calls, replies, errors, session } = fixture();
  await client.processUpdate(message(1, { text: 'Contrato:\n' + document }));
  const caseId = session().state.active.case_id;
  await client.processUpdate(message(2, { text: '¿Cuándo vence el pago?' }));
  assert(calls.indexOf('claim_run') < calls.indexOf('gemini'));
  assert(calls.indexOf('gemini') < calls.indexOf('persist'));
  assert.match(replies.at(-1), /fuera de cuota o saturado/);
  assert.equal(session().state.active.case_id, caseId);
  assert.deepEqual(errors, []);
});

test('conversational answers run through the shared agents and remain with the current case', async () => {
  const { client, calls, replies, errors, session } = fixture({ answer: true });
  await client.processUpdate(message(1, { text: 'Contrato:\n' + document }));
  const caseId = session().state.active.case_id;
  await client.processUpdate(message(2, { text: '¿Cuándo vence el pago?' }));
  assert.match(replies.at(-1), /El pago vence en 30 días/);
  await client.processUpdate(message(3, { text: '¿Me aclaras ese plazo?' }));
  assert.match(replies.at(-1), /El plazo pactado es de treinta días/);
  assert.match(replies.at(-1), /Verificación jurídica pendiente/);
  assert.match(replies.at(-1), /Advertencia\. Contracter está trabajando con Gemini Free\. Puede cometer errores\./);
  assert.equal(calls.filter(call => call === 'persist').length, 2);
  assert.equal(session().state.active.case_id, caseId);
  assert.equal(session().state.active.turns.length, 2);
  assert.deepEqual(errors, []);
});

test('a revision conflict preserves the session and asks for a new message', async () => {
  const { client, replies, errors, session } = fixture({ conflict: true });
  await client.processUpdate(message(1, { text: 'Contrato:\n' + document }));
  assert.equal(session().state, null);
  assert.match(replies.at(-1), /Otro mensaje cambió el expediente/);
  assert.deepEqual(errors, []);
});

test('configuration refuses a different store destination or shared scopes', () => {
  assert.throws(() => loadStandbyConfig({ ...env, CONTRACTER_STORE_URL: 'https://example.invalid/contracter-store' }));
  assert.throws(() => loadStandbyConfig({ ...env, CONTRACTER_STORE_AUDIT_TOKEN: telegramToken }));
});
