import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { auditReply, demoQuestion, evaluationFixture, geminiDemoCaseId, telegramAttachment, telegramIngress } from './telegram-ingress.mjs';
import { buildTelegram } from '../scripts/build_live_workflow.mjs';

const owner = { owner_user_id: '123456789', owner_chat_id: '123456789' };
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const caption = [
  '/auditar confirmar', 'Empresa: Cliente ficticio', 'Contraparte: Proveedor ficticio',
  'Rol: Comprador', 'Objetivo: Aclarar el plazo', 'Región: Federal', 'Confirmo: sí',
].join('\n');
const bytes = Buffer.from('\uFEFFContrato ficticio\r\nEl envío será mañana.\r\n', 'utf8');
const expected = 'Contrato ficticio\nEl envío será mañana.';
const event = (message = {}, document = {}) => ({
  update_id: 2_010_404,
  message: {
    from: { id: 123456789 }, chat: { id: 123456789, type: 'private' },
    caption, document: { file_name: 'contrato.txt', mime_type: 'text/plain', file_id: 'fixture_id', file_size: bytes.length, ...document },
    ...message,
  },
});

test('La entrada por .txt acepta sólo un evento del propietario en su chat privado', () => {
  const parse = update => telegramIngress(update, owner, sha256);
  const requested = parse(event());
  assert.equal(requested.action, 'download_attachment');
  assert.deepEqual(requested.attachment, { file_id: 'fixture_id', file_size: bytes.length });
  assert.equal(Object.hasOwn(requested.input, 'document'), false);
  assert.deepEqual(parse(event()), requested);
  assert.equal(parse(event({ from: { id: 987654321 } })), null);
  assert.equal(parse(event({ chat: { id: 123456789, type: 'group' } })), null);
  assert.equal(parse(event({ chat: { id: 987654321, type: 'private' } })), null);
  assert.equal(parse({ ...event(), update_id: 'invalid' }), null);
});

test('Los adjuntos rechazados no llegan al nodo de descarga', () => {
  const fixtures = [
    event({ caption: caption.replace('Confirmo: sí', 'Confirmo: no') }),
    event({ caption: caption.replace('/auditar', '/consulta') }),
    event({ caption: caption.replace('Federal', 'Jalisco') }),
    event({ caption: caption + '\nEntidad: 33' }),
    event({ caption: caption + '\nMunicipio: 001' }),
    event({ caption: caption + '\n---\nPegar contrato' }),
    event({ media_group_id: 'example' }),
    event({ forward_origin: { type: 'user' } }),
    event({}, { file_name: 'contrato.pdf' }),
    event({}, { mime_type: 'application/pdf' }),
    event({}, { file_size: undefined }),
    event({}, { file_size: 36_001 }),
    event({}, { file_id: 'https://example.invalid/file.txt' }),
  ];
  for (const update of fixtures) {
    assert.equal(telegramIngress(update, owner, sha256).action, 'reply');
  }
});

test('La extracción elimina metadatos y rechaza binarios, formato y límites inválidos', () => {
  const input = telegramIngress(event(), owner, sha256);
  const extracted = telegramAttachment(input, bytes);
  assert.deepEqual(extracted, { action: 'audit', chat_id: owner.owner_chat_id, input: { ...input.input, document: expected } });
  assert.equal(telegramAttachment(input, bytes.subarray(1)).action, 'reply');
  assert.equal(telegramAttachment({ ...input, attachment: undefined }, bytes).action, 'reply');
  assert.equal(telegramAttachment(input).action, 'reply');
  for (const payload of [
    Buffer.from([0xc3, 0x28]), Buffer.from('Contiene\0binario'), Buffer.from('%PDF-1.7'),
    Buffer.from('   '), Buffer.from('a'.repeat(12_001)), Buffer.from('a\n'.repeat(1500) + 'a'),
  ]) {
    const request = telegramIngress(event({}, { file_size: payload.length }), owner, sha256);
    assert.equal(telegramAttachment(request, payload).action, 'reply');
  }
});

