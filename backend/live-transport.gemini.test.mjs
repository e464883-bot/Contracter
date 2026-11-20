import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { loadAuditConfig } from '../scripts/build_live_workflow.mjs';
import { runLiveAudit } from './live-audit.mjs';
import {
  acceptStep, advanceWorkflow, GEMINI_FREE_PRICE, GEMINI_MODEL, GEMINI_URL, geminiDemoState,
  geminiModelRequest, geminiProviderResponse, geminiTestState, persistStep, workflowState,
} from './live-transport.mjs';
import { demoQuestion, evaluationFixture, geminiDemoCaseId } from './telegram-ingress.mjs';

const now = '2026-11-16T18:00:00.000Z';
const source = {
  synthetic: true, document: 'CONTRATO DE PRUEBA\n1. El plazo de entrega será por escrito.',
  jurisdiction: { region: 'Federal', as_of: '2026-11-16' },
  context: { our_party: 'Parte ficticia', counterparty: 'Contraparte ficticia', our_role: 'Cliente',
    objectives: ['Comprobar formato'], confirmed: true },
};
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const auditConfig = await loadAuditConfig();
const fixtureOptions = { now, uuid: randomUUID, sha256, fixture: evaluationFixture(), demoCaseId: geminiDemoCaseId, demoQuestion };

function geminiReply(output, { model = GEMINI_MODEL, metadata, finishReason = 'STOP' } = {}) {
  return { statusCode: 200, body: {
    modelVersion: model,
    candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(output) }] } }],
    usageMetadata: metadata ?? { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 },
  } };
}

test('Gemini request uses native structured outputs, LOW thinking and separate message roles', () => {
  const input = { document_envelope: '<documento_no_confiable>Texto ficticio</documento_no_confiable>' };
  const schema = { type: 'object', required: ['ok', 'note'], additionalProperties: false, properties: {
    ok: { type: 'boolean', enum: [true] },
    note: { anyOf: [{ type: 'string', enum: ['approved'] }, { type: 'null' }] },
  } };
  const request = geminiModelRequest({ agent: 'Afton', system: 'Valida los metadatos.', input, schema });
  assert.equal(new URL(GEMINI_URL).pathname, `/v1beta/models/${GEMINI_MODEL}:generateContent`);
  assert.equal(new URL(GEMINI_URL).search, '');
  assert.deepEqual(request.systemInstruction.parts, [{ text: 'Valida los metadatos.' }]);
  assert.deepEqual(request.contents, [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }]);
  assert.deepEqual(request.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.equal(request.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
  assert.deepEqual(request.generationConfig.responseFormat.text.schema.properties, {
    ok: { type: 'boolean' }, note: schema.properties.note,
  });
  assert.deepEqual(schema.properties.ok.enum, [true]);
  assert.equal(Object.hasOwn(request, 'tools'), false);
});

test('Gemini response reads answer parts only and accounts for billed thoughts', () => {
  const reply = geminiReply({ status: 'CLEAN' });
  reply.body.candidates[0].content.parts = [
    { text: 'Thought summary unrelated to the reply.', thought: true },
    { text: '{"status":' }, { text: '"CLEAN"}' },
  ];
  const result = geminiProviderResponse(reply, 5);
  assert.deepEqual(result, {
    model: GEMINI_MODEL, output: { status: 'CLEAN' }, latency_ms: 5,
    usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: null },
  });
  const omitted = geminiReply({}, { metadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 } });
  assert.equal(geminiProviderResponse(omitted, 5).usage.output_tokens, 5);
  omitted.body.usageMetadata.totalTokenCount++;
  assert.equal(geminiProviderResponse(omitted, 5).usage.output_tokens, null);
  reply.body.usageMetadata.totalTokenCount = '150';
  assert.equal(geminiProviderResponse(reply, 5).usage.output_tokens, null);
});

test('Gemini rejects blocked or incomplete replies and invalid structured content', () => {
  assert.equal(geminiProviderResponse({ statusCode: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }, 3).error, 'model_refusal');
  assert.equal(geminiProviderResponse(geminiReply({}, { finishReason: 'MAX_TOKENS' }), 3).error, 'model_incomplete');
  assert.equal(geminiProviderResponse(geminiReply(['invalid']), 3).error, 'invalid_structured_output');
  assert.equal(geminiProviderResponse({ statusCode: 400, body: { error: { message: 'unsupported schema' } } }, 3).error, 'unsupported_schema');
  assert.equal(geminiProviderResponse({ statusCode: 400, body: { error: { details: [{ reason: 'API_KEY_INVALID' }] } } }, 3).error, 'invalid_api_key');
});

