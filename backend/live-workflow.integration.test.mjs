import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { test } from 'node:test';
import { createHandler } from '../integration/supabase/functions/contracter-store/index.ts';
import { buildGeminiSmoke, buildLive, loadAuditConfig } from '../scripts/build_live_workflow.mjs';
import { runLiveAudit } from './live-audit.mjs';
import { acceptStep, advanceWorkflow, GEMINI_MODEL, GEMINI_URL, OPENAI_MODEL, workflowState } from './live-transport.mjs';
import { auditReply, demoQuestion, evaluationFixture, geminiDemoCaseId, telegramIngress } from './telegram-ingress.mjs';

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const config = await loadAuditConfig();
const workflow = await buildLive({ storeUrl: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/contracter-store' });
const now = '2026-11-08T18:00:00.000Z';
const contract = 'ACUERDO FICTICIO\n1. Pago cuando se pueda.\n2. El proveedor entrega pronto.';
const draft = 'ACUERDO FICTICIO\n1. Pago en 30 días.\n2. El proveedor entrega el viernes.';
const quote = 'El ejemplo ficticio describe una obligación exigible dentro del plazo acordado.';
const chunkId = '22222222-2222-4222-8222-222222222222';
const chunk = {
  source_id: 'fixture-source', document_id: '33333333-3333-4333-8333-333333333333',
  version_id: '44444444-4444-4444-8444-444444444444', chunk_id: chunkId, title: 'Fuente ficticia de prueba',
  excerpt: quote, source_url: 'https://example.invalid/mock-law', locator: 'Fragmento ficticio',
  effective_from: '2026-01-01', effective_to: null, review_status: 'approved', effectivity_status: 'in_force',
  raw_sha256: sha256(quote), source_last_synced_at: now,
};
const raw = {
  run_id: '55555555-5555-4555-8555-555555555555', case_id: '11111111-1111-4111-8111-111111111111',
  owner_chat_id: '123456789', synthetic: true, workflow: 'full', title: 'Auditoría de prueba',
  document: contract, jurisdiction: { region: 'Federal', as_of: '2026-11-08' },
  context: { our_party: 'Cliente ficticio', counterparty: 'Proveedor ficticio', our_role: 'Cliente',
    objectives: ['Aclarar pagos y entregas.'], confirmed: true },
};
const allAgents = new Set(['Afton', 'Jane', 'Sherlock', 'Morty', 'Harvey', 'Murdock', 'Lupin', 'House',
  'Hamilton', 'Jarvis', 'Fury', 'Watson', 'Glenn']);

function modelFixture(body) {
  assert.equal(body.model, OPENAI_MODEL);
  assert.equal(body.store, false);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.input[0].role, 'developer');
  assert.equal(body.input[1].role, 'user');
  const [agent, ...stageParts] = body.text.format.name.split('_');
  const stage = stageParts.join('_');
  const input = JSON.parse(body.input[1].content);
  let output;
  switch (agent) {
    case 'Afton': output = { status: 'CLEAN', findings: [], limitations: [] }; break;
    case 'Jane': output = { missing_questions: [] }; break;
    case 'Sherlock': output = { observations: [] }; break;
    case 'House': {
      assert(!Object.keys(input).some(key => /document|question|excerpt|quote/i.test(key)));
      assert(!JSON.stringify(input).includes('ficticio'));
      const suspicious = !input.structurally_clean && input.phase === 'INITIAL_MONITORING';
      const confirmed = !input.structurally_clean && input.phase === 'POST_INTERROGATION_VERDICT';
      output = {
        phase: input.phase, target_agent: input.agent, clinical_notes: 'Control estructural simulado.',
        status: suspicious ? 'SUSPICIOUS_NEEDS_INTERROGATION' : confirmed ? 'CONFIRMED_INFECTED' : 'CLEAN',
        anomaly_score: suspicious || confirmed ? 0.8 : 0,
        interrogation_question: suspicious ? '¿Qué control de revisión pudo fallar y cómo lo comprobarías?' : null,
        quarantine_action: suspicious ? 'OPEN_ISOLATION_CHAMBER' : confirmed ? 'PURGE_MEMORY_AND_RETRY' : 'NONE',
      };
      break;
    }
    case 'Hamilton': output = { text: draft, pending_questions: [] }; break;
    case 'Jarvis':
      output = { changes: input.diff.map(change => ({ id: change.id, reason: 'Precisa el plazo.',
        operational_impact: 'Acota la fecha.', addresses_finding_ids: input.findings.map(finding => finding.id) })) };
      break;
    case 'Fury': output = stage === 'qa_route' ? { route: 'QA' } : { decision: 'CONSENSUS' }; break;
    case 'Watson': output = stage === 'qa_summary'
      ? { operational_agents: ['Harvey', 'Lupin'], legal_source_ids: input.legal_answer_evidence.map(item => item.source_id) }
      : { summary: 'Resumen ficticio.', key_risks: [], recommendations: ['Revisión humana.'] }; break;
    case 'Glenn': output = { explanation: 'La propuesta ficticia tiene fechas explícitas.' }; break;
    default: {
      assert(['Morty', 'Harvey', 'Murdock', 'Lupin'].includes(agent));
      if (stage.endsWith('_isolation_chamber')) {
        output = { control: 'STRUCTURE', assessment: 'CONTROL_OMITTED', retry_recommended: true,
          procedural_explanation: 'Se debe comprobar el formato de la salida.' };
        break;
      }
      const legal = agent === 'Murdock';
      const resolved = input.version === 'V2';
      const noQaEvidence = stage === 'qa_review' && legal && !input.approved_legal_excerpts.length;
      const previous_resolutions = input.previous_findings.map(finding => ({ finding_id: finding.id, basis: 'TEXT' }));
      const citedIds = previous_resolutions.map(item => item.finding_id);
      if (!resolved && !noQaEvidence) citedIds.push(input.new_finding_id_prefix + '1');
      output = {
        agent_name: agent, iteration: input.iteration, reviewed_version: input.version, reviewed_sha256: input.sha256,
        consensus_reached: resolved, status_for_fury: resolved ? 'ENTENDIDO' : 'REQUIERE_CAMBIOS',
        previous_resolutions, reassurance_for_morty: [],
        observations: resolved || noQaEvidence ? [] : [{
          clause_reference: '1', severity: 'MEDIA', issue_description: 'Plazo impreciso.', proposed_fix: 'Precisar la fecha.',
        }],
        ...(legal ? { legal_citations: citedIds.map(finding_id => ({ finding_id, source_id: chunkId, quote })),
          required_standard_clauses: [] } : {}),
        ...(stage === 'qa_review' && legal ? { answer_citations: noQaEvidence ? [] : [{ source_id: chunkId, quote }] } : {}),
        ...(stage === 'qa_review' && !legal ? { answer: 'El plazo actual es impreciso.' } : {}),
      };
    }
  }
  return { agent, stage, input, response: { statusCode: 200, body: {
    status: 'completed', model: OPENAI_MODEL,
    usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 20 } },
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
  } } };
}

