import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { CLARIFICATION_QUESTIONS } from '../backend/live-audit.mjs';
import {
  OPENAI_MODEL, OPENAI_URL, OPENAI_PRICE, GEMINI_MODEL, GEMINI_URL, GEMINI_FREE_PRICE, geminiModelRequest,
} from '../backend/live-transport.mjs';
import { evaluationFixture } from '../backend/telegram-ingress.mjs';

const geminiFreeCredential = { name: 'Contracter · Gemini Free' };

const settings = {
  executionOrder: 'v1',
  saveDataSuccessExecution: 'none',
  saveDataErrorExecution: 'none',
  saveManualExecutions: false,
  saveExecutionProgress: false,
  timezone: 'America/Mexico_City',
};

function node(name, type, typeVersion, position, parameters, extra = {}) {
  return { id: randomUUID(), name, type: 'n8n-nodes-base.' + type, typeVersion, position, parameters, ...extra };
}

function code(name, position, jsCode) {
  return node(name, 'code', 2, position, { mode: 'runOnceForAllItems', jsCode });
}

function http(name, position, url, jsonBody, credentialType, credential, method = 'POST') {
  const auth = credentialType === 'openAiApi'
    ? { authentication: 'predefinedCredentialType', nodeCredentialType: credentialType }
    : { authentication: 'genericCredentialType', genericAuthType: credentialType };
  return node(name, 'httpRequest', 4.2, position, {
    method, url, ...auth, sendBody: true, specifyBody: 'json', jsonBody,
    options: {
      timeout: 35000,
      redirect: { redirect: { followRedirects: false } },
      response: { response: { responseFormat: 'json', fullResponse: true, neverError: true } },
    },
  }, {
    credentials: { [credentialType]: credential },
    retryOnFail: false,
    onError: 'continueRegularOutput',
  });
}

function workflow(name, nodes, links) {
  const connections = {};
  for (const [from, to, output = 0] of links) {
    const { main } = connections[from] ??= { main: [] };
    while (main.length <= output) main.push([]);
    main[output].push({ node: to, type: 'main', index: 0 });
  }
  return { name, nodes, connections, settings, active: false, pinData: {} };
}

export function buildSmoke(credential = { name: 'OpenAI account' }) {
  const request = {
    model: OPENAI_MODEL, store: false, max_output_tokens: 64, reasoning: { effort: 'none' },
    input: 'Synthetic connectivity check. Return status ok.',
    text: { format: {
      type: 'json_schema', name: 'contracter_connectivity', strict: true,
      schema: {
        type: 'object', properties: { status: { type: 'string', enum: ['ok'] } },
        required: ['status'], additionalProperties: false,
      },
    } },
  };
  const check = `const response = $input.first().json;
const body = response.body;
const parts = (body?.output || []).flatMap(item => item.content || []);
let value = null;
try { value = JSON.parse(parts.find(part => part.type === 'output_text')?.text || 'null'); } catch {}
return [{ json: {
  connected: response.statusCode === 200 && body?.status === 'completed' && value?.status === 'ok',
  http_status: response.statusCode || null,
  provider_error: body?.error?.code || body?.error?.type || (response.error ? 'network_or_credential' : null),
  model: body?.model || null,
  input_tokens: body?.usage?.input_tokens ?? null,
  output_tokens: body?.usage?.output_tokens ?? null,
} }];`;
  return workflow('CONTRACTER 04 · Prueba OpenAI', [
    node('Inicio manual', 'manualTrigger', 1, [0, 0], {}),
    http('OpenAI · prueba sintética', [250, 0], OPENAI_URL, JSON.stringify(request), 'openAiApi', credential),
    code('Resultado de conexión', [500, 0], check),
  ], [
    ['Inicio manual', 'OpenAI · prueba sintética'],
    ['OpenAI · prueba sintética', 'Resultado de conexión'],
  ]);
}