test('La consulta .txt y el contrato pegado usan el mismo formato de entrada de agentes', () => {
  const question = '¿Cuándo vence la entrega?';
  const update = event({ caption: caption.replace('/auditar', '/consulta') + '\nPregunta: ' + question });
  const attached = telegramAttachment(telegramIngress(update, owner, sha256), bytes);
  const pasted = telegramIngress({
    ...update,
    message: { ...update.message, document: undefined, text: update.message.caption + '\n---\n' + expected },
  }, owner, sha256);
  assert.deepEqual(attached, pasted);
  assert.equal(attached.input.workflow, 'qa');
  assert.equal(attached.input.question, question);
});

test('La evaluación usa el mismo chat privado y marca sólo su propio expediente como ficticio', () => {
  const evaluation = caption.replace('/auditar', '/evaluar');
  const update = event({ caption: evaluation });
  const requested = telegramIngress(update, owner, sha256);
  assert.equal(requested.action, 'download_attachment');
  assert.equal(telegramIngress(event({ caption: evaluation, from: { id: 987654321 } }), owner, sha256), null);
  assert.equal(telegramIngress(event({ caption: evaluation, chat: { id: 123456789, type: 'group' } }), owner, sha256), null);
  const attached = telegramAttachment(requested, bytes);
  const pasted = telegramIngress({
    ...update,
    message: { ...update.message, document: undefined, text: evaluation + '\n---\n' + expected },
  }, owner, sha256);
  assert.deepEqual(attached, pasted);
  assert.equal(pasted.input.synthetic, true);
  assert.equal(pasted.input.workflow, 'full');
  assert.equal(pasted.input.owner_chat_id, owner.owner_chat_id);
  assert.equal(Object.hasOwn(telegramIngress(event(), owner, sha256).input, 'synthetic'), false);
  assert.equal(telegramIngress(event({ caption: caption + '\nSynthetic: true' }), owner, sha256).action, 'reply');
  const result = { status: 'AWAITING_HUMAN', case_id: pasted.input.case_id };
  assert.match(auditReply(result), /\/revisar/);
  assert.match(auditReply({ ...result, synthetic: true }), /datos ficticios.+\n.+\/expediente/);
  assert.doesNotMatch(auditReply({ ...result, synthetic: true }), /\/revisar/);
});

test('El selector dirige únicamente el caso fijo a Gemini u OpenAI y conserva identidad y reintentos', () => {
  const parse = (text, message = {}, updateId = 2_010_404) => telegramIngress({
    ...event({ document: undefined, text, ...message }), update_id: updateId,
  }, owner, sha256);
  const menu = parse('/evaluar');
  assert.equal(menu.action, 'reply');
  for (const option of ['gemini consulta', 'gemini', 'openai', 'gateway']) assert(menu.text.includes('/evaluar ' + option));
  const pending = parse('/evaluar gateway');
  assert.equal(pending.action, 'reply');
  assert.match(pending.text, /pendiente/);
  const offer = parse('/evaluar openai');
  assert.equal(offer.action, 'reply');
  assert.match(offer.text, /puede consumir créditos.+\/evaluar openai confirmar/);
  const gemini = parse('/evaluar gemini');
  const openai = parse('/evaluar openai confirmar');
  const query = parse('/evaluar gemini consulta');
  assert.equal(gemini.action, 'audit_gemini');
  assert.equal(openai.action, 'audit_openai');
  assert.equal(query.action, 'audit_gemini');
  assert.deepEqual(gemini.input, openai.input);
  assert.deepEqual(query.input, { ...gemini.input, workflow: 'qa' });
  const { run_id, case_id, ...input } = gemini.input;
  assert.deepEqual(input, { workflow: 'full', synthetic: true, owner_chat_id: owner.owner_chat_id, ...evaluationFixture() });
  assert.match(run_id, /^[a-f0-9-]{36}$/);
  assert.notEqual(run_id, case_id);
  assert.notEqual(parse('/evaluar gemini', {}, 2_010_405).input.case_id, case_id);
  assert.deepEqual(parse('/evaluar@ContracterExampleBot gemini'), gemini);
  assert.equal(parse('/evaluar gemini', { from: { id: 123456788 } }), null);
  assert.equal(parse('/evaluar gemini', { chat: { id: 123456789, type: 'group' } }), null);
  assert.equal(parse('/evaluar gemini', {}, 'invalid'), null);
  assert.equal(parse('/evaluar gemini\n' + expected).action, 'reply');
  assert.equal(parse('/evaluar gemini consulta\nPregunta: ' + expected).action, 'reply');
  assert.equal(parse('/evaluar openai confirmar\n' + expected).action, 'reply');
  assert.equal(parse('/evaluar openai confirmar', { forward_origin: { type: 'user' } }).action, 'reply');
  assert.equal(telegramIngress(event({ caption: '/evaluar gemini' }), owner, sha256).action, 'reply');
  const clarification = auditReply({ status: 'CONTEXT_REQUIRED', synthetic: true }, [], 'audit_gemini');
  assert.match(clarification, /prueba fija quedó retenida/);
  assert.doesNotMatch(clarification, /Reenvía el contrato/);
  assert.match(auditReply({ status: 'HELD', reason: 'PROVIDER_QUOTA_EXHAUSTED' }, [], 'audit_gemini'), /Gemini informó que alcanzó su cuota/);
  assert.equal(auditReply({ status: 'QA_READY', answer: 'Ejemplo' }, [], 'audit_gemini'), 'Evaluación con datos ficticios.\nEjemplo');
});