function environment({ duplicate = false, persistFails = false, modelMutation, legalSearch = () => [chunk], expectedInput = raw } = {}) {
  const modelCalls = [];
  const modelBodies = [];
  const rpcCalls = [];
  const persisted = [];
  // The actual Edge handler receives HTTP-like requests. Only the RPC and
  // model responses are fixtures. No credentials or fetch requests are needed.
  const edge = createHandler(async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === 'contracter_runtime_authorize') {
      assert.equal(args.p_scope, 'audit');
      return true;
    }
    if (name === 'contracter_claim_run') {
      assert.deepEqual(args, {
        p_run_id: expectedInput.run_id, p_synthetic: expectedInput.synthetic === true, p_owner_chat_id: expectedInput.owner_chat_id,
      });
      return duplicate ? { accepted: false, status: 'CLAIMED' } : { accepted: true, status: 'CLAIMED' };
    }
    if (name === 'legal_search_fts') {
      assert.equal(args.p_country_code, 'MX');
      assert.equal(args.p_include_unreviewed, false);
      assert(!args.p_query.includes('FICTICIO'));
      return legalSearch(args.p_query);
    }
    if (name === 'contracter_persist_run') {
      const run = args.p_request;
      assert(Array.isArray(run.usage_events));
      assert.equal(run.run_id, expectedInput.run_id);
      assert(run.usage_events.every(event => run.agent_logs.some(log => log.event_id === event.event_id && log.agent === event.agent)));
      if (run.status === 'AWAITING_HUMAN') assert.deepEqual(run.usage_events, run.case.costs.events);
      else assert.equal(run.case, null);
      persisted.push(run);
      if (persistFails) throw new Error('Fixture unavailable');
      // Match the SQL return shape exactly. No synthetic ok flag.
      return { run_id: run.run_id, case_id: run.case?.case_id ?? null, status: run.status,
        v2_sha256: run.case?.versions.v2.sha256 ?? null, replayed: false };
    }
    throw new Error('Unexpected RPC ' + name);
  });
  return {
    modelCalls, modelBodies, rpcCalls, persisted,
    async store(body) {
      const response = await edge(new Request('https://example.invalid/fixture-edge', {
        method: 'POST', headers: { authorization: 'Bearer ' + '0'.repeat(64), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));
      return { statusCode: response.status, body: await response.json() };
    },
    model(body) {
      const call = modelFixture(body);
      modelBodies.push(body);
      modelCalls.push(call);
      return modelMutation?.(call) ?? call.response;
    },
  };
}

async function runTransport(env, input = raw) {
  let packet = { state: workflowState(input, { now, uuid: crypto.randomUUID }) };
  const state = packet.state;
  for (let step = 0; step < 60; step++) {
    const advanced = await advanceWorkflow(packet, { runLiveAudit, config, sha256, now: Date.parse(now) + step * 10 });
    if (advanced.next === 'done') return advanced.result;
    const http = advanced.next === 'openai' ? env.model(advanced.request.body) : await env.store(advanced.request.body);
    packet = acceptStep(advanced, http, advanced.request.started + 5);
    if (packet.next === 'done') return packet.result;
    assert.equal(packet.state, state);
  }
  throw new Error('Transport exceeded 60 steps');
}

// Execute the generated Code nodes and traverse generated edges. This models
// one item per path. It does not substitute for a run in the n8n engine.
async function runGenerated(env, input = raw, generated = workflow) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const nodes = new Map(generated.nodes.map(node => [node.name, node]));
  const outputs = new Map();
  const permittedRequire = module => {
    assert.equal(module, 'crypto');
    return crypto;
  };
  let name = generated.nodes.find(node => node.type.endsWith('.executeWorkflowTrigger')).name;
  let value = input;
  for (let step = 0; step < 300; step++) {
    const node = nodes.get(name);
    assert(node);
    let branch = 0;
    if (node.type.endsWith('.code')) {
      const code = new AsyncFunction('require', '$input', '$', node.parameters.jsCode);
      const rows = await code(permittedRequire, { first: () => ({ json: value }) }, reference => ({
        itemMatching(index) {
          assert.equal(index, 0);
          assert(outputs.has(reference));
          return { json: outputs.get(reference) };
        },
      }));
      assert.equal(rows.length, 1);
      value = rows[0].json;
    } else if (node.type.endsWith('.if')) {
      const condition = node.parameters.conditions.conditions[0];
      assert.equal(condition.leftValue, '={{ $json.next }}');
      branch = value.next === condition.rightValue ? 0 : 1;
    } else if (node.type.endsWith('.httpRequest')) {
      assert.equal(node.retryOnFail, false);
      assert.equal(node.parameters.jsonBody, '={{ JSON.stringify($json.request.body) }}');
      value = node.parameters.nodeCredentialType === 'openAiApi'
        ? env.model(value.request.body)
        : node.parameters.url === GEMINI_URL
          ? env.gemini(value.request.body)
          : await env.store(value.request.body);
    }
    outputs.set(name, value);
    const edges = generated.connections[name]?.main?.[branch] ?? [];
    if (!edges.length) return value;
    assert.equal(edges.length, 1);
    name = edges[0].node;
  }
  throw new Error('Generated workflow exceeded 300 nodes');
}

