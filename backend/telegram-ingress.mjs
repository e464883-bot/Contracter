const id = value => /^[1-9][0-9]{0,17}$/.test(String(value ?? '')) ? String(value) : null;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_DOCUMENT_CHARS = 12_000;
const MAX_ATTACHMENT_BYTES = 36_000;
const MAX_CAPTION_CHARS = 1_024;
const clarificationInstruction = 'Agrega Aclaración: seguida de tus respuestas en una sola línea de hasta 500 caracteres.';
const directOpenAIWarning = 'Esta ruta utiliza OpenAI y puede consumir créditos.';
const evaluationInstruction = 'Para ver las opciones de evaluación con datos ficticios, usa /evaluar.';
const DEMO_QUESTIONS = Object.freeze({
  entrega: '¿Qué ambigüedad tiene el plazo de entrega y qué debe aclarar la compradora?',
  pago: '¿Qué ambigüedad tiene el inicio del plazo de pago de 30 días y qué debe aclarar la compradora?',
  recepcion: '¿Cómo debería documentarse la recepción parcial y qué falta precisar para reportar diferencias de cantidad?',
});
const demoAttachmentInstruction = 'La demo admite exclusivamente el .txt de la muestra de Contracter. Envía /demo para seleccionarla directamente.';
const evaluationOptions = [
  'Evaluación de Contracter con un contrato ficticio incluido.',
  '/demo — abrir la muestra y recibir comandos para consultar distintos temas.',
  '/evaluar gemini consulta — ejecutar una consulta de muestra con Gemini.',
  '/evaluar gemini — ejecutar la auditoría completa con Gemini.',
  '/evaluar openai — consultar cómo confirmar la prueba fija con OpenAI.',
  '/evaluar gateway — consultar el estado de la alternativa Gateway.',
  '/evaluar confirmar — usar tu propio contrato ficticio con OpenAI. Incluye el formulario en el mismo mensaje.',
].join('\n');

const contextExample = [
  '/auditar confirmar',
  'Empresa: nuestra parte',
  'Contraparte: la otra parte',
  'Rol: comprador, proveedor u otro',
  'Objetivo: qué necesitas proteger o verificar',
  'Región: Federal',
  'Confirmo: sí',
];
const jurisdictionInstruction = 'Si aplica una entidad o municipio, indica Región y agrega Entidad (clave de 2 dígitos) y Municipio (clave de 3 dígitos).';
const attachmentInstructions = [
  'Adjunta un solo archivo .txt guardado como UTF-8 y escribe estos datos en el pie del mismo mensaje.',
  ...contextExample,
  'Para una consulta puntual usa /consulta confirmar y agrega Pregunta: … al pie.',
  evaluationInstruction,
  clarificationInstruction,
  jurisdictionInstruction,
].join('\n');
const instructions = [
  'Envía el texto del contrato en el mismo mensaje, con estos datos:',
  ...contextExample,
  '---',
  'Pega aquí el texto del contrato.',
  'Para una consulta puntual usa /consulta confirmar y agrega la línea Pregunta: … antes de ---.',
  evaluationInstruction,
  clarificationInstruction,
  jurisdictionInstruction,
  'También puedes adjuntar un .txt UTF-8. Escribe el comando y los datos en el pie del mismo mensaje, sin --- ni texto del contrato en el pie.',
].join('\n');

export function evaluationFixture() {
  return {
    title: 'Compraventa mercantil de evaluación',
    document: [
      'CONTRATO FICTICIO DE COMPRAVENTA MERCANTIL',
      '1. Objeto. La Proveedora de muestra vende a la Compradora de muestra 120 cajas de material de empaque por un precio total de $24,000 MXN, más los impuestos aplicables.',
      '2. Entrega. La Proveedora entregará los productos durante el próximo mes en el almacén de la Compradora. Puede dividir la entrega según su disponibilidad. La Compradora recibirá los productos cuando lleguen y la Proveedora dará por cumplida su obligación de entrega.',
      '3. Pago. La Compradora pagará en un plazo de 30 días. El plazo comenzará en cuanto la operación esté procesada. El precio se pagará mediante transferencia bancaria.',
      '4. Recepción. Las partes conservarán los comprobantes de entrega. En caso de diferencias de cantidad, la Compradora las comunicará a la Proveedora para su revisión.',
    ].join('\n\n'),
    context: {
      our_party: 'Compradora de muestra', counterparty: 'Proveedora de muestra', our_role: 'comprador',
      objectives: ['Precisar los plazos de entrega, documentar la recepción parcial y definir el inicio del plazo de pago.'],
      confirmed: true,
    },
    clarification: 'Las partes acuerdan entregar 60 cajas dentro de los primeros diez días naturales posteriores a la firma y 60 cajas dentro de los siguientes diez días. Cada recepción parcial debe documentar la cantidad recibida. El plazo de pago empieza al recibirse de conformidad las 120 cajas y la factura correspondiente.',
    jurisdiction: { region: 'Federal', entity_code: null, municipality_code: null },
  };
}

