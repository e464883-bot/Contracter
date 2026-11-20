import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildLive } from './build_live_workflow.mjs';

// This draft exercises the actual n8n Code, IF and loop wiring with synthetic
// adapter responses. It never calls a provider or writes to a real database.
const input = {
  run_id: '55555555-5555-4555-8555-555555555555',
  case_id: '11111111-1111-4111-8111-111111111111',
  synthetic: true, workflow: 'full', title: 'Verificación sintética del motor',
  document: 'ACUERDO FICTICIO\n1. El proveedor entrega cuando pueda.',
  jurisdiction: { region: 'Federal', as_of: '2026-11-08' },
  context: { our_party: 'Cliente ficticio', counterparty: 'Proveedor ficticio', our_role: 'Cliente',
    objectives: ['Definir el plazo de entrega.'], confirmed: true },
};
const draft = 'ACUERDO FICTICIO\n1. El proveedor entrega dentro de 30 días.';
const quote = 'El ejemplo ficticio describe una obligación exigible dentro del plazo acordado.';
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const chunk = {
  source_id: 'fixture-source', document_id: '33333333-3333-4333-8333-333333333333',
  version_id: '44444444-4444-4444-8444-444444444444', chunk_id: '22222222-2222-4222-8222-222222222222',
  title: 'Fuente ficticia de verificación', excerpt: quote, locator: 'Fragmento ficticio',
  source_url: 'https://example.invalid/fixture', effective_from: '2026-01-01', effective_to: null,
  review_status: 'approved', effectivity_status: 'in_force', raw_sha256: digest(quote),
  source_last_synced_at: '2026-11-08T12:00:00.000Z',
};

function modelFixture(request, proposal, source) {
  const body = request.body;
  if (request.kind !== 'model' || body.store !== false || body.text?.format?.strict !== true) {
    throw new Error('FIXTURE_MODEL_REQUEST_INVALID');
  }
  const [agent, ...stageParts] = body.text.format.name.split('_');
  const stage = stageParts.join('_');
  const attempt = Number(request.key.split(':').at(-1));
  const data = JSON.parse(body.input[1].content);
  let output;
  if (agent === 'Afton') output = { status: 'CLEAN', findings: [], limitations: [] };
  else if (agent === 'Jane') output = { missing_questions: [] };
  else if (agent === 'Sherlock') output = { observations: [] };
  else if (agent === 'House') {
    if (Object.keys(data).some(key => /document|question|excerpt|quote/i.test(key))) throw new Error('HOUSE_INPUT_NOT_ISOLATED');
    const initial = data.phase === 'INITIAL_MONITORING';
    const suspicious = initial && !data.structurally_clean;
    const infected = !initial && !data.structurally_clean && data.chamber_assessment === 'CONTROL_OMITTED';
    output = {
      phase: data.phase, target_agent: data.agent, clinical_notes: 'Control estructural ficticio.',
      status: suspicious ? 'SUSPICIOUS_NEEDS_INTERROGATION' : infected ? 'CONFIRMED_INFECTED' : 'CLEAN',
      anomaly_score: suspicious || infected ? 0.9 : 0,
      interrogation_question: suspicious ? '¿Qué control de revisión pudo fallar y cómo lo comprobarías?' : null,
      quarantine_action: suspicious ? 'OPEN_ISOLATION_CHAMBER' : infected ? 'PURGE_MEMORY_AND_RETRY' : 'NONE',
    };
  } else if (stage.endsWith('_isolation_chamber')) {
    if (agent !== 'Lupin' || !data.question || Object.keys(data).some(key => /document|history|excerpt|quote/i.test(key))) {
      throw new Error('CHAMBER_INPUT_NOT_ISOLATED');
    }
    output = { control: 'VERSION_HASH', assessment: 'CONTROL_OMITTED', retry_recommended: true,
      procedural_explanation: 'Se debe verificar la huella antes de responder.' };
  } else if (agent === 'Hamilton') output = { text: proposal, pending_questions: [] };
  else if (agent === 'Jarvis') output = { changes: data.diff.map(change => ({
    id: change.id, reason: 'Fija el plazo.', operational_impact: 'Aclara la entrega.',
    addresses_finding_ids: data.findings.map(finding => finding.id),
  })) };
  else if (agent === 'Fury') output = { decision: 'CONSENSUS' };
  else if (agent === 'Watson') output = { summary: 'Verificación ficticia pendiente de revisión humana.',
    key_risks: [], recommendations: [] };
  else if (agent === 'Glenn') output = { explanation: 'El acuerdo ficticio ya tiene un plazo claro.' };
  else if (['Morty', 'Harvey', 'Murdock', 'Lupin'].includes(agent)) {
    const v2 = data.version === 'V2';
    const resolutions = data.previous_findings.map(finding => ({ finding_id: finding.id, basis: 'TEXT' }));
    const findingIds = v2 ? resolutions.map(item => item.finding_id) : [data.new_finding_id_prefix + '1'];
    output = {
      agent_name: agent, iteration: data.iteration, reviewed_version: data.version,
      reviewed_sha256: v2 && agent === 'Lupin' && attempt === 0 ? '0'.repeat(64) : data.sha256,
      consensus_reached: v2, status_for_fury: v2 ? 'ENTENDIDO' : 'REQUIERE_CAMBIOS',
      previous_resolutions: resolutions, reassurance_for_morty: [],
      observations: v2 ? [] : [{ clause_reference: '1', severity: 'MEDIA',
        issue_description: 'El plazo es impreciso.', proposed_fix: 'Fijar una fecha.' }],
      ...(agent === 'Murdock' ? { required_standard_clauses: [],
        legal_citations: findingIds.map(finding_id => ({ finding_id, source_id: source.chunk_id, quote: source.excerpt })) } : {}),
    };
  } else throw new Error('FIXTURE_AGENT_UNEXPECTED: ' + agent);

  return { statusCode: 200, body: {
    status: 'completed', model: body.model,
    usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 20 } },
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
  } };
}