test('generated n8n graph traverses all 13 roles and persists a private V2 through the actual Edge handler', async () => {
  const env = environment();
  const result = await runGenerated(env);
  assert.equal(result.status, 'AWAITING_HUMAN');
  assert.equal(result.persisted, true);
  assert.deepEqual(new Set(env.modelCalls.map(call => call.agent)), allAgents);
  assert.equal(env.modelCalls.length, 24);
  assert.equal(env.persisted.length, 1);
  const run = env.persisted[0];
  assert.equal(run.agent_logs.length, 24);
  assert.equal(run.case.versions.v2.sha256, sha256(draft));
  assert.equal(run.case.fury.released, false);
  assert.equal(run.case.human_approval.status, 'PENDING');
  assert.equal(run.case.publication.contains_sensitive_data, true);
  assert.equal(run.case.costs.total_usd, 0.0005568);
});

test('Telegram evaluation runs all roles and preserves the synthetic flag through private storage', async () => {
  const chatId = 123456789;
  const command = telegramIngress({ update_id: 502, message: {
    from: { id: chatId }, chat: { id: chatId, type: 'private' },
    text: [
      '/evaluar confirmar', 'Empresa: Cliente ficticio', 'Contraparte: Proveedor ficticio', 'Rol: Cliente',
      'Objetivo: Aclarar pagos y entregas.', 'Región: Federal', 'Confirmo: sí', '---', contract,
    ].join('\n'),
  } }, { owner_user_id: chatId, owner_chat_id: chatId }, sha256);
  assert.equal(command.action, 'audit');
  const env = environment({ expectedInput: command.input });
  const result = await runGenerated(env, command.input);
  assert.equal(result.status, 'AWAITING_HUMAN');
  assert.equal(result.persisted, true);
  assert.equal(result.synthetic, true);
  assert.deepEqual(new Set(env.modelCalls.map(call => call.agent)), allAgents);
  assert.equal(env.persisted[0].synthetic, true);
  assert.equal(env.persisted[0].owner_chat_id, String(chatId));
  assert.equal(env.persisted[0].case.human_approval.status, 'PENDING');
  assert.equal(env.persisted[0].case.fury.released, false);
  assert.match(auditReply(result), /Evaluación con datos ficticios/);
  assert.doesNotMatch(auditReply(result), /\/revisar/);
});

