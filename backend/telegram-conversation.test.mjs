import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  conversationAccess, finishTelegramConversationAudit, finishTelegramConversationDownload, planTelegramConversation,
} from './telegram-conversation.mjs';
import { buildLive, buildTelegramConversation } from '../scripts/build_live_workflow.mjs';

const ownerId = '123456789';
const owner = { owner_chat_id: ownerId, owner_user_id: ownerId };
const initial = { revision: 0, last_message_id: null, state: null };
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const contract = 'Acuerdo de mantenimiento\n1. El precio es de 770 MXN.\n2. El pago vence 8 días después de recibir el reporte.';
const disclaimer = 'Advertencia. Contracter está trabajando con Gemini Free. Puede cometer errores.';
const previousWording = /\b(?:fictici[oa]s?|inventad[oa]s?|fals[oa]s?)\b|contrato de prueba/iu;
const attachment = { file_name: 'contrato-propio.txt', mime_type: 'text/plain', file_id: 'fixture_attachment_id',
  file_size: Buffer.byteLength(contract, 'utf8') };
const update = (message_id, message) => ({
  update_id: message_id + 100,
  message: { message_id, from: { id: Number(ownerId) }, chat: { id: Number(ownerId), type: 'private' }, ...message },
});
const plan = (message_id, message, session = initial) => {
  const event = update(message_id, typeof message === 'string' ? { text: message } : message);
  return planTelegramConversation(event, conversationAccess(event, owner), session, sha256);
};
const saved = command => ({ revision: command.body.expected_revision + 1,
  last_message_id: command.body.message_id, state: command.body.state });

test('El chat parte vacío y sólo activa los adjuntos que el usuario confirma', () => {
  assert.match(plan(1, '/expediente').text, /Todavía no abrimos/);
  assert.match(plan(1, '/demo').text, /Contrato:/);
  assert.doesNotMatch(plan(1, '/demo').text, previousWording);
  assert.equal(conversationAccess(update(1, { from: { id: 987654321 } }), owner), null);
  assert.equal(conversationAccess(update(1, { chat: { id: Number(ownerId), type: 'group' } }), owner), null);
  const extra = { owner_chat_id: '987654321', owner_user_id: '987654321' };
  const extraUpdate = update(1, { from: { id: 987654321 }, chat: { id: 987654321, type: 'private' } });
  assert.equal(conversationAccess(extraUpdate, owner), null);
  assert.equal(conversationAccess(extraUpdate, { ...owner, allowed_chats: [extra] }).chat_id, extra.owner_chat_id);
  const received = plan(2, { document: attachment });
  assert.equal(received.action, 'save');
  assert.equal(received.body.state.active, null);
  const download = plan(3, 'Confirmar', saved(received));
  assert.equal(download.action, 'download');
  assert.equal(download.case_id, received.body.state.pending.case_id);
  assert.equal(finishTelegramConversationDownload(download, Buffer.from('No es el archivo')).action, 'reply');
  const opened = finishTelegramConversationDownload(download, Buffer.from(contract));
  assert.equal(opened.body.state.active.document, contract);
  assert.equal(opened.body.state.pending, null);
  assert.match(plan(4, '/expediente', saved(opened)).text, new RegExp(opened.body.state.active.case_id));
  assert.equal(plan(4, { document: { ...attachment, file_name: 'file.pdf' } }).action, 'reply');
});

test('Las preguntas libres conservan la referencia y usan las últimas tres respuestas del caso activo', () => {
  const opened = plan(1, 'Contrato:\n' + contract);
  const first = plan(2, '¿Cuándo vence el pago?', saved(opened));
  assert.equal(first.action, 'gemini');
  assert.equal(first.input.workflow, 'qa');
  assert.equal(first.input.synthetic, true);
  assert.equal(first.input.document, contract);
  assert.deepEqual(first.input.conversation, []);
  const firstAnswer = finishTelegramConversationAudit(first, {
    status: 'QA_READY', persisted: true, source_case_id: first.input.case_id, answer: 'A los ocho días de recibir el reporte.',
  }, []);
  const second = plan(3, '¿Y desde cuándo cuento esos días?', saved(firstAnswer));
  assert.equal(second.input.case_id, first.input.case_id);
  assert.notEqual(second.input.run_id, first.input.run_id);
  assert.deepEqual(second.input.conversation, [{ question: first.input.question, answer: 'A los ocho días de recibir el reporte.' }]);
  const explicit = plan(4, '/pregunta ' + first.input.case_id + ' ¿Cuál es el monto?', saved(firstAnswer));
  assert.equal(explicit.input.question, '¿Cuál es el monto?');
  assert.equal(plan(4, '/pregunta ' + randomUUID() + ' ¿Cuál es el monto?', saved(firstAnswer)).action, 'reply');
  assert.equal(plan(4, 'Gracias', saved(firstAnswer)).action, 'reply');
});