export async function buildGeminiSmoke(credential = geminiFreeCredential) {
  const schema = {
    type: 'object', properties: { status: { type: 'string', enum: ['ok'] } },
    required: ['status'], additionalProperties: false,
  };
  const request = geminiModelRequest({
    agent: 'Contracter', stage: 'connectivity', system: 'Devuelve un objeto JSON con status igual a ok.',
    input: 'Prueba ficticia de conectividad.', schema,
  });
  request.generationConfig.maxOutputTokens = 512;
  const transport = await read('../backend/live-transport.mjs');
  const check = 'const { geminiProviderResponse } = ' + capsule(transport, ['geminiProviderResponse']) + ';\n'
    + `const http = $input.first().json;
const reply = geminiProviderResponse(http, 0);
return [{json:{
  connected: http.statusCode === 200 && reply.model === ${JSON.stringify(GEMINI_MODEL)} && !reply.error
    && reply.output?.status === 'ok' && Object.keys(reply.output).length === 1,
  http_status: http.statusCode ?? null,
  provider_error: reply.error ?? null,
  model: reply.model ?? null,
  usage: reply.usage,
}}];`;
  return workflow('CONTRACTER 07 · Prueba Gemini Free', [
    node('Inicio manual', 'manualTrigger', 1, [0, 0], {}),
    http('Gemini · prueba ficticia', [250, 0], GEMINI_URL, JSON.stringify(request), 'httpHeaderAuth', credential),
    code('Resultado de conexión', [500, 0], check),
  ], [
    ['Inicio manual', 'Gemini · prueba ficticia'],
    ['Gemini · prueba ficticia', 'Resultado de conexión'],
  ]);
}

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const parse = async path => JSON.parse(await read(path));
const promptFiles = {
  Fury: '01_fury_orchestrator',
  Afton: '02_afton_securiter',
  House: '03_house_medic',
  Jane: '04_jane_questioner',
  Sherlock: '05_sherlock_explorer',
  Morty: '06_morty_inexpert',
  Harvey: '07_harvey_consulter',
  Murdock: '08_murdock_advocate',
  Lupin: '09_lupin_loopholes',
  Hamilton: '10_hamilton_writer',
  Jarvis: '11_jarvis_changelog',
  Watson: '12_watson_reporter',
  Glenn: '13_glenn_storyteller',
};

export async function loadAuditConfig() {
  const prompts = await Promise.all(Object.entries(promptFiles).map(async ([agent, file]) => [
    agent, await read('../agents/prompts/' + file + '.md'),
  ]));
  const [afton, house, audit, final] = await Promise.all([
    'afton_security', 'house_medic', 'audit_agent', 'final_contract',
  ].map(name => parse('../agents/schemas/' + name + '.schema.json')));
  return {
    prompts: Object.fromEntries(prompts), schemas: { afton, house, audit, final },
    pricing: OPENAI_PRICE, maxRounds: 3, maxRetries: 2,
  };
}

function capsule(source, names) {
  // Bundle only local source files. Cloud Code nodes cannot import workspace modules.
  if (/^import\s/m.test(source)) throw new Error('La biblioteca de Code debe ser autocontenida.');
  const script = source.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const)\s)/gm, '');
  if (/^export\s/m.test(script)) throw new Error('Exportación de Code no reconocida.');
  return '(() => {\n' + script + '\nreturn { ' + names.join(', ') + ' };\n})()';
}

function isEqual(name, position, expression, rightValue) {
  return node(name, 'if', 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: randomUUID(), leftValue: expression, rightValue,
        operator: { type: 'string', operation: 'equals' },
      }],
      combinator: 'and',
    },
    options: {},
  });
}

function storeEndpoint(value) {
  const url = new URL(value);
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co\/functions\/v1\/contracter-store$/.test(url.href)) {
    throw new Error('Usa la URL HTTPS exacta del Edge Function de Contracter.');
  }
  return url.href;
}