test('an unavailable legal search holds both generated flows with a technical reason', async () => {
  for (const input of [raw, { ...raw, workflow: 'qa', question: '¿Cuándo debo pagar?' }]) {
    const env = environment({ legalSearch() { throw new Error('Fixture unavailable'); } });
    const result = await runGenerated(env, input);
    assert.equal(result.status, 'HELD');
    assert.equal(result.reason, 'LEGAL_SEARCH_UNAVAILABLE');
    assert.equal(result.persisted, true);
    assert.equal(result.answer, undefined);
    assert.equal(env.persisted[0].case, null);
    assert.equal(env.rpcCalls.filter(call => call.name === 'legal_search_fts').length, 1);
    assert(!env.modelCalls.some(call => ['review_v1', 'qa_review'].includes(call.stage)));
    assert.match(auditReply(result), /No se pudo consultar el buscador jurídico/);
  }
});

test('a healthy empty search still holds full audit for missing evidence and allows QA abstention', async () => {
  const full = await runGenerated(environment({ legalSearch: () => [] }));
  assert.equal(full.status, 'HELD');
  assert.equal(full.reason, 'LEGAL_EVIDENCE_UNAVAILABLE');
  assert.match(auditReply(full), /hacen falta fuentes jurídicas revisadas/);
  const qa = await runGenerated(environment({ legalSearch: () => [] }), {
    ...raw, workflow: 'qa', question: '¿Cuándo debo pagar?',
  });
  assert.equal(qa.status, 'QA_READY');
  assert.equal(qa.persisted, true);
  assert.match(qa.answer, /Verificación jurídica pendiente/);
  assert.match(qa.answer, /observación operativa/);
});

