const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const maxDocumentChars = 12_000;
const maxAttachmentBytes = 36_000;
const maxQuestionChars = 600;
const empty = { active: null, pending: null };
const analysisNotice = 'Advertencia. Contracter está trabajando con Gemini Free. Puede cometer errores.';
const uploadHelp = 'Envía un .txt UTF-8 o pega el texto después de escribir “Contrato:” en una línea aparte.';
const reportRequests = {
  experto: {
    label: 'Reporte experto',
    question: 'Resume las obligaciones, montos, plazos y dependencias del contrato. Para cada riesgo operativo, indica su cláusula, qué falta por aclarar y una acción para la parte que consulta.',
  },
  ejecutivo: {
    label: 'Reporte ejecutivo',
    question: 'Resume en español la decisión comercial que plantea el contrato. Indica compromisos principales, costo o beneficio calculable, riesgos prioritarios y qué puntos conviene negociar antes de firmar.',
  },
  abogado: {
    label: 'Cláusulas para revisar con un abogado',
    question: 'Enumera las cláusulas del contrato que merecen revisión por su redacción, alcance o asimetría. Para cada una, indica su referencia, un fragmento textual comprobable y la pregunta que conviene plantear al revisor.',
  },
  storytelling: {
    label: 'Storytelling',
    question: 'Explica el contrato con una escena breve y sencilla. Distingue lo que las partes prometen, lo que ocurre si se cumple y lo que queda abierto si algo sale mal. Identifica como ejemplos los escenarios hipotéticos.',
  },
};
const menu = [
  'Hola, soy Contracter. ' + uploadHelp,
  analysisNotice,
  'Con un contrato activo, escribe una pregunta o pídeme que lo audite.',
  '/pregunta o /consulta · pregunta sobre el contrato',
  '/auditar · revisa cláusulas y propone cambios',
  '/reporte ejecutivo, /reporte experto o /reporte abogado · cambia el enfoque de la respuesta',
  '/storytelling · explica el contrato con un ejemplo',
  '/fuentes · consulta documentos oficiales y busca fragmentos',
  '/expediente · muestra el ID y el estado del caso activo',
  '/revisar · consulta la revisión humana',
  '/reset · limpia el caso activo para empezar de nuevo',
].join('\n');

function toId(value) {
  return /^[1-9][0-9]{0,17}$/.test(String(value ?? '')) ? String(value) : null;
}

