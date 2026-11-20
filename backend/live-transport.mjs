export const OPENAI_MODEL = 'gpt-6-luna';
export const OPENAI_URL = 'https://api.openai.com/v1/responses';
export const OPENAI_PRICE = Object.freeze({
  model: OPENAI_MODEL,
  input_rate_per_million: 0.10,
  output_rate_per_million: 0.50,
  cached_input_rate_per_million: 0.01,
  source: 'https://developers.openai.com/api/docs/pricing',
});
export const GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';
// Select explicitly only for a project confirmed to be on Gemini API Free Tier.
export const GEMINI_FREE_PRICE = Object.freeze({
  model: GEMINI_MODEL,
  input_rate_per_million: 0,
  output_rate_per_million: 0,
  cached_input_rate_per_million: 0,
  source: 'https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite',
});
const MAX_WORKFLOW_EFFECTS = 45;

export function modelRequest({ agent, stage, system, input, schema }) {
  if (typeof system !== 'string' || !schema || typeof schema !== 'object') {
    throw new Error('MODEL_REQUEST_INVALID');
  }
  const payload = typeof input === 'string' ? input : JSON.stringify(input);
  if (!payload || payload.length > 96000 || system.length > 16000) {
    throw new Error('MODEL_REQUEST_TOO_LARGE');
  }
  const name = [agent, stage].join('_').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return {
    model: OPENAI_MODEL,
    store: false,
    reasoning: { effort: 'low' },
    max_output_tokens: agent === 'Hamilton' ? 6500 : 2200,
    input: [
      { role: 'developer', content: system },
      { role: 'user', content: payload },
    ],
    text: { format: { type: 'json_schema', name, strict: true, schema } },
  };
}

export function providerResponse(http, latency_ms) {
  const body = http?.body;
  const usage = body?.usage;
  const measured = Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0
    && Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens >= 0;
  const result = {
    output: null,
    model: typeof body?.model === 'string' ? body.model : OPENAI_MODEL,
    usage: measured ? {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_input_tokens: usage.input_tokens_details?.cached_tokens ?? null,
    } : null,
    latency_ms,
  };
  if (http?.statusCode !== 200) {
    const code = body?.error?.code ?? body?.error?.type;
    if (['credit_balance_exhausted', 'insufficient_quota', 'billing_hard_limit_reached'].includes(code)) {
      return { ...result, error: 'credit_balance_exhausted' };
    }
    const errors = {
      400: 'invalid_request',
      401: 'invalid_api_key',
      403: 'permission_denied',
      404: 'model_not_found',
      429: 'rate_limit_exceeded',
    };
    return { ...result, error: errors[http?.statusCode] || 'provider_unavailable' };
  }
  const parts = (Array.isArray(body?.output) ? body.output : [])
    .flatMap(item => Array.isArray(item?.content) ? item.content : []);
  if (parts.some(part => part.type === 'refusal')) return { ...result, error: 'model_refusal' };
  if (body?.status !== 'completed') return { ...result, error: 'model_incomplete' };
  const texts = parts.filter(part => part.type === 'output_text');
  if (texts.length !== 1 || typeof texts[0].text !== 'string' || texts[0].text.length > 128000) {
    return { ...result, error: 'invalid_structured_output' };
  }
  try {
    const output = JSON.parse(texts[0].text);
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error();
    return { ...result, output };
  } catch {
    return { ...result, error: 'invalid_structured_output' };
  }
}

function geminiSchema(schema) {
  // The API supports string and numeric enums. Keep boolean restrictions in
  // the core validator while still sending the required boolean field.
  const compatible = { ...schema };
  if (schema.type === 'boolean') delete compatible.enum;
  if (schema.properties) {
    compatible.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, geminiSchema(value)]));
  }
  if (schema.items) compatible.items = geminiSchema(schema.items);
  if (schema.anyOf) compatible.anyOf = schema.anyOf.map(geminiSchema);
  return compatible;
}