export async function buildLive({
  storeUrl,
  provider = 'openai',
  geminiConversation = false,
  openAiCredential = { name: 'OpenAI account' },
  geminiCredential = geminiFreeCredential,
  auditCredential = { name: 'Contracter · Datos auditoría' },
} = {}) {
  if (!['openai', 'gemini'].includes(provider)) throw new Error('Proveedor de auditoría no admitido.');
  const useGemini = provider === 'gemini';
  if (geminiConversation && !useGemini) throw new Error('Esta ruta de conversación usa Gemini Free.');
  const useLegacyGemini = useGemini && !geminiConversation;
  const [core, transport, config, ingress] = await Promise.all([
    read('../backend/live-audit.mjs'), read('../backend/live-transport.mjs'), loadAuditConfig(),
    useLegacyGemini ? read('../backend/telegram-ingress.mjs') : null,
  ]);
  if (useGemini) config.pricing = GEMINI_FREE_PRICE;
  const providerOption = JSON.stringify(provider);
  const initCode = geminiConversation
    ? 'const { geminiTestState } = ' + capsule(transport, ['geminiTestState']) + ';\n'
      + 'const { randomUUID, createHash } = require("crypto");\n'
      + 'const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");\n'
      + `try {
  const state = geminiTestState($input.first().json, { now: new Date().toISOString(), uuid: randomUUID, sha256 });
  return [{json:{state}}];
} catch (error) {
  if (error.message !== 'GEMINI_TEST_INPUT_INVALID') throw error;
  return [{json:{next:'done',result:{status:'HELD',reason:'GEMINI_TEST_INPUT_INVALID',synthetic:true,persisted:false}}}];
}`
    : useLegacyGemini
    ? 'const { geminiDemoState } = ' + capsule(transport, ['geminiDemoState']) + ';\n'
      + 'const { geminiDemoCaseId, demoQuestion } = ' + capsule(ingress, ['geminiDemoCaseId', 'demoQuestion']) + ';\n'
      + 'const { randomUUID, createHash } = require("crypto");\n'
      + 'const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");\n'
      + 'const fixture = ' + JSON.stringify(evaluationFixture()) + ';\n'
      + `try {
  const state = geminiDemoState($input.first().json, { now: new Date().toISOString(), uuid: randomUUID, sha256,
    fixture, demoCaseId: geminiDemoCaseId, demoQuestion });
  return [{json:{state}}];
} catch (error) {
  if (error.message !== 'GEMINI_DEMO_INVALID') throw error;
  return [{json:{next:'done',result:{status:'HELD',reason:'GEMINI_DEMO_INVALID',synthetic:true,persisted:false}}}];
}`
    : 'const { workflowState } = ' + capsule(transport, ['workflowState']) + ';\n'
    + 'const { randomUUID } = require("crypto");\n'
    + 'const state = workflowState($input.first().json, { now: new Date().toISOString(), uuid: randomUUID });\n'
    + 'return [{json:{state}}];';
  const advanceCode = 'const { runLiveAudit } = ' + capsule(core, ['runLiveAudit']) + ';\n'
    + 'const { advanceWorkflow } = ' + capsule(transport, ['advanceWorkflow']) + ';\n'
    + 'const { createHash } = require("crypto");\n'
    + 'const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");\n'
    + 'const config = ' + JSON.stringify(config) + ';\n'
    + 'return [{json: await advanceWorkflow($input.first().json, {runLiveAudit,sha256,config,provider:' + providerOption + '})}];';
  const consumeCode = 'const { acceptStep } = ' + capsule(transport, ['acceptStep']) + ';\n'
    + 'const step = $("Orquestar paso").itemMatching(0).json;\n'
    + 'return [{json: acceptStep(step, $input.first().json, Date.now(), ' + providerOption + ')}];';
  const modelNode = useGemini ? 'Gemini Free · respuesta estructurada' : 'OpenAI · Structured Outputs';
  const resultCode = 'return [{json: {...$input.first().json.result, provider:' + providerOption + '}}];';
  const title = geminiConversation ? 'CONTRACTER V2 · Motor Gemini Free'
    : useGemini ? 'CONTRACTER 08 · Evaluación con Gemini Free' : 'CONTRACTER 05 · Auditoría y consultas';
  return workflow(title, [
    node('Entrada interna', 'executeWorkflowTrigger', 1.1, [0, 0], { inputSource: 'passthrough' }),
    ...(useLegacyGemini ? [node('Consulta ficticia manual', 'manualTrigger', 1, [0, 220], {})] : []),
    code('Iniciar expediente', [240, 0], initCode),
    code('Orquestar paso', [480, 0], advanceCode),
    isEqual('¿Terminó?', [720, 0], '={{ $json.next }}', 'done'),
    code('Resultado privado', [960, -180], resultCode),
    isEqual('¿Llamada de modelo?', [960, 100], '={{ $json.next }}', 'openai'),
    http(modelNode, [1200, 20], useGemini ? GEMINI_URL : OPENAI_URL,
      '={{ JSON.stringify($json.request.body) }}', useGemini ? 'httpHeaderAuth' : 'openAiApi',
      useGemini ? geminiCredential : openAiCredential),
    http('Supabase · datos de auditoría', [1200, 220], storeEndpoint(storeUrl),
      '={{ JSON.stringify($json.request.body) }}', 'httpHeaderAuth', auditCredential),
    code('Recibir respuesta', [1450, 100], consumeCode),
  ], [
    ['Entrada interna', 'Iniciar expediente'],
    ...(useLegacyGemini ? [['Consulta ficticia manual', 'Iniciar expediente']] : []),
    ['Iniciar expediente', 'Orquestar paso'],
    ['Orquestar paso', '¿Terminó?'],
    ['¿Terminó?', 'Resultado privado'],
    ['¿Terminó?', '¿Llamada de modelo?', 1],
    ['¿Llamada de modelo?', modelNode],
    ['¿Llamada de modelo?', 'Supabase · datos de auditoría', 1],
    [modelNode, 'Recibir respuesta'],
    ['Supabase · datos de auditoría', 'Recibir respuesta'],
    ['Recibir respuesta', 'Orquestar paso'],
  ]);
}