function eventUuid(digest) {
  return [digest.slice(0, 8), digest.slice(8, 12), '8' + digest.slice(13, 16),
    '8' + digest.slice(17, 20), digest.slice(20, 32)].join('-');
}

export function geminiDemoCaseId(ownerChatId, sha256) {
  const chat = id(ownerChatId);
  return chat ? eventUuid(sha256('contracter:gemini-demo:v1:' + chat)) : null;
}

export function demoQuestion(topic) {
  return Object.hasOwn(DEMO_QUESTIONS, topic) ? DEMO_QUESTIONS[topic] : null;
}

function demoReply(caseId) {
  return [
    'Expediente de muestra ' + caseId,
    'La compraventa ficticia contempla 120 cajas por $24,000 MXN y un plazo de pago de 30 días cuyo inicio es ambiguo.',
    'Puedes hacer las consultas por separado con Gemini Free. Conserva esta referencia para los siguientes mensajes.',
    ...Object.keys(DEMO_QUESTIONS).map(topic => '/pregunta ' + caseId + ' ' + topic),
  ].join('\n');
}

function requestIds(updateId, chat, sha256) {
  if (!Number.isSafeInteger(updateId) || updateId < 0) return null;
  const requestKey = 'contracter:telegram:' + chat + ':' + updateId;
  return { owner_chat_id: chat, run_id: eventUuid(sha256(requestKey + ':run')),
    case_id: eventUuid(sha256(requestKey + ':case')) };
}

function readForm(rest, workflow, attached) {
  const boundary = attached ? rest.length : rest.indexOf('\n---\n');
  if (boundary < 0) return null;
  const document = attached ? null : rest.slice(boundary + 5).trim();
  if (!attached && (!document || document.length > MAX_DOCUMENT_CHARS)) return null;
  const fields = Object.create(null);
  const accepted = ['empresa', 'contraparte', 'rol', 'objetivo', 'región',
    'entidad', 'municipio', 'confirmo', 'pregunta', 'aclaración'];
  for (const line of rest.slice(0, boundary).split('\n')) {
    const split = line.indexOf(':');
    const key = line.slice(0, split).trim().toLocaleLowerCase('es-MX');
    const value = line.slice(split + 1).trim();
    if (split < 1 || !accepted.includes(key) || !value || Object.hasOwn(fields, key)) return null;
    fields[key] = value;
  }
  if (!['empresa', 'contraparte', 'rol', 'objetivo', 'región'].every(key => fields[key])
    || !/^(sí|si)$/i.test(fields.confirmo || '')) return null;
  if (workflow === 'qa' && !fields.pregunta) return null;
  if ((fields.aclaración?.length ?? 0) > 500) return null;
  // Validate the attachment form before making a credentialed download.
  if (attached && (
    ['empresa', 'contraparte', 'rol'].some(key => fields[key].length > 200)
    || fields.objetivo.length > 500 || fields.región.length > 120 || (fields.pregunta?.length ?? 0) > 600
    || /TODO_|por confirmar|por definir/i.test(fields.región)
    || (fields.entidad ? !/^(0[1-9]|[12]\d|3[0-2])$/.test(fields.entidad) : !/^(federal|nacional)$/i.test(fields.región))
    || (fields.municipio && (!fields.entidad || !/^\d{3}$/.test(fields.municipio) || fields.municipio === '000'))
  )) return null;
  return {
    workflow, ...(attached ? {} : { document }),
    question: fields.pregunta,
    ...(fields.aclaración ? { clarification: fields.aclaración } : {}),
    context: {
      our_party: fields.empresa, counterparty: fields.contraparte, our_role: fields.rol,
      objectives: [fields.objetivo], confirmed: true,
    },
    jurisdiction: {
      region: fields.región, entity_code: fields.entidad || null, municipality_code: fields.municipio || null,
    },
  };
}