export function geminiModelRequest({ agent, system, input, schema }) {
  if (typeof system !== 'string' || !schema || typeof schema !== 'object') throw new Error('MODEL_REQUEST_INVALID');
  const payload = typeof input === 'string' ? input : JSON.stringify(input);
  if (!payload || payload.length > 96000 || system.length > 16000) throw new Error('MODEL_REQUEST_TOO_LARGE');
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: payload }] }],
    generationConfig: {
      candidateCount: 1,
      thinkingConfig: { thinkingLevel: 'low' },
      maxOutputTokens: agent === 'Hamilton' ? 6500 : 2200,
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: geminiSchema(schema) } },
    },
  };
}

function geminiUsage(metadata) {
  const measured = value => Number.isSafeInteger(value) && value >= 0;
  const input = measured(metadata?.promptTokenCount) ? metadata.promptTokenCount : null;
  const visible = measured(metadata?.candidatesTokenCount) ? metadata.candidatesTokenCount : null;
  let thoughts = measured(metadata?.thoughtsTokenCount) ? metadata.thoughtsTokenCount : null;
  const total = measured(metadata?.totalTokenCount) ? metadata.totalTokenCount : null;
  // Gemini REST omits zero-valued counters. Infer zero thoughts only when
  // the reported total reconciles exactly, and leave missing cache telemetry null.
  if (metadata?.thoughtsTokenCount === undefined && input !== null && visible !== null && total === input + visible) thoughts = 0;
  const combined = visible !== null && thoughts !== null ? visible + thoughts : null;
  const toolTokens = metadata?.toolUsePromptTokenCount ?? 0;
  const reconciles = metadata?.totalTokenCount === undefined
    || (total !== null && (input === null || total === input + combined));
  const output = measured(combined) && reconciles && toolTokens === 0 ? combined : null;
  if (input === null && output === null) return null;
  return { input_tokens: input, output_tokens: output, cached_input_tokens: metadata?.cachedContentTokenCount ?? null };
}

export function geminiProviderResponse(http, latency_ms) {
  const body = http?.body;
  const result = {
    output: null,
    model: typeof body?.modelVersion === 'string' ? body.modelVersion : null,
    usage: geminiUsage(body?.usageMetadata),
    latency_ms,
  };
  if (http?.statusCode !== 200) {
    const error = body?.error;
    const details = Array.isArray(error?.details) ? error.details : [];
    if (http?.statusCode === 429 || error?.status === 'RESOURCE_EXHAUSTED') {
      // Stop the synthetic run on its first quota response, including rate limits.
      return { ...result, error: 'gemini_quota_exhausted' };
    }
    if (http?.statusCode === 503) return { ...result, error: 'gemini_capacity_unavailable' };
    if (details.some(detail => detail?.reason === 'API_KEY_INVALID')) return { ...result, error: 'invalid_api_key' };
    if (http?.statusCode === 400 && /schema|responseFormat/i.test(error?.message ?? '')) {
      return { ...result, error: 'unsupported_schema' };
    }
    const errors = { 400: 'invalid_request', 401: 'invalid_api_key', 403: 'permission_denied', 404: 'model_not_found' };
    return { ...result, error: errors[http?.statusCode] || 'provider_unavailable' };
  }
  if (body?.promptFeedback?.blockReason && body.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
    return { ...result, error: 'model_refusal' };
  }
  const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
  if (candidates.length !== 1) return { ...result, error: 'invalid_structured_output' };
  const candidate = candidates[0];
  if (['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION', 'IMAGE_SAFETY'].includes(candidate?.finishReason)) {
    return { ...result, error: 'model_refusal' };
  }
  if (candidate?.finishReason !== 'STOP') return { ...result, error: 'model_incomplete' };
  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts.filter(part => part?.thought !== true) : [];
  if (!parts.length || parts.some(part => typeof part?.text !== 'string' || part.functionCall || part.executableCode)) {
    return { ...result, error: 'invalid_structured_output' };
  }
  const text = parts.map(part => part.text).join('');
  try {
    if (text.length > 128000) throw new Error();
    const output = JSON.parse(text);
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error();
    return { ...result, output };
  } catch {
    return { ...result, error: 'invalid_structured_output' };
  }
}