test('Gemini connects with one fixed request and the real workflow filters caller text before sending requests', async () => {
  const smoke = await buildGeminiSmoke();
  const check = new Function('$input', smoke.nodes.find(node => node.name === 'Resultado de conexión').parameters.jsCode);
  const http = (text, statusCode = 200) => ({ statusCode, body: {
    modelVersion: GEMINI_MODEL, candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 },
  } });
  assert.equal(check({ first: () => ({ json: http('{"status":"ok"}') }) })[0].json.connected, true);
  assert.equal(check({ first: () => ({ json: http('{"status":"ok","extra":1}') }) })[0].json.connected, false);

  const gemini = await buildLive({ provider: 'gemini', storeUrl: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/contracter-store' });
  const expected = { ...raw, ...evaluationFixture(), workflow: 'qa',
    question: '¿Qué riesgo operativo crean las cláusulas de entrega y pago y qué debería aclarar la compradora?' };
  const recorded = environment({ expectedInput: expected, legalSearch: () => [] });
  assert.equal((await runGenerated(recorded, expected)).status, 'QA_READY');

  const env = environment({ expectedInput: expected, legalSearch: () => [] });
  let called = 0;
  env.gemini = body => {
    assert.doesNotMatch(JSON.stringify(body), /NO_ENVIAR_A_GEMINI/);
    assert.equal(body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), JSON.parse(recorded.modelBodies[called].input[1].content));
    return http(recorded.modelCalls[called++].response.body.output[0].content[0].text);
  };
  const result = await runGenerated(env, { ...expected, document: 'NO_ENVIAR_A_GEMINI',
    title: 'NO_ENVIAR_A_GEMINI', question: 'NO_ENVIAR_A_GEMINI', clarification: 'NO_ENVIAR_A_GEMINI',
    context: { our_party: 'NO_ENVIAR_A_GEMINI' }, synthetic: false }, gemini);
  assert.equal(called, recorded.modelCalls.length);
  assert.equal(result.status, 'QA_READY');
  assert.equal(result.provider, 'gemini');
  assert.equal(result.persisted, true);
  assert.equal(result.total_usd, 0);
  assert.match(result.answer, /Verificación jurídica pendiente/);
  assert(env.persisted[0].usage_events.every(event => event.model === GEMINI_MODEL && event.cost_usd === 0));

  env.gemini = () => ({ statusCode: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } });
  assert.equal((await runGenerated(env, expected, gemini)).reason, 'PROVIDER_QUOTA_EXHAUSTED');
});