test('OpenAI directo requiere confirmación antes de descargar adjuntos o auditar texto', () => {
  for (const command of ['auditar', 'consulta', 'evaluar']) {
    const unconfirmed = caption.replace('/auditar confirmar', '/' + command);
    const question = command === 'consulta' ? '\nPregunta: ¿Cuándo vence el plazo?' : '';
    const request = event({ caption: unconfirmed + question });
    for (const update of [request, {
      ...request, message: { ...request.message, document: undefined, text: unconfirmed + question + '\n---\n' + expected },
    }]) {
      const commandResult = telegramIngress(update, owner, sha256);
      assert.equal(commandResult.action, 'reply');
      assert.match(commandResult.text, new RegExp('/' + command + ' confirmar'));
      assert.match(commandResult.text, /puede consumir créditos/);
      assert(!Object.hasOwn(commandResult, 'attachment'));
      assert(!Object.hasOwn(commandResult, 'input'));
    }
  }
});

test('La demo selecciona o verifica la muestra y devuelve una sola referencia estable', () => {
  const caseId = geminiDemoCaseId(owner.owner_chat_id, sha256);
  const parse = message => telegramIngress(event(message), owner, sha256);
  const first = parse({ document: undefined, text: '/demo' });
  assert.equal(first.action, 'reply');
  assert(first.text.includes('120 cajas') && first.text.includes('30 días'));
  for (const topic of ['entrega', 'pago', 'recepcion']) assert(first.text.includes(`/pregunta ${caseId} ${topic}`));
  assert.deepEqual(parse({ document: undefined, text: '/expediente ' + caseId }), first);
  assert.match(parse({ document: undefined, text: '/revisar ' + caseId }).text, /no se puede aprobar/);
  const sample = evaluationFixture().document;
  assert.deepEqual(parse({ document: undefined, text: '/demo\n' + sample }), first);
  assert.doesNotMatch(parse({ document: undefined, text: '/demo\n' + sample + '\nPrivado' }).text, /Expediente de muestra/);
  const sampleBytes = Buffer.from('\uFEFF' + sample.replaceAll('\n', '\r\n') + '\r\n', 'utf8');
  const request = telegramIngress(event({ caption: '/demo' }, { file_size: sampleBytes.length }), owner, sha256);
  assert.equal(request.action, 'download_attachment');
  assert.equal(request.demo_case_id, caseId);
  assert.equal(Object.hasOwn(request, 'input'), false);
  assert.deepEqual(telegramAttachment(request, sampleBytes), first);
  const altered = Buffer.from(sampleBytes);
  altered[3] = 0x58;
  const refused = telegramAttachment(request, altered);
  assert.equal(refused.action, 'reply');
  assert.doesNotMatch(refused.text, /Expediente de muestra/);
  assert.equal(parse({ caption: '/demo\nComentario' }).action, 'reply');
  assert.equal(parse({ caption: '/demo', media_group_id: 'album' }).action, 'reply');
  assert.equal(parse({ caption: '/demo', from: { id: 123456788 } }), null);
});