export async function buildTelegramConversation({
  storeUrl,
  geminiWorkflowId = 'TODO_GEMINI_V2_WORKFLOW_ID',
  ownerChat = 'TODO_TELEGRAM_CHAT_ID',
  ownerUser = 'TODO_TELEGRAM_OWNER_ID',
  allowedChats = [],
  telegramCredential = { name: 'Contracter · Telegram' },
  readCredential = { name: 'Contracter · Lectura Telegram' },
} = {}) {
  const ingress = await read('../backend/telegram-conversation.mjs');
  const endpoint = storeEndpoint(storeUrl);
  const settings = JSON.stringify({ owner_chat_id: ownerChat, owner_user_id: ownerUser, allowed_chats: allowedChats });
  const sessionHttp = (name, position) => http(name, position, endpoint,
    '={{ JSON.stringify($json.body) }}', 'httpHeaderAuth', readCredential);
  const condition = (name, position, action) => isEqual(name, position, '={{ $json.action }}', action);
  const credential = { credentials: { telegramApi: telegramCredential } };
  const prepare = 'const { conversationAccess } = ' + capsule(ingress, ['conversationAccess']) + ';\n' + `
const update = $input.first().json;
const access = conversationAccess(update, ${settings});
return access ? [{json:{update,access,body:{operation:'get_telegram_session',owner_chat_id:access.chat_id}}}] : [];
`;
  const route = 'const { planTelegramConversation } = ' + capsule(ingress, ['planTelegramConversation']) + ';\n' + `
const {createHash} = require('crypto');
const {update,access} = $("Identificar chat autorizado").itemMatching(0).json;
const response = $input.first().json;
const session = response.body;
if (response.statusCode !== 200 || !Number.isSafeInteger(session?.revision)
  || (session.last_message_id !== null && !Number.isSafeInteger(session.last_message_id))) {
  return [{json:{action:'reply',chat_id:access.chat_id,text:'No pude abrir la sesión del chat. Intenta de nuevo en un momento.'}}];
}
const command = planTelegramConversation(update, access, session,
  value => createHash('sha256').update(value, 'utf8').digest('hex'));
return command ? [{json:command}] : [];
`;
  const download = 'const { finishTelegramConversationDownload } = ' + capsule(ingress, ['finishTelegramConversationDownload']) + ';\n' + `
const command = $("¿Descargar adjunto de prueba?").itemMatching(0).json;
let bytes;
try {
  if ($input.first().binary?.data) bytes = await this.helpers.getBinaryDataBuffer(0, 'data');
} catch { /* Do not return Telegram's download error, which can contain file metadata. */ }
return [{json:finishTelegramConversationDownload(command, bytes)}];
`;
  const finish = 'const { finishTelegramConversationAudit } = ' + capsule(ingress, ['finishTelegramConversationAudit']) + ';\n' + `
const command = $("¿Ejecutar Gemini Free?").itemMatching(0).json;
const result = $input.first().json;
return [{json:finishTelegramConversationAudit(command, result, ${JSON.stringify(CLARIFICATION_QUESTIONS)})}];
`;
  const saved = `
const command = $("¿Guardar sesión?").itemMatching(0).json;
const response = $input.first().json;
if (response.statusCode === 409 && command.input) return [];
const text = response.statusCode === 200 ? command.text
  : response.statusCode === 409 ? 'Otro mensaje cambió el expediente. Envía tu mensaje otra vez para aplicarlo al caso actual.'
    : 'No pude confirmar el cambio en la sesión. Intenta de nuevo en un momento.';
return [{json:{chat_id:command.chat_id,text}}];
`;
  const archived = `
const command = $("¿Consultar expediente por ID?").itemMatching(0).json;
const response = $input.first().json;
if (command.body.operation === 'legal_documental_search') {
  const rows = response.statusCode === 200 && Array.isArray(response.body?.results) ? response.body.results : null;
  const text = !rows ? 'No pude consultar las referencias documentales. Intenta de nuevo en un momento.'
    : !rows.length ? 'No encontré ese término en los documentos incorporados. Prueba /fuentes compraventa o /fuentes para ver el catálogo.'
    : ['Fragmentos del documento oficial. La aplicabilidad al contrato requiere revisión jurídica.',
      ...rows.slice(0, 2).map(row => [
        row.title + ' · ' + row.locator,
        '«' + row.quote + '»',
        row.review_status === 'approved' ? 'Revisión registrada en el corpus.' : 'Revisión jurídica pendiente.',
        row.url,
      ].join('\\n')),
    ].join('\\n\\n');
  return [{json:{chat_id:command.chat_id,text}}];
}
const detail = response.statusCode === 200 && response.body?.case ? response.body : null;
const text = detail ? ['Expediente ' + detail.case.case_id, 'Estado ' + detail.status,
    detail.case.reports?.watson?.summary || 'Consulta el expediente en el panel privado.'].join('\\n')
  : 'No encontré un expediente con ese ID en este chat. Usa /expediente para ver el caso activo.';
return [{json:{chat_id:command.chat_id,text:text.slice(0,3500)}}];
`;
  return workflow('CONTRACTER V2 · Telegram conversacional', [
    node('Entrada del bot privado', 'executeWorkflowTrigger', 1.1, [0, 0], { inputSource: 'passthrough' }),
    code('Identificar chat autorizado', [220, 0], prepare),
    sessionHttp('Leer sesión privada', [440, 0]),
    code('Interpretar mensaje', [660, 0], route),
    condition('¿Descargar adjunto de prueba?', [880, 0], 'download'),
    node('Descargar .txt privado', 'telegram', 1.2, [1100, -220], {
      resource: 'file', operation: 'get', fileId: '={{ $json.attachment.file_id }}',
      download: true, additionalFields: {},
    }, { ...credential, retryOnFail: false, onError: 'continueRegularOutput' }),
    code('Abrir contrato recibido', [1320, -220], download),
    condition('¿Ejecutar Gemini Free?', [1540, 0], 'gemini'),
    code('Preparar solicitud de agentes', [1760, -260], 'return [{json:$input.first().json.input}];'),
    node('Ejecutar motor V2', 'executeWorkflow', 1.3, [1980, -260], {
      source: 'database', workflowId: { __rl: true, mode: 'id', value: geminiWorkflowId },
      mode: 'once', options: { waitForSubWorkflow: true },
    }, { onError: 'continueRegularOutput' }),
    code('Preparar respuesta del caso', [2200, -260], finish),
    condition('¿Guardar sesión?', [2420, 0], 'save'),
    sessionHttp('Guardar sesión privada', [2640, -220]),
    code('Confirmar respuesta vigente', [2860, -220], saved),
    condition('¿Consultar expediente por ID?', [2640, 160], 'lookup'),
    sessionHttp('Leer expediente de este chat', [2860, 220]),
    code('Redactar estado del expediente', [3080, 220], archived),
    node('Responder en Telegram', 'telegram', 1.2, [3300, 0], {
      resource: 'message', operation: 'sendMessage', chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}',
      additionalFields: { appendAttribution: false },
    }, credential),
  ], [
    ['Entrada del bot privado', 'Identificar chat autorizado'],
    ['Identificar chat autorizado', 'Leer sesión privada'],
    ['Leer sesión privada', 'Interpretar mensaje'],
    ['Interpretar mensaje', '¿Descargar adjunto de prueba?'],
    ['¿Descargar adjunto de prueba?', 'Descargar .txt privado'],
    ['Descargar .txt privado', 'Abrir contrato recibido'],
    ['Abrir contrato recibido', '¿Ejecutar Gemini Free?'],
    ['¿Descargar adjunto de prueba?', '¿Ejecutar Gemini Free?', 1],
    ['¿Ejecutar Gemini Free?', 'Preparar solicitud de agentes'],
    ['Preparar solicitud de agentes', 'Ejecutar motor V2'],
    ['Ejecutar motor V2', 'Preparar respuesta del caso'],
    ['Preparar respuesta del caso', '¿Guardar sesión?'],
    ['¿Ejecutar Gemini Free?', '¿Guardar sesión?', 1],
    ['¿Guardar sesión?', 'Guardar sesión privada'],
    ['Guardar sesión privada', 'Confirmar respuesta vigente'],
    ['Confirmar respuesta vigente', 'Responder en Telegram'],
    ['¿Guardar sesión?', '¿Consultar expediente por ID?', 1],
    ['¿Consultar expediente por ID?', 'Leer expediente de este chat'],
    ['Leer expediente de este chat', 'Redactar estado del expediente'],
    ['Redactar estado del expediente', 'Responder en Telegram'],
    ['¿Consultar expediente por ID?', 'Responder en Telegram', 1],
  ]);
}