function attachmentMetadata(file) {
  if (typeof file?.file_name !== 'string' || !/\.txt$/i.test(file.file_name)
    || (file.mime_type !== undefined && (typeof file.mime_type !== 'string'
      || !/^text\/plain(?:;\s*charset=utf-8)?$/i.test(file.mime_type)))
    || typeof file.file_id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(file.file_id)
    || !Number.isSafeInteger(file.file_size) || file.file_size < 1 || file.file_size > MAX_ATTACHMENT_BYTES) return null;
  return { file_id: file.file_id, file_size: file.file_size };
}

export function telegramIngress(update, config, sha256) {
  const owner = id(config.owner_user_id);
  const ownerChat = id(config.owner_chat_id);
  if (!owner || !ownerChat) return null;
  const callback = update.callback_query;
  const message = callback?.message || update.message;
  const actor = id((callback?.from || message?.from)?.id);
  const chat = id(message?.chat?.id);
  if (message?.chat?.type !== 'private' || actor !== owner || chat !== ownerChat) return null;

  const reply = text => ({ action: 'reply', chat_id: chat, text });
  if (callback) {
    if (typeof callback.id !== 'string' || !/^ca:[ar]:[a-f0-9]{32}$/.test(callback.data || '')) return null;
    return { action: 'redeem', chat_id: chat, body: {
      operation: 'redeem_approval',
      callback_query: { id: callback.id, data: callback.data, from: { id: actor }, message: { chat: { id: chat } } },
    } };
  }
  const attached = message.document !== undefined;
  const content = attached ? message.caption : message.text;
  if (attached && (message.media_group_id || message.forward_origin || message.forward_date)) return reply(attachmentInstructions);
  if (typeof content !== 'string' || (attached && content.length > MAX_CAPTION_CHARS)) {
    return reply(attached ? attachmentInstructions : instructions);
  }
  const text = content.replace(/\r\n?/g, '\n').trim();
  const match = /^\/([a-z]+)(?:@ContracterExampleBot)?(?:[ \t\n]+([\s\S]*))?$/i.exec(text);
  if (!match) return reply(attached ? attachmentInstructions : 'Usa /help para ver los comandos de Contracter.');
  const command = match[1].toLowerCase();
  const rest = (match[2] || '').trim();
  const isAuditCommand = ['auditar', 'consulta', 'evaluar'].includes(command);
  const evaluation = command === 'evaluar';
  if (attached && command !== 'demo' && !isAuditCommand) return reply(attachmentInstructions);
  if (command === 'start' || command === 'help') {
    return reply('Contracter\n/demo — abrir el expediente ficticio de Gemini Free\n/pregunta UUID tema — consultar el mismo expediente de muestra\n/auditar — auditoría completa\n/consulta — consulta puntual\n/evaluar — opciones para evaluar con datos ficticios\n/estado — disponibilidad\n/expediente UUID — estado de un caso\n/revisar UUID — solicitar revisión humana autorizada');
  }
  if (command === 'estado') {
    return reply('Envía /evaluar para ver las opciones con datos ficticios. Las solicitudes de auditoría y consulta con OpenAI requieren confirmar el uso de créditos.');
  }
  if (command === 'expediente' || command === 'revisar') {
    if (!uuid.test(rest)) return reply('Incluye el UUID de tu expediente después del comando.');
    if (rest.toLowerCase() === geminiDemoCaseId(chat, sha256)) {
      return reply(command === 'expediente' ? demoReply(rest.toLowerCase()) : 'El expediente ficticio de la demo no se puede aprobar.');
    }
    return command === 'expediente'
      ? { action: 'lookup', chat_id: chat, body: { operation: 'get_case', audience: 'telegram', case_id: rest, owner_chat_id: chat } }
      : { action: 'issue', chat_id: chat, body: { operation: 'issue_approval', case_id: rest, chat_id: chat, approver_id: actor } };
  }
  if (command === 'demo' || command === 'pregunta') {
    if (message.forward_origin || message.forward_date) return reply('Escribe el comando directamente en este chat para iniciar la solicitud.');
    const caseId = geminiDemoCaseId(chat, sha256);
    if (command === 'demo') {
      if (attached) {
        const attachment = attachmentMetadata(message.document);
        if (rest || !attachment) return reply(demoAttachmentInstruction);
        return { action: 'download_attachment', chat_id: chat, demo_case_id: caseId, attachment };
      }
      if (rest && rest.replace(/^\uFEFF/, '').trim() !== evaluationFixture().document) return reply(demoAttachmentInstruction);
      return reply(demoReply(caseId));
    }
    const selection = /^(\S+)[ \t]+(entrega|pago|recepci[oó]n)$/i.exec(rest);
    if (!selection || selection[1].toLowerCase() !== caseId) {
      return reply('Usa /demo para obtener la referencia de tu expediente de muestra y los comandos de entrega, pago o recepción.');
    }
    const ids = requestIds(update.update_id, chat, sha256);
    if (!ids) return null;
    const topic = selection[2].toLowerCase().replace('ó', 'o');
    return { action: 'audit_gemini', chat_id: chat, input: {
      workflow: 'qa', demo_case_id: caseId, demo_topic: topic, synthetic: true,
      owner_chat_id: ids.owner_chat_id, run_id: ids.run_id,
    } };
  }
  if (!isAuditCommand) return reply('Usa /help para ver los comandos de Contracter.');
  if (message.forward_origin || message.forward_date) return reply('Escribe el comando directamente en este chat para iniciar la solicitud.');
  if (evaluation) {
    if (!rest) return reply(evaluationOptions);
    const provider = /^(gemini|openai|gateway)(?=$|\s)/i.exec(rest)?.[1].toLowerCase();
    if (provider) {
      const selection = rest.toLowerCase();
      const isConsultation = selection === 'gemini consulta';
      if (attached || !(selection === provider || isConsultation || selection === 'openai confirmar')) {
        return reply('La prueba con proveedor usa un contrato ficticio incluido. Envía el comando solo, sin contrato ni adjuntos.\n' + evaluationOptions);
      }
      if (provider === 'gateway') return reply('La alternativa Gateway está pendiente de configuración y verificación. Puedes consultar las opciones con /evaluar.');
      if (selection === 'openai') return reply(directOpenAIWarning + ' Para ejecutar la prueba fija, envía /evaluar openai confirmar.');
      const ids = requestIds(update.update_id, chat, sha256);
      if (!ids) return null;
      return { action: provider === 'gemini' ? 'audit_gemini' : 'audit_openai', chat_id: chat,
        input: { workflow: isConsultation ? 'qa' : 'full', ...evaluationFixture(), synthetic: true, ...ids } };
    }
  }
  const confirmation = /^confirmar(?:\n|$)/i.exec(rest);
  const guide = attached ? attachmentInstructions : instructions;
  if (!confirmation) {
    return reply(directOpenAIWarning + ' Inicia el mensaje con /' + command + ' confirmar y vuelve a incluir el formulario.'
      + '\n\n' + (evaluation ? guide.replace('/auditar confirmar', '/evaluar confirmar') : guide));
  }
  const input = readForm(rest.slice(confirmation[0].length), command === 'consulta' ? 'qa' : 'full', attached);
  if (!input) {
    return reply(evaluation ? guide.replace('/auditar confirmar', '/evaluar confirmar') : guide);
  }
  const attachment = attached ? attachmentMetadata(message.document) : null;
  if (attached && !attachment) {
    return reply('El adjunto debe ser un .txt UTF-8 con tamaño informado por Telegram de hasta 36 000 bytes.');
  }
  const ids = requestIds(update.update_id, chat, sha256);
  if (!ids) return null;
  return { action: attached ? 'download_attachment' : 'audit', chat_id: chat, input: {
    ...input, ...(evaluation ? { synthetic: true } : {}),
    ...ids,
  }, ...(attachment ? { attachment } : {}) };
}