test('Las consultas de entrega, pago y recepción conservan el expediente y sólo envían temas permitidos', () => {
  const caseId = geminiDemoCaseId(owner.owner_chat_id, sha256);
  const parse = (tail, update_id, message = {}) => telegramIngress({
    ...event({ document: undefined, text: '/pregunta ' + tail, ...message }), update_id,
  }, owner, sha256);
  const delivery = parse(caseId + ' entrega', 100);
  assert.equal(delivery.action, 'audit_gemini');
  const { run_id, ...input } = delivery.input;
  assert.deepEqual(input, { workflow: 'qa', demo_case_id: caseId, demo_topic: 'entrega', synthetic: true, owner_chat_id: owner.owner_chat_id });
  assert.deepEqual(parse(caseId + ' entrega', 100), delivery);
  const payment = parse(caseId + ' pago', 101);
  assert.notEqual(payment.input.run_id, run_id);
  assert.deepEqual(payment.input, { ...input, demo_topic: 'pago', run_id: payment.input.run_id });
  assert.equal(parse(caseId + ' recepción', 102).input.demo_topic, 'recepcion');
  assert.notEqual(demoQuestion('entrega'), demoQuestion('pago'));
  assert.equal(demoQuestion('otro'), null);
  assert.equal(parse(caseId + ' entrega\nMi contrato privado', 103).action, 'reply');
  assert.equal(parse(caseId + ' confidencial', 104).action, 'reply');
  assert.equal(parse(geminiDemoCaseId('123456788', sha256) + ' pago', 105).action, 'reply');
  assert.equal(parse(caseId + ' pago', 'invalid'), null);
  assert.equal(parse(caseId + ' pago', 106, { chat: { id: 123456789, type: 'group' } }), null);
  assert.equal(parse(caseId + ' pago', 107, { forward_origin: { type: 'user' } }).action, 'reply');
  assert.equal(auditReply({ status: 'QA_READY', answer: 'Texto' }, [], 'audit_gemini', caseId), 'Expediente de muestra ' + caseId + '\nTexto');
});