export function conversationAccess(update, config) {
  const message = update?.message;
  const chat = toId(message?.chat?.id);
  const actor = toId(message?.from?.id);
  if (!chat || !actor || message.chat.type !== 'private'
    || !Number.isSafeInteger(message.message_id) || message.message_id < 1
    || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return null;
  const allowed = [config, ...(config.allowed_chats || [])];
  if (!allowed.some(entry => chat === toId(entry.owner_chat_id) && actor === toId(entry.owner_user_id))) return null;
  return { chat_id: chat, message_id: message.message_id };
}

function eventId(sha256, chat, updateId, kind) {
  const hash = sha256('contracter:telegram-v2:' + chat + ':' + updateId + ':' + kind);
  return [hash.slice(0, 8), hash.slice(8, 12), '8' + hash.slice(13, 16),
    '8' + hash.slice(17, 20), hash.slice(20, 32)].join('-');
}

function plainText(raw) {
  if (typeof raw !== 'string' || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(raw)) return null;
  const document = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  return document && !document.startsWith('%PDF-')
    && document.length <= maxDocumentChars && document.split('\n').length <= 1500
    && Buffer.byteLength(document, 'utf8') <= maxAttachmentBytes ? document : null;
}

function fileMetadata(file) {
  if (typeof file?.file_name !== 'string' || !/\.txt$/i.test(file.file_name)
    || (file.mime_type !== undefined && !/^text\/plain(?:;\s*charset=utf-8)?$/i.test(file.mime_type))
    || typeof file.file_id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(file.file_id)
    || !Number.isSafeInteger(file.file_size) || file.file_size < 1 || file.file_size > maxAttachmentBytes) return null;
  return { file_id: file.file_id, file_size: file.file_size };
}

function sessionChange(command, state, text) {
  return { ...command, action: 'save', text, body: {
    operation: 'save_telegram_session', owner_chat_id: command.chat_id,
    expected_revision: command.revision, message_id: command.message_id, state,
  } };
}

function openDocument(command, document, caseId) {
  const active = {
    case_id: caseId, document, title: 'Contrato', context: {},
    jurisdiction: { region: 'Federal', entity_code: null, municipality_code: null }, turns: [],
  };
  return sessionChange(command, { active, pending: null }, [
    'Abrí el expediente ' + caseId + ' con el contrato que enviaste.',
    '¿A qué parte representas y qué quieres revisar? Por ejemplo, “Soy comprador y quiero aclarar el pago”.',
    'Pregunta lo que quieras revisar. Por ejemplo, “¿cuándo vence el pago?”. También puedes decir “audita el contrato”.',
    analysisNotice,
  ].join('\n'));
}

function auditContext(text) {
  const match = /^soy\s+(?:(?:el|la)\s+)?(comprador[ae]?|vendedor[ae]?|proveedor[ae]?|cliente|arrendador[ae]?|arrendatari[oa])(?:[ ,]+)(?:y\s+)?(?:quiero|necesito)\s+(.{1,470})$/iu.exec(text);
  if (!match) return null;
  const role = match[1].toLowerCase();
  return { our_party: 'Parte que consulta', counterparty: 'Contraparte',
    our_role: role, objectives: [match[2]], confirmed: true };
}

function auditJurisdiction(text) {
  const match = /^regi[oó]n:\s*([^\n]{1,120})(?:\nEntidad:\s*(0[1-9]|[12][0-9]|3[0-2])(?:\nMunicipio:\s*(?!000)([0-9]{3}))?)?$/iu.exec(text);
  if (!match) return null;
  const region = match[1].trim();
  if (!region || (!match[2] && !/^(federal|nacional)$/i.test(region)) || /TODO_|por confirmar|por definir/i.test(region)) return null;
  return { region, entity_code: match[2] || null, municipality_code: match[3] || null };
}

function activeDescription(active) {
  const status = {
    AWAITING_HUMAN: 'Borrador V2 guardado para revisión',
    HELD: 'Auditoría retenida',
    CONTEXT_REQUIRED: 'Pendiente de aclaraciones para la auditoría',
    NO_REWRITE_REQUIRED: 'Auditoría terminada con el texto original',
  };
  return 'Expediente activo ' + active.case_id + '\n'
    + (status[active.last_audit_status] || 'Contrato recibido y listo para consultar.');
}

export function planTelegramConversation(update, access, session, sha256) {
  if (session.last_message_id !== null && access.message_id <= session.last_message_id) return null;
  const message = update.message;
  const state = session.state || empty;
  const { active, pending } = state;
  const command = { ...access, revision: session.revision, state };
  const reply = text => ({ ...access, action: 'reply', text });
  const text = (typeof message.text === 'string' ? message.text : '').replace(/\r\n?/g, '\n').trim();
  const name = text.replace(/^\/(\w+)@ContracterExampleBot(?=\s|$)/i, '/$1');
  const idFor = kind => eventId(sha256, access.chat_id, update.update_id, kind);

  if (/^(?:\/reset|\/restablecer|(?:restablecer|reiniciar|resetea) (?:el )?(?:expediente|chat|conversaci[oó]n))[.!]?$/i.test(name)) {
    return sessionChange(command, null, 'Restablecí la conversación. Envía un nuevo contrato cuando quieras empezar. Las auditorías ya registradas se conservan.');
  }
  if (message.forward_origin || message.forward_date || message.media_group_id) {
    return reply('Envía el contrato directamente en este chat como un solo archivo.');
  }
  const download = item => ({ ...command, action: 'download', ...item });
  if (message.document !== undefined) {
    const attachment = fileMetadata(message.document);
    if (!attachment) return reply('Adjunta un .txt UTF-8 de hasta 36 000 bytes. ' + uploadHelp);
    const item = { attachment, case_id: idFor('case') };
    if (typeof message.caption === 'string' && /^contrato(?: de prueba| ficticio)?[.!]?$/i.test(message.caption.trim())) return download(item);
    return sessionChange(command, { active, pending: item },
      'Recibí el adjunto. Escribe «Confirmar» para abrir el expediente.\n\n' + analysisNotice);
  }

  const pasted = /^contrato(?: de prueba| ficticio)?\s*:\s*\n([\s\S]+)$/i.exec(text);
  if (pasted) {
    const document = plainText(pasted[1]);
    return document ? openDocument(command, document, idFor('case'))
      : reply('El texto debe ser legible y tener hasta 12 000 caracteres. También puedes enviarlo como .txt.');
  }
  if (pending && /^(?:confirmar|confirmo|(?:s[ií][, ]+)?(?:us[eé] datos inventados|es ficticio)|confirmo que es ficticio)[.!]?$/i.test(text)) return download(pending);
  if (/^(?:\/(?:help|start)|ayuda|men[uú]|(?:hola|buen[oa]s? (?:d[ií]as|tardes|noches)))[!.?]?$/i.test(name)) {
    return reply(active ? 'Hola. Seguimos con el expediente ' + active.case_id + '. Puedes hacerme una pregunta sobre el contrato.\n\n' + menu : menu);
  }
  if (/^\/(?:demo|evaluar|estado)(?:\s|$)/i.test(name)) {
    const providerNote = /\bopenai\b/i.test(name) ? 'OpenAI puede consumir créditos.\n' : '';
    return reply(providerNote + (active ? activeDescription(active) + '\n' : '') + uploadHelp + '\n\n' + analysisNotice);
  }

  const sourceCommand = /^\/fuentes(?:\s+([\s\S]+))?$/i.exec(name);
  if (sourceCommand) {
    const query = sourceCommand[1]?.trim() || '';
    if (!query) return reply([
      'Documentos oficiales',
      'Busca en el Código de Comercio con /fuentes compraventa.',
      'Código de Comercio · https://www.diputados.gob.mx/LeyesBiblio/ref/ccom.htm',
      'Código Civil Federal · https://www.diputados.gob.mx/LeyesBiblio/ref/ccf.htm',
      'Convención de Viena sobre compraventa internacional · https://uncitral.un.org/es/texts/salegoods/conventions/sale_of_goods/cisg',
    ].join('\n'));
    if (query.length < 2 || query.length > 300 || /[\x00-\x1F\x7F-\x9F]/.test(query)) {
      return reply('Escribe un tema de una sola línea, por ejemplo /fuentes entrega.');
    }
    const jurisdiction = active?.jurisdiction || { region: 'Federal', entity_code: null, municipality_code: null };
    const asOf = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Mexico_City' }).format(new Date());
    return { ...access, action: 'lookup', body: {
      operation: 'legal_documental_search', query, limit: 2,
      jurisdiction: { ...jurisdiction, country: 'MX', as_of: asOf },
    } };
  }

  const caseCommand = /^\/(expediente|revisar)(?:\s+(\S+))?$/i.exec(name);
  if (caseCommand && (!caseCommand[2] || active?.case_id === caseCommand[2].toLowerCase())) {
    if (!active) return reply('Todavía no abrimos un expediente. ' + uploadHelp);
    return reply(caseCommand[1].toLowerCase() === 'revisar'
      ? activeDescription(active) + '\nLa revisión formal requiere un expediente autorizado.'
      : activeDescription(active));
  }
  if (caseCommand) {
    if (!uuid.test(caseCommand[2])) return reply('Incluye un ID de expediente válido o usa /expediente para consultar el caso activo.');
    if (caseCommand[1].toLowerCase() === 'revisar') return reply('La revisión formal requiere un expediente autorizado. Usa /expediente para consultar el estado del caso activo.');
    return { ...access, action: 'lookup', body: { operation: 'get_case', audience: 'telegram',
      case_id: caseCommand[2].toLowerCase(), owner_chat_id: access.chat_id } };
  }

  if (!active) {
    const hint = pending ? 'Tengo un archivo esperando tu confirmación. Escribe «Confirmar» para abrirlo.' : uploadHelp;
    return reply(hint);
  }
  if (/^(?:gracias|muchas gracias|listo|ok(?:ay)?|entendido)[!. ]*$/i.test(name)) {
    return reply('Puedes seguir preguntando sobre el mismo contrato cuando quieras.');
  }
  const context = auditContext(text);
  const clarification = /^aclaraci[oó]n:\s*(.{1,500})$/iu.exec(text)?.[1];
  const jurisdiction = auditJurisdiction(text);
  if (/^regi[oó]n:/i.test(text) && !jurisdiction) {
    return reply('Puedes escribir “Región: Federal”. Para un estado, escribe su nombre después de “Región:” y agrega “Entidad:” con su clave de dos dígitos en otra línea.');
  }
  if (context || clarification || jurisdiction) {
    const changes = context ? { context } : clarification ? { clarification } : { jurisdiction };
    return sessionChange(command, { ...state, active: { ...active, ...changes } },
      'Guardé la información para este expediente. Escribe “audita el contrato” para usarla en la revisión.');
  }

  const full = /^(?:\/auditar|(?:por favor[, ]+)?audita(?:r)?(?:\s+(?:el|este)\s+contrato)?)[.!]?$/i.test(name);
  if (full && active.last_audit_status === 'AWAITING_HUMAN') return reply(activeDescription(active));
  if (full && active.context.confirmed !== true) {
    return reply('Para auditarlo, dime qué parte representas y qué quieres verificar. Por ejemplo: «Soy comprador y quiero precisar los plazos de pago».');
  }
  const explicitQuestion = /^\/(?:pregunta|consulta)(?:\s+([\s\S]+))?$/i.exec(name);
  const reportCommand = /^\/reporte(?:\s+(\S+))?$/i.exec(name);
  const reportKey = reportCommand ? (reportCommand[1] || 'ejecutivo').toLowerCase()
    : /^\/storytelling$/i.test(name) ? 'storytelling' : /^\/cl[aá]usulas$/i.test(name) ? 'abogado' : '';
  const report = reportKey && Object.hasOwn(reportRequests, reportKey) ? reportRequests[reportKey] : null;
  if (reportCommand && !report) return reply('Elige /reporte ejecutivo, /reporte experto o /reporte abogado.');
  if (name.startsWith('/') && !explicitQuestion && !full && !report) {
    return reply('Puedes escribirme tu pregunta en lenguaje natural o usar /help para ver las opciones.');
  }
  let question = report ? report.question : explicitQuestion ? explicitQuestion[1] || '' : text;
  const mentionedId = /^([a-f0-9-]{36})(?:\s+|$)/i.exec(question);
  if (explicitQuestion && mentionedId && uuid.test(mentionedId[1])) {
    if (mentionedId[1].toLowerCase() !== active.case_id) {
      return reply('Este chat está usando el expediente ' + active.case_id + '. Usa /reset para abrir otro contrato.');
    }
    question = question.slice(mentionedId[0].length).trim();
  }
  if ((!full && (!question || question.length > maxQuestionChars)) || (!text && !explicitQuestion)) {
    return reply('Escríbeme una pregunta sobre el contrato en un mensaje de hasta 600 caracteres.');
  }

  const confirmedContext = active.context.confirmed === true ? active.context : {
    our_party: 'Parte que consulta', counterparty: 'Contraparte', our_role: 'consulta neutral',
    objectives: ['Entender el texto del contrato que envió el usuario.'], confirmed: true,
  };
  return { ...command, action: 'gemini', ...(report ? { report_label: report.label } : {}), input: {
    workflow: full ? 'full' : 'qa', synthetic: true,
    run_id: idFor('run'), case_id: active.case_id, owner_chat_id: access.chat_id,
    document: active.document, title: active.title, context: confirmedContext, jurisdiction: active.jurisdiction,
    ...(active.clarification ? { clarification: active.clarification } : {}),
    ...(full ? {} : { question, conversation: active.turns }),
  } };
}

export function finishTelegramConversationDownload(command, bytes) {
  const reject = () => ({ action: 'reply', chat_id: command.chat_id,
    text: 'No pude leer el adjunto como .txt UTF-8. Verifica el archivo y envíalo de nuevo.' });
  if (!Buffer.isBuffer(bytes) || bytes.length !== command.attachment.file_size
    || bytes.length > maxAttachmentBytes) return reject();
  const raw = bytes.toString('utf8');
  if (!Buffer.from(raw, 'utf8').equals(bytes)) return reject();
  const document = plainText(raw);
  return document ? openDocument(command, document, command.case_id) : reject();
}

export function finishTelegramConversationAudit(command, result, allowedQuestions) {
  const { active } = command.state;
  const qa = command.input.workflow === 'qa';
  const answer = typeof result.answer === 'string'
    ? result.answer.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '').trim() : '';
  let state = command.state;
  let text;
  if (qa && result.status === 'QA_READY' && result.persisted === true && result.source_case_id === active.case_id && answer) {
    const turn = { question: command.input.question, answer: answer.slice(0, 1200) };
    state = { ...state, active: { ...active, turns: [...active.turns, turn].slice(-3) } };
    text = (command.report_label ? command.report_label + '\n\n' : '') + answer.slice(0, 3500) + '\n\n' + analysisNotice;
  } else if (!qa && result.status === 'AWAITING_HUMAN' && result.case_id === active.case_id && result.persisted === true) {
    text = 'Guardé el borrador V2 del expediente ' + active.case_id + '. Puedes seguir preguntando sobre el contrato o consultar /revisar.\n\n' + analysisNotice;
  } else if (result.status === 'CONTEXT_REQUIRED') {
    const questions = Array.isArray(result.questions) ? [...new Set(result.questions)]
      .filter(question => allowedQuestions.includes(question)).slice(0, 5) : [];
    text = ['Necesito aclarar algunos datos del expediente.', ...questions,
      'Escríbeme «Aclaración:» seguida de los datos y vuelve a pedirme que lo audite.'].join('\n');
  } else if (result.status === 'NO_REWRITE_REQUIRED') {
    text = 'La auditoría recomienda conservar el texto actual. Puedes seguir preguntando sobre sus cláusulas.\n\n' + analysisNotice;
  } else if (result.status === 'HELD') {
    const reason = result.reason || '';
    if (reason === 'AFTON_TEST_CANARY') {
      text = 'Afton detuvo el documento al encontrar el marcador del ejercicio de seguridad. El expediente sigue disponible para reemplazar el archivo con /reset.';
    } else if (reason === 'PROVIDER_QUOTA_EXHAUSTED' || reason === 'PROVIDER_CAPACITY_UNAVAILABLE') {
      text = 'Gemini Free está temporalmente fuera de cuota o saturado. El expediente sigue activo y puedes reintentar más tarde.';
    } else if (/LEGAL|SOURCE|GROUNDING/.test(reason)) {
      text = 'La auditoría quedó retenida porque hacen falta fuentes jurídicas revisadas para este caso. Puedes seguir consultando qué dice el contrato.';
    } else {
      text = 'La revisión quedó retenida. Código ' + (/^[A-Z0-9_]{1,90}$/.test(reason) ? reason : 'CONTROL_PENDIENTE') + '.';
    }
  } else {
    text = 'El servicio de auditoría no pudo completar la solicitud. El contrato sigue activo.';
  }
  if (!qa && ['AWAITING_HUMAN', 'HELD', 'CONTEXT_REQUIRED', 'NO_REWRITE_REQUIRED'].includes(result.status)
    && (result.status !== 'AWAITING_HUMAN' || (result.case_id === active.case_id && result.persisted === true))) {
    state = { ...state, active: { ...active, last_audit_status: result.status } };
  }
  return sessionChange(command, state, text);
}