test('Gemini delivery and payment questions persist separate QA runs under the same private demo reference', async () => {
  const generated = await buildLive({ provider: 'gemini', storeUrl: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/contracter-store' });
  const owner = { owner_chat_id: raw.owner_chat_id, owner_user_id: raw.owner_chat_id };
  const caseId = geminiDemoCaseId(owner.owner_chat_id, sha256);
  const savedRuns = [];
  const runIds = new Set();
  const eventIds = new Set();
  for (const [index, topic] of ['entrega', 'pago'].entries()) {
    const command = telegramIngress({ update_id: 91000 + index, message: {
      chat: { id: Number(owner.owner_chat_id), type: 'private' },
      from: { id: Number(owner.owner_user_id) }, text: `/pregunta ${caseId} ${topic}`,
    } }, owner, sha256);
    assert.equal(command.action, 'audit_gemini');
    const expected = { ...raw, ...evaluationFixture(), ...command.input, case_id: caseId, question: demoQuestion(topic) };
    const recorded = environment({ expectedInput: expected, legalSearch: () => [] });
    assert.equal((await runGenerated(recorded, expected)).status, 'QA_READY');
    const env = environment({ expectedInput: expected, legalSearch: () => [] });
    let called = 0;
    const questions = new Set();
    env.gemini = body => {
      const payload = JSON.parse(body.contents[0].parts[0].text);
      assert.deepEqual(payload, recorded.modelCalls[called].input);
      if (payload.question_envelope) questions.add(payload.question_envelope);
      return { statusCode: 200, body: {
        modelVersion: GEMINI_MODEL,
        candidates: [{ finishReason: 'STOP', content: {
          parts: [{ text: recorded.modelCalls[called++].response.body.output[0].content[0].text }],
        } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 },
      } };
    };
    const result = await runGenerated(env, command.input, generated);
    assert.equal(called, recorded.modelCalls.length);
    assert.deepEqual([...questions], [`<documento_no_confiable>${demoQuestion(topic)}</documento_no_confiable>`]);
    assert.equal(result.status, 'QA_READY');
    assert.equal(result.persisted, true);
    assert.equal(result.synthetic, true);
    assert.equal(result.case_id, null);
    assert.equal(result.demo_case_id, caseId);
    assert.equal(result.demo_topic, topic);
    assert.equal(runIds.has(result.run_id), false);
    runIds.add(result.run_id);
    assert.equal(env.persisted.length, 1);
    const saved = env.persisted[0];
    assert.equal(saved.status, 'QA');
    assert.equal(saved.case, null);
    assert.equal(saved.synthetic, true);
    assert.equal(saved.owner_chat_id, owner.owner_chat_id);
    assert(saved.agent_logs.length > 0);
    for (const event of saved.agent_logs) {
      assert.equal(event.demo_case_id, caseId);
      assert.equal(event.demo_topic, topic);
      assert.equal(eventIds.has(event.event_id), false);
      eventIds.add(event.event_id);
    }
    savedRuns.push(saved);
  }
  assert.equal(runIds.size, 2);
  assert.notEqual(savedRuns[0].run_id, savedRuns[1].run_id);
});

test('Gemini audits a supplied synthetic contract and keeps conversational QA tied to that case', async () => {
  const generated = await buildLive({ provider: 'gemini', geminiConversation: true,
    storeUrl: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/contracter-store' });
  const quantityClause = '\n3. Cantidad. Se pactan 20 unidades a $50 MXN cada una.';
  const input = { ...raw, run_id: crypto.randomUUID(), case_id: crypto.randomUUID(), document: contract + quantityClause };
  const completedRuns = [];
  const comparable = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'retrieved_at' ? '<runtime timestamp>' : item));
  async function execute(input) {
    const recorded = environment({ expectedInput: input, modelMutation(call) {
      const content = call.response.body.output[0].content[0];
      if (call.agent === 'Hamilton') content.text = JSON.stringify({ text: draft + quantityClause, pending_questions: [] });
      if (call.stage === 'qa_review' && ['Harvey', 'Lupin'].includes(call.agent)) {
        const output = JSON.parse(content.text);
        output.answer = input.conversation?.length ? 'El total de las 20 unidades a $50 MXN sería $1,000 MXN.'
          : 'El precio por unidad indicado en el contrato es $50 MXN.';
        content.text = JSON.stringify(output);
      }
      return call.response;
    } });
    await runGenerated(recorded, input);
    const env = environment({ expectedInput: input });
    let called = 0;
    env.gemini = body => {
      const payload = JSON.parse(body.contents[0].parts[0].text);
      assert.deepEqual(comparable(payload), comparable(recorded.modelCalls[called].input));
      return { statusCode: 200, body: {
        modelVersion: GEMINI_MODEL,
        candidates: [{ finishReason: 'STOP', content: {
          parts: [{ text: recorded.modelCalls[called++].response.body.output[0].content[0].text }],
        } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 },
      } };
    };
    const result = await runGenerated(env, input, generated);
    assert.equal(called, recorded.modelCalls.length);
    assert.equal(result.persisted, true);
    assert.equal(result.synthetic, true);
    assert.equal(result.source_case_id, input.case_id);
    assert.equal(result.source_document_sha256, sha256(input.document));
    assert.equal(env.persisted.length, 1);
    const saved = env.persisted[0];
    assert.equal(saved.owner_chat_id, input.owner_chat_id);
    assert.equal(saved.synthetic, true);
    assert(saved.agent_logs.every(event => event.source_case_id === input.case_id
      && event.source_document_sha256 === sha256(input.document)));
    completedRuns.push(saved);
    return { result, saved, calls: recorded.modelCalls };
  }
  const full = await execute(input);
  assert.equal(full.result.status, 'AWAITING_HUMAN');
  assert.deepEqual(new Set(full.calls.map(call => call.agent)), allAgents);
  assert.equal(full.saved.case.versions.v1.text, input.document);
  assert.equal(full.saved.case.versions.v2.text, draft + quantityClause);
  assert.equal(full.saved.case.human_approval.status, 'PENDING');
  assert.equal(full.saved.case.fury.released, false);

  const firstQuestion = '¿Cuál es el precio por unidad?';
  const first = await execute({ ...input, workflow: 'qa', run_id: crypto.randomUUID(), question: firstQuestion });
  assert.equal(first.result.status, 'QA_READY');
  assert.equal(first.saved.status, 'QA');
  assert.equal(first.saved.case, null);
  assert.match(first.result.answer, /\$50 MXN/);
  const conversation = [{ question: firstQuestion, answer: first.result.answer }];
  const followup = await execute({ ...input, workflow: 'qa', run_id: crypto.randomUUID(), conversation,
    question: '¿Y cuánto sería en total?' });
  assert.equal(followup.result.status, 'QA_READY');
  assert.equal(followup.saved.status, 'QA');
  assert.equal(followup.saved.case, null);
  assert.match(followup.result.answer, /\$1,000 MXN/);
  assert(followup.calls.filter(call => call.stage === 'qa_review' || call.stage === 'qa_summary')
    .every(call => call.input.prior_conversation.length === 1 && call.input.prior_conversation[0].authoritative === false
      && call.input.prior_conversation[0].question_envelope.includes(firstQuestion)));
  assert(followup.calls.filter(call => call.agent === 'House')
    .every(call => !Object.hasOwn(call.input, 'prior_conversation')));
  const aftonInput = followup.calls.find(call => call.agent === 'Afton').input;
  assert.equal(aftonInput.current_question_envelope, '<documento_no_confiable>¿Y cuánto sería en total?</documento_no_confiable>');
  assert(aftonInput.prior_conversation[0].question_envelope.includes(firstQuestion));
  assert.equal(aftonInput.prior_conversation[0].authoritative, false);
  assert.equal(new Set(completedRuns.map(run => run.run_id)).size, 3);
  const rejected = environment({ expectedInput: input });
  rejected.gemini = () => assert.fail('An unconfirmed input must stop before contacting Gemini');
  const held = await runGenerated(rejected, { ...input, synthetic: false }, generated);
  assert.equal(held.status, 'HELD');
  assert.equal(held.reason, 'GEMINI_TEST_INPUT_INVALID');
  assert.equal(held.persisted, false);
  assert.equal(rejected.rpcCalls.length, 0);
});

test('the generated synthetic engine persists the inert Afton marker without any model or House call', async () => {
  const input = { ...raw, workflow: 'qa', question: '¿Cuándo vence el pago?',
    document: contract + '\nCONTRACTER_QA_CONTROL_AFTON\nFin.' };
  const generated = await buildLive({ provider: 'gemini', geminiConversation: true,
    storeUrl: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/contracter-store' });
  const env = environment({ expectedInput: input });
  env.gemini = () => assert.fail('The marker must stop before invoking any model');
  const result = await runGenerated(env, input, generated);
  assert.equal(result.status, 'HELD');
  assert.equal(result.reason, 'AFTON_TEST_CANARY');
  assert.equal(result.persisted, true);
  assert.equal(result.source_case_id, input.case_id);
  assert.equal(env.modelCalls.length, 0);
  assert.equal(env.persisted.length, 1);
  assert.equal(env.persisted[0].case, null);
  assert.equal(env.persisted[0].agent_logs.length, 1);
  assert.equal(env.persisted[0].agent_logs[0].agent, 'Afton');
  assert.deepEqual(env.persisted[0].agent_logs[0].output, { code: 'AFTON_TEST_CANARY' });
  assert.deepEqual(env.persisted[0].usage_events, []);
  assert(!env.rpcCalls.some(call => call.name === 'legal_search_fts'));
});

test('a malformed search for a new V2 topic holds the case even after valid V1 evidence', async () => {
  const env = environment({
    legalSearch: query => query === 'confidencialidad' ? null : [chunk],
    modelMutation(call) {
      if (call.agent !== 'Hamilton') return;
      const content = call.response.body.output[0].content[0];
      content.text = JSON.stringify({ text: draft + '\n3. Confidencialidad de archivos.', pending_questions: [] });
    },
  });
  const result = await runGenerated(env);
  assert.equal(result.status, 'HELD');
  assert.equal(result.reason, 'LEGAL_SEARCH_UNAVAILABLE');
  assert.equal(result.persisted, true);
  assert(env.modelCalls.some(call => call.stage === 'review_v1'));
  assert(!env.modelCalls.some(call => call.stage === 'review_v2'));
  assert.equal(env.persisted[0].case, null);
});

test('credit exhausted 429 records unknown usage and stops after one model request', async () => {
  const env = environment({ modelMutation: () => ({
    statusCode: 429, body: { error: { code: 'credit_balance_exhausted' } },
  }) });
  const result = await runTransport(env);
  assert.equal(result.status, 'HELD');
  assert.equal(result.reason, 'PROVIDER_CREDIT_EXHAUSTED');
  assert.equal(result.persisted, true);
  assert.equal(env.modelCalls.length, 1);
  assert.equal(env.persisted[0].usage_events[0].tokens_input, null);
  assert.equal(env.persisted[0].usage_events[0].cost_usd, null);
});

test('ordinary rate limiting is bounded inside the affected review and retains the case', async () => {
  const env = environment({ modelMutation: call => call.agent === 'Harvey' && call.stage === 'review_v1'
    ? { statusCode: 429, body: { error: { code: 'rate_limit_exceeded' } } } : null });
  const result = await runTransport(env);
  assert.equal(result.status, 'HELD');
  assert.equal(result.persisted, true);
  const attempts = env.modelCalls.filter(call => call.agent === 'Harvey' && call.stage === 'review_v1');
  assert(attempts.length >= 1 && attempts.length <= 3);
  assert.equal(env.persisted[0].case, null);
  assert(env.persisted[0].usage_events.some(event => event.agent === 'Harvey' && event.cost_usd === null));
});

test('duplicate claims exit before invoking any provider or attempting persistence', async () => {
  const env = environment({ duplicate: true });
  const result = await runTransport(env);
  assert.equal(result.status, 'DUPLICATE');
  assert.equal(result.persisted, false);
  assert.equal(env.modelCalls.length, 0);
  assert.equal(env.persisted.length, 0);
});

test('missing cache telemetry preserves known tokens and leaves cost unverified', async () => {
  const env = environment({ modelMutation(call) {
    if (call.agent === 'Afton') delete call.response.body.usage.input_tokens_details;
    return call.response;
  } });
  const result = await runTransport(env);
  assert.equal(result.status, 'HELD');
  assert.equal(result.reason, 'USAGE_OR_PRICING_UNVERIFIED');
  assert.equal(result.total_usd, null);
  assert.equal(result.persisted, true);
  const event = env.persisted[0].usage_events.find(entry => entry.agent === 'Afton');
  assert.equal(event.tokens_input, 100);
  assert.equal(event.cost_usd, null);
});

test('a failed store response suppresses a generated QA answer', async () => {
  const env = environment({ persistFails: true });
  const result = await runGenerated(env, { ...raw, workflow: 'qa', question: '¿Cuándo debo pagar?' });
  assert.equal(result.status, 'STORE_UNAVAILABLE');
  assert.equal(result.persisted, false);
  assert.equal(result.answer, undefined);
  assert.equal(env.persisted[0].status, 'QA');
  assert.equal(env.persisted[0].case, null);
  assert(!env.modelCalls.some(call => call.agent === 'Hamilton'));
});