async function runSynthetic(replies, pricing = GEMINI_FREE_PRICE) {
  const state = geminiDemoState({ workflow: 'full' }, fixtureOptions);
  const config = { ...auditConfig, pricing };
  const options = { runLiveAudit, config, sha256, now: Date.parse(now), provider: 'gemini' };
  const claim = await advanceWorkflow({ state }, options);
  assert.equal(claim.request.kind, 'claim');
  const ready = acceptStep(claim, { statusCode: 200, body: { accepted: true } }, Date.parse(now), 'gemini');
  let packet = ready;
  let requested = 0;
  for (;;) {
    const step = await advanceWorkflow(packet, options);
    if (step.request.kind === 'persist') return { request: step.request.body, requested };
    assert.equal(step.next, 'openai');
    assert.equal(step.request.kind, 'model');
    assert(step.request.body.generationConfig.responseFormat);
    assert(requested < replies.length, 'A terminal synthetic call must not trigger another model request');
    packet = acceptStep(step, replies[requested++], Date.parse(now) + 5, 'gemini');
  }
}

test('Gemini gate rejects generic state even when labelled synthetic', async () => {
  for (const synthetic of [false, true]) {
    const state = workflowState({ ...source, synthetic }, { now, uuid: randomUUID });
    const packet = await advanceWorkflow({ state }, {
      runLiveAudit() { assert.fail('must stop before auditing'); }, config: auditConfig, sha256, provider: 'gemini',
    });
    assert.deepEqual(packet, { next: 'done', result: {
      status: 'HELD', reason: 'GEMINI_SYNTHETIC_ONLY', run_id: state.run_id, persisted: false,
    } });
  }
});

test('transport derives the synthetic runtime flag from authenticated workflow state', async () => {
  const state = workflowState({ ...source, synthetic: false }, { now, uuid: randomUUID });
  state.claims_ok = true;
  const packet = await advanceWorkflow({ state }, {
    runLiveAudit(input, adapters, runtimeConfig) {
      assert.equal(runtimeConfig.syntheticRun, false);
      return { status: 'HELD', events: [], costs: { events: [], total_usd: null } };
    },
    config: { ...auditConfig, syntheticRun: true }, sha256, now: Date.parse(now),
  });
  assert.equal(packet.request.kind, 'persist');
  assert.equal(packet.request.body.synthetic, false);
});

function suppliedTestInput(workflow = 'qa') {
  return { ...source, title: 'Contrato ficticio aportado', workflow, owner_chat_id: '12345',
    run_id: randomUUID(), case_id: randomUUID(), question: '¿Qué fecha debe acordarse para la entrega?' };
}

test('Gemini accepts an explicitly synthetic contract and retains case identity and bounded conversation', async () => {
  const raw = suppliedTestInput();
  raw.conversation = [{ question: '¿Qué cantidad se entrega?', answer: 'El contrato de prueba indica 20 unidades.' }];
  const state = geminiTestState(raw, { now, uuid: randomUUID, sha256 });
  assert.equal(state.input.document, raw.document);
  assert.equal(state.input.question, raw.question);
  assert.equal(state.input.case_id, raw.case_id);
  assert.equal(state.run_id, raw.run_id);
  assert.deepEqual(state.input.conversation, raw.conversation);
  assert.notEqual(state.input.conversation[0], raw.conversation[0]);
  assert.deepEqual(state.case_reference, { source_case_id: raw.case_id, source_document_sha256: sha256(raw.document) });
  const step = await advanceWorkflow({ state }, { runLiveAudit, config: auditConfig, sha256, now: Date.parse(now), provider: 'gemini' });
  assert.equal(step.request.kind, 'claim');
  assert.equal(step.request.body.owner_chat_id, raw.owner_chat_id);
  assert.equal(step.request.body.synthetic, true);
  const full = geminiTestState({ ...raw, workflow: 'full', conversation: [] }, { now, uuid: randomUUID, sha256 });
  assert.equal(Object.hasOwn(full.input, 'conversation'), false);
});