test('El export de n8n descarga bajo demanda y pasa exclusivamente el texto a los agentes', async () => {
  const workflow = JSON.parse(await readFile(new URL('../integration/n8n/live_telegram.json', import.meta.url), 'utf8'));
  const node = name => workflow.nodes.find(candidate => candidate.name === name);
  const targets = name => workflow.connections[name].main.map(output => output.map(target => target.node));
  const trigger = node('Telegram privado');
  assert(trigger.typeVersion >= 1.4);
  assert.deepEqual(trigger.parameters.updates, ['message', 'callback_query']);
  assert.equal(trigger.parameters.additionalFields.download, false);
  assert.equal(workflow.active, false);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveManualExecutions, false);
  assert.equal(workflow.settings.saveExecutionProgress, false);
  assert.deepEqual(targets('Telegram privado'), [['Validar entrada Telegram']]);
  assert.deepEqual(targets('Validar entrada Telegram'), [['¿Descargar adjunto?']]);
  assert.deepEqual(targets('¿Descargar adjunto?'), [['Descargar .txt privado'], ['¿Gemini Free?']]);
  assert.deepEqual(targets('Descargar .txt privado'), [['Validar y extraer texto']]);
  assert.deepEqual(targets('Validar y extraer texto'), [['¿Gemini Free?']]);
  assert.deepEqual(targets('¿Gemini Free?'), [['Entrada ficticia Gemini'], ['¿Auditoría o consulta?']]);
  assert.deepEqual(targets('Entrada ficticia Gemini'), [['Ejecutar agentes Gemini']]);
  assert.deepEqual(targets('Entrada de agentes'), [['Ejecutar agentes']]);
  assert.notEqual(node('Ejecutar agentes Gemini').parameters.workflowId.value, node('Ejecutar agentes').parameters.workflowId.value);
  const file = node('Descargar .txt privado');
  assert.equal(file.type, 'n8n-nodes-base.telegram');
  assert.deepEqual(file.credentials, trigger.credentials);
  assert.equal(file.parameters.resource, 'file');
  assert.equal(file.parameters.operation, 'get');
  assert.equal(file.parameters.download, true);

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const parseUpdate = new AsyncFunction('require', '$input', node('Validar entrada Telegram').parameters.jsCode
    .replace('TODO_TELEGRAM_CHAT_ID', owner.owner_chat_id).replace('TODO_TELEGRAM_OWNER_ID', owner.owner_user_id));
  async function parse(message) {
    const [parsed] = await parseUpdate(() => ({ createHash }), { first: () => ({ json: event(message) }) });
    return parsed?.json;
  }
  function routedNode(from, command) {
    let current = from;
    while (node(current).type === 'n8n-nodes-base.if') {
      const [condition] = node(current).parameters.conditions.conditions;
      assert.equal(condition.operator.operation, 'equals');
      const value = new Function('$json', `return (${condition.leftValue.slice(3, -2)});`)(command);
      [current] = targets(current)[value === condition.rightValue ? 0 : 1];
    }
    return current;
  }
  const route = command => routedNode('¿Descargar adjunto?', command);
  for (const text of ['/evaluar openai', '/evaluar gateway', '/evaluar', '/evaluar gemini\n' + expected,
    caption.replace(' confirmar', '') + '\n---\n' + expected,
    caption.replace('/auditar confirmar', '/consulta') + '\nPregunta: ¿Cuándo se entrega?\n---\n' + expected]) {
    assert.equal(route(await parse({ document: undefined, text })), 'Responder al propietario');
  }
  for (const caption of ['/evaluar gemini', '/evaluar gemini consulta', '/evaluar openai confirmar']) {
    assert.equal(route(await parse({ caption })), 'Responder al propietario');
  }
  const fixed = await parse({ document: undefined, text: '/evaluar gemini consulta' });
  assert.equal(route(fixed), 'Entrada ficticia Gemini');
  const toGemini = new AsyncFunction('$input', node('Entrada ficticia Gemini').parameters.jsCode);
  assert.deepEqual(await toGemini({ first: () => ({ json: fixed }) }), [{ json: fixed.input }]);
  assert.equal(fixed.input.workflow, 'qa');
  assert.equal(route(await parse({ document: undefined, text: '/evaluar gemini' })), 'Entrada ficticia Gemini');
  assert.equal(route(await parse({ document: undefined, text: '/evaluar openai confirmar' })), 'Entrada de agentes');
  const [parsed] = await parseUpdate(() => ({ createHash }), { first: () => ({ json: event({ caption: caption.replace('/auditar', '/evaluar') }) }) });
  const command = parsed.json;
  assert.equal(route(command), 'Descargar .txt privado');
  assert.equal(command.input.synthetic, true);
  const getValidated = name => {
    assert.equal(name, 'Validar entrada Telegram');
    return { itemMatching: index => {
      assert.equal(index, 0);
      return { json: command };
    } };
  };
  const source = new AsyncFunction('$input', '$', node('Validar y extraer texto').parameters.jsCode);
  const nativeResponse = { first: () => ({ json: { ignored: 'sensitive metadata' }, binary: { data: {} } }) };
  const decoded = await source.call({ helpers: { getBinaryDataBuffer: async (index, property) => {
    assert.equal(index, 0);
    assert.equal(property, 'data');
    return bytes;
  } } }, nativeResponse, getValidated);
  const toAgents = new AsyncFunction('$input', node('Entrada de agentes').parameters.jsCode);
  assert.equal(routedNode('¿Gemini Free?', decoded[0].json), 'Entrada de agentes');
  assert.deepEqual(await toAgents({ first: () => decoded[0] }), [{ json: { ...command.input, document: expected } }]);
  const reply = new AsyncFunction('$input', '$', node('Redactar respuesta de auditoría').parameters.jsCode);
  const [message] = await reply({ first: () => ({ json: { status: 'AWAITING_HUMAN', case_id: command.input.case_id, synthetic: true } }) }, getValidated);
  assert.match(message.json.text, /datos ficticios/);
  assert.doesNotMatch(message.json.text, /\/revisar/);
  const failed = await source.call({ helpers: { getBinaryDataBuffer: async () => {
    throw new Error('sensitive download error');
  } } }, nativeResponse, getValidated);
  assert.equal(failed[0].json.action, 'reply');
  assert.doesNotMatch(JSON.stringify(failed), /sensitive|fixture_id/);

  const sample = Buffer.from(evaluationFixture().document + '\n', 'utf8');
  const demoInput = await parse({ caption: '/demo', document: {
    file_name: 'muestra.txt', mime_type: 'text/plain', file_id: 'fixture_id', file_size: sample.length,
  } });
  assert.equal(route(demoInput), 'Descargar .txt privado');
  const describe = command => () => ({ itemMatching: () => ({ json: command }) });
  const [demo] = await source.call({ helpers: { getBinaryDataBuffer: async () => sample } }, nativeResponse, describe(demoInput));
  assert.equal(routedNode('¿Gemini Free?', demo.json), 'Responder al propietario');
  const question = await parse({ document: undefined, text: '/pregunta ' + demoInput.demo_case_id + ' pago' });
  assert.equal(route(question), 'Entrada ficticia Gemini');
  assert.equal(question.input.demo_case_id, demoInput.demo_case_id);
  assert.equal(Object.hasOwn(question.input, 'document'), false);
  const [answer] = await reply({ first: () => ({ json: { status: 'QA_READY', answer: 'Respuesta de pago' } }) }, describe(question));
  assert.equal(answer.json.text, 'Expediente de muestra ' + demoInput.demo_case_id + '\nRespuesta de pago');
});