test('La auditoría usa el mismo contrato, permite aclaraciones, y reset elimina el contexto', () => {
  const download = plan(1, { document: attachment, caption: 'Contrato' });
  assert.equal(download.action, 'download');
  const opened = saved(finishTelegramConversationDownload(download, Buffer.from(contract)));
  assert.match(plan(2, 'Audita el contrato', opened).text, /qué parte representas/);
  const role = saved(plan(3, 'Soy comprador y quiero aclarar la fecha de pago', opened));
  const full = plan(4, 'Audita el contrato', role);
  assert.equal(full.input.workflow, 'full');
  assert.equal(full.input.synthetic, true);
  assert.equal(full.input.case_id, role.state.active.case_id);
  assert.equal(full.input.context.our_role, 'comprador');
  const territorial = saved(plan(4, 'Región: Jalisco\nEntidad: 14', role));
  assert.deepEqual(plan(5, '/auditar', territorial).input.jurisdiction,
    { region: 'Jalisco', entity_code: '14', municipality_code: null });
  const qaQuestion = '¿Cuándo se entregará el servicio?';
  const clarification = finishTelegramConversationAudit(full, { status: 'CONTEXT_REQUIRED', questions: [qaQuestion] }, [qaQuestion]);
  assert.match(clarification.text, /entregará el servicio/);
  const answered = saved(plan(5, 'Aclaración: El servicio se presta el viernes.', saved(clarification)));
  assert.equal(plan(6, '/auditar', answered).input.clarification, 'El servicio se presta el viernes.');
  const reset = plan(7, '/reset', answered);
  assert.equal(reset.body.state, null);
  assert.equal(plan(6, '¿Cuál es el pago?', saved(reset)), null);
  assert.equal(plan(8, '¿Cuál es el pago?', saved(reset)).action, 'reply');
  const next = plan(9, 'Contrato:\nConvenio de otra empresa.');
  assert.notEqual(next.body.state.active.case_id, opened.state.active.case_id);
  assert.deepEqual(next.body.state.active.turns, []);
});

test('El menú, la apertura y la consulta muestran la advertencia y usan el texto visible actual', () => {
  const menu = plan(1, '/help');
  const pending = plan(2, { document: attachment });
  assert.match(menu.text, /Contrato:/);
  assert.match(pending.text, /Confirmar/);
  assert.equal(plan(3, 'Sí', saved(pending)).action, 'reply');
  const opened = plan(4, 'Contrato:\n' + contract);
  assert.equal(opened.body.state.active.title, 'Contrato');
  assert.deepEqual(Object.keys(opened.body.state.active).sort(),
    ['case_id', 'context', 'document', 'jurisdiction', 'title', 'turns']);
  const session = saved(opened);
  const question = plan(5, '¿Cuál es el monto?', session);
  assert.equal(question.input.synthetic, true);
  const answer = finishTelegramConversationAudit(question, {
    status: 'QA_READY', persisted: true, source_case_id: question.input.case_id, answer: 'El monto indicado es 770 MXN.',
  }, []);
  for (const reply of [menu, opened, answer]) assert(reply.text.includes(disclaimer));
  for (const reply of [menu, pending, opened, answer, plan(6, '/expediente', session),
    plan(6, '/revisar', session), plan(6, '/reset', session), plan(6, '/demo', session)]) {
    assert.doesNotMatch(reply.text, previousWording);
    assert.doesNotMatch(reply.text, /Verifica las cláusulas, los cálculos y las fuentes/);
  }
  assert.equal(plan(6, '/revisar', session).action, 'reply');
  assert.deepEqual(answer.body.state.active.turns,
    [{ question: question.input.question, answer: 'El monto indicado es 770 MXN.' }]);
});

test('Las entradas anteriores siguen abriendo contratos sin mostrar las etiquetas anteriores', () => {
  for (const prefix of ['Contrato de prueba', 'Contrato ficticio']) {
    const pasted = plan(1, prefix + ':\n' + contract);
    assert.equal(pasted.action, 'save');
    assert.equal(pasted.body.state.active.document, contract);
    assert.equal(pasted.body.state.active.title, 'Contrato');
    assert.doesNotMatch(pasted.text, previousWording);
    const captioned = plan(2, { document: attachment, caption: prefix });
    assert.equal(captioned.action, 'download');
    assert.doesNotMatch(finishTelegramConversationDownload(captioned, Buffer.from(contract)).text, previousWording);
  }
  const pending = saved(plan(3, { document: attachment }));
  for (const confirmation of ['Sí, usé datos inventados', 'Sí, es ficticio', 'Confirmo que es ficticio']) {
    const downloaded = plan(4, confirmation, pending);
    assert.equal(downloaded.action, 'download');
    assert.doesNotMatch(finishTelegramConversationDownload(downloaded, Buffer.from(contract)).text, previousWording);
  }
});