test('Gemini test input rejects missing synthetic consent, invalid IDs and excessive conversation', () => {
  const raw = suppliedTestInput();
  const turn = { question: '¿Qué cantidad se entrega?', answer: '20 unidades.' };
  for (const override of [
    { synthetic: false }, { synthetic: undefined }, { owner_chat_id: '0' }, { owner_chat_id: undefined },
    { run_id: 'invalid' }, { case_id: 'invalid' }, { source_case_id: randomUUID() },
    { document: 'a'.repeat(12001) }, { document: 'a\n'.repeat(1501) }, { question: 'a'.repeat(601) },
    { conversation: [turn, turn, turn, turn] }, { conversation: [{ ...turn, answer: 'a'.repeat(1201) }] },
    { conversation: [{ ...turn, owner_chat_id: '67890' }] }, { workflow: 'full', conversation: [turn] },
  ]) assert.throws(() => geminiTestState({ ...raw, ...override }, { now, uuid: randomUUID, sha256 }),
    { message: 'GEMINI_TEST_INPUT_INVALID' });
});

test('the audit engine rejects oversized prior answers before invoking any model', async () => {
  const input = workflowState(suppliedTestInput(), { now, uuid: randomUUID }).input;
  input.conversation = [{ question: '¿Qué cantidad se entrega?', answer: 'a'.repeat(1201) }];
  await assert.rejects(runLiveAudit(input, {
    sha256,
    invokeModel() { assert.fail('Invalid conversation must stop before a model call'); },
    searchLegal() { assert.fail('Invalid conversation must stop before a legal lookup'); },
  }, auditConfig), { code: 'INVALID_CONVERSATION' });
});

test('Gemini QA persistence carries the selected case reference without creating a contract version', () => {
  const state = geminiTestState(suppliedTestInput(), { now, uuid: randomUUID, sha256 });
  const step = persistStep(state, { status: 'QA_READY', qa: { answer: 'Respuesta del contrato aportado.' },
    costs: { total_usd: 0, events: [] }, events: [{ event_id: randomUUID(), agent: 'Watson', stage: 'qa_summary',
      round: 1, status: 'VALIDATED', output: {} }] });
  assert.equal(step.request.body.status, 'QA');
  assert.equal(step.request.body.case, null);
  assert.equal(step.request.body.agent_logs[0].source_case_id, state.case_reference.source_case_id);
  const result = acceptStep(step, { statusCode: 200, body: { run_id: state.run_id, case_id: null, status: 'QA' } },
    Date.parse(now), 'gemini').result;
  assert.equal(result.persisted, true);
  assert.equal(result.source_case_id, state.case_reference.source_case_id);
  assert.equal(result.source_document_sha256, sha256(source.document));
});

function demoInput(topic, owner = '12345') {
  return { workflow: 'qa', demo_case_id: geminiDemoCaseId(owner, sha256), demo_topic: topic,
    synthetic: true, owner_chat_id: owner, run_id: randomUUID() };
}

test('Gemini demo keeps one fixed contract per chat and uses only the selected fixed question', () => {
  const topics = ['entrega', 'pago', 'recepcion'];
  const states = topics.map(topic => geminiDemoState({
    ...demoInput(topic), title: 'private title', document: 'private contract', question: 'private question',
    context: {}, clarification: 'private note', jurisdiction: { region: 'private jurisdiction' },
  }, fixtureOptions));
  assert.deepEqual(new Set(states.map(state => state.input.case_id)), new Set([geminiDemoCaseId('12345', sha256)]));
  assert.equal(new Set(states.map(state => state.run_id)).size, topics.length);
  assert.equal(new Set(states.map(state => state.input.question)).size, topics.length);
  for (const [index, state] of states.entries()) {
    assert.equal(state.input.question, demoQuestion(topics[index]));
    assert.equal(state.input.document, fixtureOptions.fixture.document);
    assert.equal(state.input.title, fixtureOptions.fixture.title);
    assert.deepEqual(state.input.context, fixtureOptions.fixture.context);
    assert.equal(state.input.clarification, fixtureOptions.fixture.clarification);
    assert.equal(state.input.jurisdiction.region, fixtureOptions.fixture.jurisdiction.region);
  }
  const nextChat = geminiDemoState(demoInput('pago', '67890'), fixtureOptions);
  assert.notEqual(nextChat.input.case_id, states[1].input.case_id);
  assert.equal(nextChat.input.question, states[1].input.question);
});