test('El flujo docente no necesita credencial de aprobación ni puede ejecutar OpenAI', async () => {
  const workflow = await buildTelegram({ geminiOnly: true, auditWorkflowId: 'no-debe-aparecer',
    geminiWorkflowId: 'subflujo-docente', storeUrl: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/contracter-store',
    ownerChat: owner.owner_chat_id, ownerUser: owner.owner_user_id });
  assert.equal(workflow.nodes.some(candidate => candidate.credentials?.httpHeaderAuth?.name === 'Contracter · Aprobación'), false);
  const subflows = workflow.nodes.filter(candidate => candidate.type === 'n8n-nodes-base.executeWorkflow');
  assert.deepEqual(subflows.map(candidate => candidate.parameters.workflowId.value), ['subflujo-docente']);
  assert.equal(workflow.connections['Disponibilidad de OpenAI'].main[0][0].node, 'Responder al propietario');
  const parser = workflow.nodes.find(candidate => candidate.name === 'Validar entrada Telegram');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const ingress = new AsyncFunction('require', '$input', parser.parameters.jsCode);
  const parse = async message => (await ingress(() => ({ createHash }), { first: () => ({ json: event(message) }) }))[0].json;
  assert.equal((await parse({ caption })).action, 'reply');
  assert.equal((await parse({ caption: '/demo' })).action, 'download_attachment');
  assert.equal((await parse({ document: undefined, text: '/pregunta ' + geminiDemoCaseId(owner.owner_chat_id, sha256) + ' entrega' })).action, 'audit_gemini');
});