export async function buildTelegram({
  storeUrl,
  auditWorkflowId = 'TODO_LIVE_WORKFLOW_ID',
  geminiWorkflowId = 'TODO_GEMINI_WORKFLOW_ID',
  geminiOnly = false,
  internalRouter = false,
  ownerChat = 'TODO_TELEGRAM_CHAT_ID',
  ownerUser = 'TODO_TELEGRAM_OWNER_ID',
  telegramCredential = { name: 'Contracter · Telegram' },
  approvalCredential = { name: 'Contracter · Aprobación' },
  readCredential = { name: 'Contracter · Lectura Telegram' },
} = {}) {
  const ingress = await read('../backend/telegram-ingress.mjs');
  const parseUpdate = 'const { telegramIngress } = ' + capsule(ingress, ['telegramIngress']) + ';\n'
    + 'const { createHash } = require("crypto");\n'
    + 'const settings = ' + JSON.stringify({ owner_chat_id: ownerChat, owner_user_id: ownerUser }) + ';\n'
    + 'const command = telegramIngress($input.first().json, settings, value => createHash("sha256").update(value).digest("hex"));\n'
    + (geminiOnly ? `if (command?.action === 'download_attachment' && typeof command.demo_case_id !== 'string') {
  return [{json:{action:'reply',chat_id:command.chat_id,text:'Envía el .txt de muestra con /demo para usar Gemini Free.'}}];
}\n` : '')
    + 'return command ? [{json:command}] : [];';
  const decodeAttachment = 'const { telegramAttachment } = ' + capsule(ingress, ['telegramAttachment']) + ';\n'
    + 'const command = $("Validar entrada Telegram").itemMatching(0).json;\n'
    + 'let bytes;\n'
    + 'try {\n'
    + '  if ($input.first().binary?.data) bytes = await this.helpers.getBinaryDataBuffer(0, "data");\n'
    + '} catch { /* Drop the native download error, including any URL or file metadata. */ }\n'
    + 'const result = telegramAttachment(command, bytes);\n'
    + 'return result ? [{json:result}] : [];';
  const explainAudit = 'const { auditReply } = ' + capsule(ingress, ['auditReply']) + ';\n'
    + 'const result = $input.first().json;\n'
    + 'const {chat_id,action,input} = $("Validar entrada Telegram").itemMatching(0).json;\n'
    + 'return [{json:{chat_id,text:auditReply(result, ' + JSON.stringify(CLARIFICATION_QUESTIONS)
    + ', action, input?.demo_case_id)}}];';
  const explainLookup = [
    'const result = $input.first().json;',
    'const command = $("Validar entrada Telegram").itemMatching(0).json;',
    'const detail = result.statusCode === 200 && result.body?.case ? result.body : null;',
    'const text = detail ? ["Expediente " + detail.case.case_id, "Estado " + detail.status,',
    '  detail.synthetic ? "Prueba sintética" : "Expediente privado",',
    '  detail.case.reports?.watson?.summary || "Consulta el expediente en el panel privado."].join("\\n")',
    '  : "No se pudo consultar ese expediente con este chat.";',
    'return [{json:{chat_id:command.chat_id,text:text.slice(0,3500)}}];',
  ].join('\n');
  const explainApproval = [
    'const result = $input.first().json;',
    'const command = $("Validar entrada Telegram").itemMatching(0).json;',
    'const payload = {chat_id:command.chat_id,text:"La revisión no pudo registrarse. Verifica permiso, vigencia y expediente."};',
    'const body = result.statusCode === 200 ? result.body : null;',
    'if (command.action === "issue" && body && /^ca:a:[a-f0-9]{32}$/.test(body.approve_data)',
    '  && /^ca:r:[a-f0-9]{32}$/.test(body.reject_data) && /^[a-f0-9]{64}$/.test(body.v2_sha256)) {',
    '  payload.text = ["Revisión humana de V2", "Expediente " + body.case_id,',
    '    "SHA-256 " + body.v2_sha256, "Revisa V2 en el panel privado antes de decidir.",',
    '    "Caduca " + body.expires_at].join("\\n");',
    '  payload.approve = body.approve_data;',
    '  payload.reject = body.reject_data;',
    '} else if (command.action === "redeem" && ["APPROVED", "REJECTED"].includes(body?.status)) {',
    '  payload.text = "Decisión registrada para " + body.case_id + ": " + (body.status === "APPROVED" ? "aprobada" : "rechazada") + ".";',
    '}',
    'return [{json:payload}];',
  ].join('\n');
  const body = '={{ JSON.stringify($json.body) }}';
  const endpoint = storeEndpoint(storeUrl);
  const callAudit = (name, position, id) => node(name, 'executeWorkflow', 1.3, position, {
    source: 'database', workflowId: { __rl: true, mode: 'id', value: id },
    mode: 'once', options: { waitForSubWorkflow: true },
  }, { onError: 'continueRegularOutput' });
  const openAIPath = geminiOnly
    ? [code('Disponibilidad de OpenAI', [1440, -180],
      'return [{json:{chat_id:$input.first().json.chat_id,text:"OpenAI directo puede consumir créditos y aún no está disponible en este bot. Usa /demo para la evaluación con Gemini Free."}}];')]
    : [code('Entrada de agentes', [1440, -180], 'return [{json:$input.first().json.input}];'),
      callAudit('Ejecutar agentes', [1680, -180], auditWorkflowId)];
  const reviewPath = geminiOnly
    ? [code('Revisión pendiente', [1920, 280],
      'return [{json:{chat_id:$input.first().json.chat_id,text:"La revisión humana está pendiente de configuración. El contrato permanece retenido."}}];')]
    : [http('Aplicar revisión autorizada', [1920, 280], endpoint, body, 'httpHeaderAuth', approvalCredential),
      code('Redactar estado de revisión', [2160, 280], explainApproval)];
  const telegramEntry = internalRouter
    ? node('Entrada del bot privado', 'executeWorkflowTrigger', 1.1, [0, 0], { inputSource: 'passthrough' })
    : node('Telegram privado', 'telegramTrigger', 1.4, [0, 0], {
      updates: geminiOnly ? ['message'] : ['message', 'callback_query'],
      additionalFields: { chatIds: ownerChat, userIds: ownerUser, download: false },
    }, { credentials: { telegramApi: telegramCredential } });
  return workflow(geminiOnly ? 'CONTRACTER · Telegram · evaluación Gemini' : 'CONTRACTER 06 · Telegram y revisión', [
    telegramEntry,
    code('Validar entrada Telegram', [240, 0], parseUpdate),
    isEqual('¿Descargar adjunto?', [480, 0], '={{ $json.action }}', 'download_attachment'),
    node('Descargar .txt privado', 'telegram', 1.2, [720, -210], {
      resource: 'file', operation: 'get', fileId: '={{ $json.attachment.file_id }}', download: true, additionalFields: {},
    }, { credentials: { telegramApi: telegramCredential }, retryOnFail: false, onError: 'continueRegularOutput' }),
    code('Validar y extraer texto', [960, -210], decodeAttachment),
    isEqual('¿Gemini Free?', [1200, 0], '={{ $json.action }}', 'audit_gemini'),
    code('Entrada ficticia Gemini', [1440, -430], 'return [{json:$input.first().json.input}];'),
    callAudit('Ejecutar agentes Gemini', [1680, -430], geminiWorkflowId),
    isEqual('¿Auditoría o consulta?', [1200, 220],
      '={{ ["audit","audit_openai"].includes($json.action) ? "audit" : $json.action }}', 'audit'),
    ...openAIPath,
    code('Redactar respuesta de auditoría', [1920, -180], explainAudit),
    isEqual('¿Ver expediente?', [1440, 80], '={{ $json.action }}', 'lookup'),
    http('Leer expediente de este chat', [1680, 50], endpoint, body, 'httpHeaderAuth', readCredential),
    code('Redactar estado privado', [1920, 50], explainLookup),
    isEqual('¿Acción de revisión?', [1680, 280],
      '={{ ["issue","redeem"].includes($json.action) ? "review" : "reply" }}', 'review'),
    ...reviewPath,
    node('Responder al propietario', 'telegram', 1.2, [2430, 30], {
      resource: 'message', operation: 'sendMessage', chatId: '={{ $json.chat_id }}', text: '={{ $json.text }}',
      replyMarkup: '={{ $json.approve && $json.reject ? "inlineKeyboard" : "none" }}',
      inlineKeyboard: { rows: [{ row: { buttons: [
        { text: 'Aprobar V2', additionalFields: { callback_data: '={{ $json.approve }}' } },
        { text: 'Rechazar V2', additionalFields: { callback_data: '={{ $json.reject }}' } },
      ] } }] },
      additionalFields: { appendAttribution: false },
    }, { credentials: { telegramApi: telegramCredential } }),
  ], [
    [telegramEntry.name, 'Validar entrada Telegram'],
    ['Validar entrada Telegram', '¿Descargar adjunto?'],
    ['¿Descargar adjunto?', 'Descargar .txt privado'],
    ['Descargar .txt privado', 'Validar y extraer texto'],
    ['Validar y extraer texto', '¿Gemini Free?'],
    ['¿Descargar adjunto?', '¿Gemini Free?', 1],
    ['¿Gemini Free?', 'Entrada ficticia Gemini'],
    ['Entrada ficticia Gemini', 'Ejecutar agentes Gemini'],
    ['Ejecutar agentes Gemini', 'Redactar respuesta de auditoría'],
    ['¿Gemini Free?', '¿Auditoría o consulta?', 1],
    ...(geminiOnly ? [['¿Auditoría o consulta?', 'Disponibilidad de OpenAI'],
      ['Disponibilidad de OpenAI', 'Responder al propietario']]
      : [['¿Auditoría o consulta?', 'Entrada de agentes'], ['Entrada de agentes', 'Ejecutar agentes'],
        ['Ejecutar agentes', 'Redactar respuesta de auditoría']]),
    ['Redactar respuesta de auditoría', 'Responder al propietario'],
    ['¿Auditoría o consulta?', '¿Ver expediente?', 1],
    ['¿Ver expediente?', 'Leer expediente de este chat'],
    ['Leer expediente de este chat', 'Redactar estado privado'],
    ['Redactar estado privado', 'Responder al propietario'],
    ['¿Ver expediente?', '¿Acción de revisión?', 1],
    ...(geminiOnly ? [['¿Acción de revisión?', 'Revisión pendiente'], ['Revisión pendiente', 'Responder al propietario']]
      : [['¿Acción de revisión?', 'Aplicar revisión autorizada'],
        ['Aplicar revisión autorizada', 'Redactar estado de revisión'],
        ['Redactar estado de revisión', 'Responder al propietario']]),
    ['¿Acción de revisión?', 'Responder al propietario', 1],
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [kind, destination, storeUrl, auditWorkflowId, geminiWorkflowId, v2OwnerUser] = process.argv.slice(2);
  if (!destination || !['smoke', 'live', 'telegram', 'telegram-demo', 'gemini-smoke', 'gemini', 'gemini-v2', 'telegram-v2'].includes(kind)) {
    throw new Error('Uso: node scripts/build_live_workflow.mjs smoke|live|telegram|telegram-demo|gemini-smoke|gemini|gemini-v2|telegram-v2 destino.json [URL datos] [ID auditoría] [ID Gemini]');
  }
  const built = kind === 'smoke' ? buildSmoke()
    : kind === 'gemini-smoke' ? await buildGeminiSmoke()
    : kind === 'telegram-v2' ? await buildTelegramConversation({ storeUrl, geminiWorkflowId: auditWorkflowId,
      ownerChat: geminiWorkflowId, ownerUser: v2OwnerUser })
    : kind === 'telegram' || kind === 'telegram-demo'
      ? await buildTelegram({ storeUrl, auditWorkflowId, geminiWorkflowId,
        geminiOnly: kind === 'telegram-demo', internalRouter: kind === 'telegram-demo' })
    : await buildLive({ storeUrl, provider: kind.startsWith('gemini') ? 'gemini' : 'openai',
      geminiConversation: kind === 'gemini-v2' });
  await writeFile(destination, JSON.stringify(built, null, 2) + '\n', 'utf8');
}