export function legalRequest({ query, jurisdiction }) {
  return {
    operation: 'legal_search',
    p_query: query,
    p_country_code: 'MX',
    p_entity_code: jurisdiction.entity_code || null,
    p_municipality_code: jurisdiction.municipality_code || null,
    p_as_of: jurisdiction.as_of,
    p_limit: 8,
    p_include_unreviewed: false,
  };
}

const isUuid = value => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

export function workflowState(raw, { synthetic = false, now, uuid }) {
  const workflow = raw.workflow === 'qa' ? 'qa' : 'full';
  const document = typeof raw.document === 'string' ? raw.document.trim() : '';
  if (!document || document.length > 12000 || (workflow === 'qa' && typeof raw.question !== 'string')) {
    throw new Error('INPUT_LIMIT: texto contractual requerido (máximo 12000 caracteres).');
  }
  const identity = typeof raw.owner_chat_id === 'string' && /^[0-9]{1,18}$/.test(raw.owner_chat_id)
    ? raw.owner_chat_id : null;
  const date = new Date(now);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Mexico_City' }).format(date);
  const run_id = isUuid(raw.run_id) ? raw.run_id : uuid();
  return {
    run_id,
    synthetic: synthetic || raw.synthetic === true,
    owner_chat_id: identity,
    deadline: date.getTime() + 225000,
    claims_ok: false,
    effects: {},
    input: {
      run_id,
      case_id: isUuid(raw.case_id) ? raw.case_id : uuid(),
      title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : 'Expediente Contracter',
      document,
      workflow,
      question: workflow === 'qa' ? raw.question.slice(0, 600) : undefined,
      ...(raw.conversation !== undefined ? { conversation: raw.conversation } : {}),
      clarification: raw.clarification,
      created_at: now,
      context: raw.context,
      jurisdiction: { ...raw.jurisdiction, country: 'MX', as_of: raw.jurisdiction?.as_of || today },
    },
  };
}

const GEMINI_SAMPLE_QUESTION = '¿Qué riesgo operativo crean las cláusulas de entrega y pago y qué debería aclarar la compradora?';

export function geminiDemoState(raw, { now, uuid, sha256, fixture, demoCaseId, demoQuestion }) {
  const hasDemo = Object.hasOwn(raw, 'demo_case_id') || Object.hasOwn(raw, 'demo_topic');
  let demo;
  let question = GEMINI_SAMPLE_QUESTION;
  if (hasDemo) {
    const requestedCaseId = raw.demo_case_id;
    const topic = raw.demo_topic;
    question = typeof topic === 'string' ? demoQuestion(topic) : null;
    if (raw.workflow !== 'qa' || raw.synthetic !== true || !isUuid(raw.run_id) || !isUuid(requestedCaseId)
        || (raw.case_id !== undefined && raw.case_id !== requestedCaseId)
        || !question || typeof raw.owner_chat_id !== 'string'
        || requestedCaseId !== demoCaseId(raw.owner_chat_id, sha256)) {
      throw new Error('GEMINI_DEMO_INVALID');
    }
    demo = { demo_case_id: requestedCaseId, demo_topic: topic };
  }
  // Fixture is shipped in the workflow, separate from the incoming Telegram
  // payload. Copy only routing IDs from that payload.
  const state = workflowState({
    ...fixture,
    workflow: raw.workflow === 'full' ? 'full' : 'qa',
    question,
    run_id: raw.run_id,
    case_id: demo?.demo_case_id ?? raw.case_id,
    owner_chat_id: raw.owner_chat_id,
  }, { synthetic: true, now, uuid });
  return { ...state, gemini_fixture: true, ...(demo ? { demo } : {}) };
}