function storeFixture(request, source, expectedHash) {
  const body = request.body;
  const response = body => ({ statusCode: 200, body });
  if (request.kind === 'claim' && body.operation === 'claim_run' && body.synthetic === true) {
    return response({ accepted: true, status: 'CLAIMED' });
  }
  if (request.kind === 'legal' && body.operation === 'legal_search' && body.p_country_code === 'MX') {
    return response({ results: [source], as_of: body.p_as_of });
  }
  if (request.kind !== 'persist' || body.operation !== 'persist' || body.synthetic !== true) {
    throw new Error('FIXTURE_STORE_REQUEST_INVALID');
  }
  const logs = body.agent_logs;
  const usage = body.usage_events;
  const record = body.case;
  if (body.status !== 'AWAITING_HUMAN' || record?.versions?.v2?.sha256 !== expectedHash
    || record.human_approval?.status !== 'PENDING' || record.fury?.released !== false
    || !record.publication?.contains_sensitive_data || record.publication?.redacted_for_public !== false
    || logs?.length !== 28 || usage?.length !== 28
    || new Set(logs.map(log => log.agent)).size !== 13 || new Set(logs.map(log => log.event_id)).size !== 28
    || usage.some(event => !logs.some(log => log.event_id === event.event_id && log.agent === event.agent))) {
    throw new Error('FIXTURE_PERSIST_ASSERTION_FAILED');
  }
  const stage = (name, condition) => logs.some(log => log.stage === name && condition(log));
  if (!stage('review_v2_house_monitor_Lupin', log => log.output.status === 'SUSPICIOUS_NEEDS_INTERROGATION')
    || !stage('review_v2_isolation_chamber', log => log.agent === 'Lupin' && log.status === 'ISOLATED')
    || !stage('review_v2_house_verdict_Lupin', log => log.output.status === 'CONFIRMED_INFECTED')
    || !stage('review_v2', log => log.agent === 'Lupin' && log.quarantined && log.output.memory_purged)
    || !stage('review_v2', log => log.agent === 'Lupin' && !log.quarantined && log.output.reviewed_sha256 === expectedHash)
    || !record.house?.checks?.some(check => check.agent === 'Lupin' && check.retry_count === 1)) {
    throw new Error('FIXTURE_ISOLATION_ASSERTION_FAILED');
  }
  return response({ run_id: body.run_id, case_id: record.case_id, status: body.status,
    v2_sha256: expectedHash, replayed: false });
}

export async function buildEngineVerification() {
  const flow = await buildLive({ storeUrl: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/contracter-store' });
  flow.name = 'CONTRACTER · Prueba desechable del motor (ficticia)';
  const asCode = (node, jsCode) => ({
    id: node.id, name: node.name, position: node.position, type: 'n8n-nodes-base.code', typeVersion: 2,
    parameters: { mode: 'runOnceForAllItems', jsCode },
  });
  const stepResult = expression => 'return [{json:' + expression + ',pairedItem:{item:0}}];';
  const serialized = JSON.stringify;
  const newCode = (name, position, jsCode) => asCode({ id: randomUUID(), name, position }, jsCode);
  flow.nodes = flow.nodes.map(node => {
    if (node.type === 'n8n-nodes-base.executeWorkflowTrigger') {
      return { ...node, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} };
    }
    if (node.name === 'OpenAI · Structured Outputs') {
      return asCode(node, 'const respond = ' + modelFixture.toString() + ';\n'
        + stepResult('respond($input.first().json.request,' + serialized(draft) + ',' + serialized(chunk) + ')'));
    }
    if (node.name === 'Supabase · datos de auditoría') {
      return asCode(node, 'const respond = ' + storeFixture.toString() + ';\n'
        + stepResult('respond($input.first().json.request,' + serialized(chunk) + ',' + serialized(digest(draft)) + ')'));
    }
    return node;
  });
  const evidence = {
    passed: true, data_source: 'fixture', distinct_roles: 13, synthetic_model_responses: 28,
    house_isolation_confirmed: true, audited_response_quarantined_and_retried: true,
    persistence: 'simulated', external_requests: 0,
  };
  flow.nodes.push(newCode('Contrato ficticio', [100, -180], stepResult(serialized(input))),
    newCode('Evidencia de prueba', [1180, -180], `
const result = $input.first().json;
if (result.status !== 'AWAITING_HUMAN' || result.synthetic !== true || result.persisted !== true) {
  throw new Error('ENGINE_FIXTURE_NOT_COMPLETED: ' + (result.reason || result.status || 'NO_STATUS'));
}
return [{json:{status:result.status,synthetic:true,fixture_persisted:true,proof:${serialized(evidence)}}}];
`));
  const connect = target => ({ main: [[{ node: target, type: 'main', index: 0 }]] });
  flow.connections['Entrada interna'] = connect('Contrato ficticio');
  flow.connections['Contrato ficticio'] = connect('Iniciar expediente');
  flow.connections['Resultado privado'] = connect('Evidencia de prueba');
  if (flow.active || flow.nodes.some(node => node.credentials
    || !['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.code', 'n8n-nodes-base.if'].includes(node.type))) {
    throw new Error('ENGINE_FIXTURE_MUST_BE_OFFLINE');
  }
  return flow;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Uso: node scripts/build_engine_verification.mjs destino.json');
  await writeFile(process.argv[2], JSON.stringify(await buildEngineVerification(), null, 2) + '\n', 'utf8');
}