test('Los formatos de reporte y storytelling consultan el caso activo y no abren una auditoría', () => {
  const activeCase = saved(plan(1, 'Contrato:\n' + contract));
  const modes = new Map([
    ['/reporte', 'Reporte ejecutivo'], ['/reporte ejecutivo', 'Reporte ejecutivo'],
    ['/reporte experto', 'Reporte experto'], ['/reporte abogado', 'Cláusulas para revisar con un abogado'],
    ['/clausulas', 'Cláusulas para revisar con un abogado'], ['/storytelling', 'Storytelling'],
  ]);
  for (const [text, label] of modes) {
    const query = plan(2, text, activeCase);
    assert.equal(query.input.workflow, 'qa');
    assert.equal(query.input.case_id, activeCase.state.active.case_id);
    assert.equal(query.report_label, label);
    const result = finishTelegramConversationAudit(query, {
      status: 'QA_READY', persisted: true, source_case_id: query.input.case_id, answer: 'Precio de 770 MXN.',
    }, []);
    assert(result.text.startsWith(label + '\n\n'));
    assert.equal(result.body.state.active.turns[0].answer, 'Precio de 770 MXN.');
  }
  assert.match(plan(3, '/reporte desconocido', activeCase).text, /Elige/);
  const canary = finishTelegramConversationAudit(plan(4, '/consulta ¿Cuánto?', activeCase), {
    status: 'HELD', reason: 'AFTON_TEST_CANARY',
  }, []);
  assert.match(canary.text, /marcador del ejercicio de seguridad/);
  assert.deepEqual(canary.body.state, activeCase.state);
});

test('Las fuentes documentales consultan referencias sin abrir una auditoría o cambiar la sesión', async () => {
  const catalogue = plan(1, '/fuentes');
  assert.equal(catalogue.action, 'reply');
  assert.match(catalogue.text, /Código Civil Federal/);
  const command = plan(2, '/fuentes compraventa');
  assert.equal(command.action, 'lookup');
  assert.equal(command.body.operation, 'legal_documental_search');
  assert.equal(command.body.query, 'compraventa');
  assert.equal(command.body.jurisdiction.country, 'MX');
  assert.match(command.body.jurisdiction.as_of, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(plan(3, '/fuentes entrega\npago').action, 'reply');
  assert.equal(Object.hasOwn(command, 'input'), false);

  const router = await buildTelegramConversation({
    storeUrl: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/contracter-store',
  });
  const renderer = router.nodes.find(node => node.name === 'Redactar estado del expediente');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const render = new AsyncFunction('$', '$input', renderer.parameters.jsCode);
  const payload = { statusCode: 200, body: { results: [{
    title: 'Código de Comercio', locator: 'Página PDF 50', quote: 'Fragmento de prueba',
    url: 'https://www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf', review_status: 'pending',
  }] } };
  const [reply] = await render(() => ({ itemMatching: () => ({ json: command }) }),
    { first: () => ({ json: payload }) });
  assert.equal(reply.json.chat_id, ownerId);
  assert.match(reply.json.text, /«Fragmento de prueba»/);
  assert.match(reply.json.text, /Revisión jurídica pendiente/);
  assert.doesNotMatch(reply.json.text, /Citas revisadas|legal_basis_status/);
});

test('Los dos flujos V2 son internos y el motor rechaza la ejecución sin datos aportados', async () => {
  const storeUrl = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/contracter-store';
  const router = await buildTelegramConversation({ storeUrl, ownerChat: ownerId, ownerUser: ownerId, geminiWorkflowId: 'v2-engine' });
  const engine = await buildLive({ storeUrl, provider: 'gemini', geminiConversation: true });
  assert(!router.nodes.some(node => node.type.endsWith('.telegramTrigger')));
  assert(!engine.nodes.some(node => node.type.endsWith('.manualTrigger')));
  for (const flow of [router, engine]) {
    const names = new Set(flow.nodes.map(node => node.name));
    for (const links of Object.values(flow.connections)) {
      assert(links.main.flat().every(link => names.has(link.node)));
    }
    assert.equal(flow.settings.saveDataSuccessExecution, 'none');
    assert.equal(flow.settings.saveDataErrorExecution, 'none');
    for (const step of flow.nodes.filter(node => node.type.endsWith('.code'))) {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      assert.doesNotThrow(() => new AsyncFunction(step.parameters.jsCode), step.name);
    }
    assert.doesNotMatch(JSON.stringify(flow), /vende a la Compradora de muestra 120 cajas/);
  }
  const motor = router.nodes.find(node => node.name === 'Ejecutar motor V2');
  assert.equal(motor.parameters.workflowId.value, 'v2-engine');
});