export function geminiTestState(raw, { now, uuid, sha256 }) {
  const boundedText = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
  const conversation = raw?.conversation ?? [];
  if (raw?.synthetic !== true || !['full', 'qa'].includes(raw.workflow)
      || !isUuid(raw.case_id) || !isUuid(raw.run_id)
      || typeof raw.owner_chat_id !== 'string' || !/^[1-9][0-9]{0,17}$/.test(raw.owner_chat_id)
      || !boundedText(raw.document, 12000) || raw.document.split(/\r\n?|\n/).length > 1500
      || (raw.title !== undefined && !boundedText(raw.title, 200))
      || (raw.workflow === 'qa' && !boundedText(raw.question, 600))
      || (raw.source_case_id !== undefined && raw.source_case_id !== raw.case_id)
      || !Array.isArray(conversation) || conversation.length > 3
      || (raw.workflow !== 'qa' && conversation.length > 0)
      || conversation.some(turn => !turn || typeof turn !== 'object' || Array.isArray(turn)
        || Object.keys(turn).some(key => !['question', 'answer'].includes(key))
        || !boundedText(turn.question, 600) || !boundedText(turn.answer, 1200))) {
    throw new Error('GEMINI_TEST_INPUT_INVALID');
  }
  const state = workflowState({ ...raw, conversation: raw.workflow === 'qa' ? conversation : undefined },
    { synthetic: true, now, uuid });
  if (conversation.length) state.input.conversation = conversation.map(({ question, answer }) => ({ question, answer }));
  return {
    ...state,
    gemini_test: true,
    case_reference: { source_case_id: state.input.case_id, source_document_sha256: sha256(state.input.document) },
  };
}

export function requestStep(state, kind, body, key = null, fingerprint = null) {
  return {
    state,
    next: kind === 'model' || kind === 'research' ? 'openai' : 'store',
    request: { kind, body, key, fingerprint, started: Date.now() },
  };
}

export function acceptStep(step, http, now = Date.now(), provider = 'openai') {
  if (!['openai', 'gemini'].includes(provider)) throw new Error('UNKNOWN_MODEL_PROVIDER');
  const { state, request } = step;
  const { kind, key, fingerprint, started } = request;
  const body = http?.body;
  const ok = Number.isInteger(http?.statusCode) && http.statusCode >= 200 && http.statusCode < 300;
  if (kind === 'claim') {
    if (ok && body?.accepted === true) {
      state.claims_ok = true;
      return { state };
    }
    return { next: 'done', result: {
      status: ok && body?.accepted === false ? 'DUPLICATE' : 'STORE_UNAVAILABLE',
      run_id: state.run_id, persisted: false,
    } };
  }
  if (kind === 'persist') {
    const expectedStatus = ['QA_READY', 'NO_REWRITE_REQUIRED'].includes(state.summary.status) ? 'QA' : state.summary.status;
    const result = {
      ...state.summary,
      persisted: ok && body?.run_id === state.run_id && body.status === expectedStatus
        && body.case_id === state.summary.case_id,
      synthetic: state.synthetic,
    };
    if (!result.persisted) {
      result.status = 'STORE_UNAVAILABLE';
      delete result.answer;
    }
    return { next: 'done', result };
  }
  if (typeof key !== 'string' || Object.hasOwn(state.effects, key)) throw new Error('EFFECT_REPLAY_INVALID');
  let value;
  if (kind === 'model') {
    const normalize = provider === 'gemini' ? geminiProviderResponse : providerResponse;
    value = normalize(http, Math.max(0, Math.round(now - started)));
    if (value.error === 'gemini_capacity_unavailable' && !body?.usageMetadata && now < state.deadline) {
      const retries = state.capacity_retries ??= { total: 0, by_effect: {} };
      const attempts = retries.by_effect[key] ?? 0;
      if (attempts < 2 && retries.total < 10 && Object.keys(state.effects).length + retries.total + 1 < MAX_WORKFLOW_EFFECTS) {
        retries.by_effect[key] = attempts + 1;
        retries.total++;
        return { state };
      }
    }
  }
  else if (kind === 'legal') value = ok && Array.isArray(body?.results)
    ? { results: body.results, as_of: body.as_of, retrieved_at: new Date(now).toISOString() }
    : null;
  else throw new Error('EFFECT_KIND_INVALID');
  state.effects[key] = { fingerprint, value };
  return { state };
}