export function telegramAttachment(command, bytes) {
  if (command?.action !== 'download_attachment') return null;
  const demo = typeof command.demo_case_id === 'string' && uuid.test(command.demo_case_id);
  const reject = () => ({ action: 'reply', chat_id: command.chat_id,
    text: demo ? demoAttachmentInstruction
      : 'El archivo debe ser texto UTF-8 legible de hasta 12 000 caracteres y 1500 líneas. Guarda el .txt y vuelve a adjuntarlo con el pie del mensaje.' });
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ATTACHMENT_BYTES
    || bytes.length !== command.attachment?.file_size) return reject();

  const text = bytes.toString('utf8');
  // Round-trip rejects invalid UTF-8 that Buffer.toString would otherwise replace.
  if (!Buffer.from(text, 'utf8').equals(bytes) || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(text)) return reject();
  const document = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!document || document.startsWith('%PDF-') || document.length > MAX_DOCUMENT_CHARS
    || document.split('\n').length > 1500) return reject();
  if (demo) return document === evaluationFixture().document
    ? { action: 'reply', chat_id: command.chat_id, text: demoReply(command.demo_case_id) } : reject();
  return { action: 'audit', chat_id: command.chat_id, input: { ...command.input, document } };
}

export function auditReply(result, allowedQuestions = [], inputAction = null, demoCaseId = null) {
  switch (result?.status) {
    case 'AWAITING_HUMAN':
      if (result.synthetic === true) {
        return 'Evaluación con datos ficticios. Expediente ' + result.case_id + '\nLa V2 está guardada sin opción de aprobación. Consulta el resumen con /expediente ' + result.case_id + '.';
      }
      return 'Expediente ' + result.case_id + '\nV2 retenida para revisión humana. Usa /revisar ' + result.case_id + ' si tienes autorización.';
    case 'QA_READY': {
      const evaluation = result.synthetic === true || inputAction === 'audit_gemini' || inputAction === 'audit_openai';
      const label = demoCaseId && uuid.test(demoCaseId) ? 'Expediente de muestra ' + demoCaseId + '\n'
        : evaluation ? 'Evaluación con datos ficticios.\n' : '';
      return (label + String(result.answer || 'Consulta registrada.')).slice(0, 3500);
    }
    case 'NO_REWRITE_REQUIRED':
      return 'Los auditores coincidieron en conservar el texto. La explicación quedó registrada para revisión humana.';
    case 'CONTEXT_REQUIRED': {
      const questions = Array.isArray(result.questions)
        ? [...new Set(result.questions)].filter(question => allowedQuestions.includes(question)).slice(0, 5)
        : [];
      if (inputAction === 'audit_gemini' || inputAction === 'audit_openai') {
        return ['La prueba fija quedó retenida porque el flujo pidió aclaraciones.', ...questions,
          'El equipo de Contracter debe revisar el contrato de muestra antes de repetir la prueba.'].join('\n');
      }
      if (!questions.length) return result.synthetic === true ? instructions.replace('/auditar confirmar', '/evaluar confirmar') : instructions;
      return [
        'El expediente necesita estas aclaraciones.',
        ...questions.map((question, index) => (index + 1) + '. ' + question),
        result.synthetic === true
          ? 'Reenvía el contrato y el formulario con /evaluar confirmar. Corrige los campos que correspondan.'
          : 'Reenvía el contrato y el formulario en un mensaje nuevo. Corrige los campos que correspondan.',
        clarificationInstruction,
      ].join('\n');
    }
    case 'DUPLICATE':
      return 'Esta solicitud ya fue registrada.';
    case 'STORE_UNAVAILABLE':
      return 'El servicio de expedientes no pudo confirmar el guardado. Revisa el estado de la ejecución antes de reenviar.';
    case 'HELD':
      if (result.reason === 'PROVIDER_CREDIT_EXHAUSTED') return 'Auditoría retenida: OpenAI informó saldo de créditos agotado.';
      if (result.reason === 'PROVIDER_CAPACITY_UNAVAILABLE') return 'Prueba retenida por saturación de Gemini. Puedes volver a intentarlo más tarde con /evaluar.';
      if (result.reason === 'PROVIDER_QUOTA_EXHAUSTED' && inputAction === 'audit_gemini') {
        return 'Prueba retenida: Gemini informó que alcanzó su cuota. Puedes reintentar cuando se renueve la cuota o consultar /evaluar para ver otras opciones.';
      }
      if (result.reason === 'LEGAL_SEARCH_UNAVAILABLE') return 'No se pudo consultar el buscador jurídico. La solicitud quedó retenida.';
      if (/LEGAL|SOURCE|GROUNDING/.test(result.reason || '')) {
        return 'Auditoría retenida: hacen falta fuentes jurídicas revisadas para el ámbito y la fecha del contrato.';
      }
      return 'Auditoría retenida. Código: ' + String(result.reason || 'CONTROL_PENDIENTE').slice(0, 90);
    default:
      return 'El servicio de auditoría aún no está disponible.';
  }
}