test('Gemini demo rejects cross-chat IDs, invalid topics and partial identity before a claim', () => {
  const valid = demoInput('pago');
  for (const override of [
    { owner_chat_id: '67890' }, { demo_topic: '__proto__' }, { demo_topic: 'pregunta libre' },
    { demo_case_id: undefined }, { workflow: 'full' }, { synthetic: false }, { run_id: undefined },
    { case_id: randomUUID() },
  ]) assert.throws(() => geminiDemoState({ ...valid, ...override }, fixtureOptions), { message: 'GEMINI_DEMO_INVALID' });
});

test('Gemini demo separates the private sample reference from a persisted contract version', () => {
  const state = geminiDemoState(demoInput('recepcion'), fixtureOptions);
  const step = persistStep(state, { status: 'QA_READY', qa: { answer: 'Respuesta de muestra' },
    costs: { total_usd: 0, events: [] }, events: [{ event_id: randomUUID(), agent: 'Watson', stage: 'qa_summary',
      round: 1, status: 'VALIDATED', output: {} }] });
  assert.equal(step.request.body.status, 'QA');
  assert.equal(step.request.body.case, null);
  assert.equal(step.request.body.synthetic, true);
  assert.equal(step.request.body.owner_chat_id, '12345');
  assert.equal(step.request.body.agent_logs[0].demo_case_id, state.demo.demo_case_id);
  assert.equal(step.request.body.agent_logs[0].demo_topic, 'recepcion');
  const result = acceptStep(step, { statusCode: 200, body: { run_id: state.run_id, case_id: null, status: 'QA' } },
    Date.parse(now), 'gemini').result;
  assert.equal(result.persisted, true);
  assert.equal(result.case_id, null);
  assert.equal(result.demo_case_id, state.demo.demo_case_id);
  assert.equal(result.demo_topic, 'recepcion');
  assert.equal(result.status, 'QA_READY');
});

test('Gemini quota 429 is persisted as terminal with one call and unmeasured usage', async () => {
  const { request, requested } = await runSynthetic([{ statusCode: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }]);
  assert.equal(requested, 1);
  assert.equal(request.status, 'HELD');
  assert.equal(request.reason, 'PROVIDER_QUOTA_EXHAUSTED');
  assert.equal(request.case, null);
  assert.equal(request.usage_events.length, 1);
  assert.equal(request.usage_events[0].tokens_input, null);
  assert.equal(request.usage_events[0].cost_usd, null);
});

test('Gemini retries 503 without usage within the limit and distinguishes exhausted capacity', async () => {
  const overloaded = { statusCode: 503, body: { error: { status: 'UNAVAILABLE' } } };
  const blocked = { status: 'BLOCKED', findings: ['Prueba ficticia.'], limitations: [] };
  const recovered = await runSynthetic([overloaded, geminiReply(blocked)]);
  assert.equal(recovered.requested, 2);
  assert.equal(recovered.request.reason, 'AFTON_BLOCKED');
  assert.equal(recovered.request.usage_events.length, 1);
  const held = await runSynthetic([overloaded, overloaded, overloaded]);
  assert.equal(held.requested, 3);
  assert.equal(held.request.reason, 'PROVIDER_CAPACITY_UNAVAILABLE');
});

test('only an explicit matching Free pricing profile records zero USD for measured Gemini usage', async () => {
  const blocked = { status: 'BLOCKED', findings: ['Prueba ficticia.'], limitations: [] };
  const priced = await runSynthetic([geminiReply(blocked)]);
  assert.equal(priced.request.reason, 'AFTON_BLOCKED');
  assert.equal(priced.request.usage_events[0].model, GEMINI_MODEL);
  assert.equal(priced.request.usage_events[0].tokens_output, 50);
  assert.equal(priced.request.usage_events[0].cost_usd, 0);
  assert.equal(priced.request.usage_events[0].pricing_source, GEMINI_FREE_PRICE.source);

  const noProfile = await runSynthetic([geminiReply(blocked)], null);
  assert.equal(noProfile.request.usage_events[0].cost_usd, null);
  const mismatch = await runSynthetic([geminiReply(blocked, { model: 'gemini-unverified-version' })]);
  assert.equal(mismatch.request.usage_events[0].model, 'gemini-unverified-version');
  assert.equal(mismatch.request.usage_events[0].cost_usd, null);
});