export function persistStep(state, report) {
  const { status, reason, questions, qa, costs } = report;
  state.summary = {
    status,
    case_id: report.case?.case_id || null,
    ...state.demo,
    ...state.case_reference,
    run_id: state.run_id,
    reason,
    questions,
    answer: qa?.answer ?? report.reports?.watson?.summary,
    total_usd: costs?.total_usd ?? null,
  };
  const body = {
    operation: 'persist',
    run_id: state.run_id,
    case: report.case || null,
    status: ['QA_READY', 'NO_REWRITE_REQUIRED'].includes(status) ? 'QA' : status,
    owner_chat_id: state.owner_chat_id,
    synthetic: state.synthetic,
    reason,
    agent_logs: report.events.map(event => ({
      ...state.demo,
      ...state.case_reference,
      event_id: event.event_id, agent: event.agent, stage: event.stage, round: event.round,
      status: event.status || event.state, output: event.output || {}, quarantined: event.quarantined === true,
    })),
    usage_events: costs?.events || [],
  };
  // Once a run is terminal, the write needs the report and identity, not the request history.
  delete state.effects;
  delete state.capacity_retries;
  delete state.input;
  return requestStep(state, 'persist', body);
}

export async function advanceWorkflow(packet, { runLiveAudit, sha256, config, now = Date.now(), provider = 'openai' }) {
  if (packet.next === 'done') return packet;
  const { state } = packet;
  if (!['openai', 'gemini'].includes(provider)) throw new Error('UNKNOWN_MODEL_PROVIDER');
  if (provider === 'gemini' && (state.synthetic !== true || (state.gemini_fixture !== true && state.gemini_test !== true))) {
    return { next: 'done', result: { status: 'HELD', reason: 'GEMINI_SYNTHETIC_ONLY', run_id: state.run_id, persisted: false } };
  }
  if (!state.claims_ok) {
    return requestStep(state, 'claim', {
      operation: 'claim_run', run_id: state.run_id,
      synthetic: state.synthetic, owner_chat_id: state.owner_chat_id,
    });
  }

  // Replay prior adapter results. One unresolved request leaves the Code node
  // and goes to a native HTTP node, which holds the corresponding credential.
  const interrupted = new Error('PENDING_EFFECT');
  let waiting;
  function effect(kind, request, body) {
    const key = kind + ':' + request.request_id;
    const fingerprint = sha256(JSON.stringify(body));
    const previous = state.effects[key];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('EFFECT_CHANGED_DURING_REPLAY');
      return previous.value;
    }
    if (now > state.deadline || Object.keys(state.effects).length + (state.capacity_retries?.total ?? 0) >= MAX_WORKFLOW_EFFECTS) {
      return kind === 'legal' ? null : { output: null, usage: null, error: 'run_budget_exceeded' };
    }
    waiting = requestStep(state, kind, body, key, fingerprint);
    throw interrupted;
  }
  try {
    const report = await runLiveAudit(state.input, {
      sha256,
      invokeModel: request => {
        let body;
        try {
          body = provider === 'gemini' ? geminiModelRequest(request) : modelRequest(request);
        } catch {
          return { output: null, usage: null, error: 'invalid_request' };
        }
        return effect('model', request, body);
      },
      searchLegal: request => effect('legal', request, legalRequest(request)),
    }, { ...config, syntheticRun: state.synthetic === true });
    return persistStep(state, report);
  } catch (error) {
    if (error === interrupted) return waiting;
    if (error?.name !== 'LiveAuditInputError') throw error;
    return persistStep(state, {
      status: 'HELD',
      case_id: state.input.case_id,
      reason: error.code || 'INVALID_INPUT',
      events: [],
      costs: { currency: 'USD', pricing_status: 'unverified', total_usd: null, events: [] },
    });
  }
}
