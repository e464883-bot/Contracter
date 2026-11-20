type Obj = Record<string, unknown>;
type Rpc = (name: string, args: Obj) => Promise<unknown>;
type Scope = 'audit' | 'approval' | 'telegram' | 'dashboard';

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const chatPattern = /^-?[1-9][0-9]{0,15}$/;
const actorPattern = /^[1-9][0-9]{0,15}$/;
const callbackPattern = /^[0-9A-Za-z_-]{1,128}$/;
const encoder = new TextEncoder();
const MAX_BODY_BYTES = 4_000_000;
const documentarySources: Record<string, string> = {
  mx_diputados_ccom_pilot: 'https://www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf',
};

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function requireValue(condition: unknown, code = 'INVALID_REQUEST', status = 400): asserts condition {
  if (!condition) throw new ApiError(status, code);
}

function obj(value: unknown): Obj {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Obj;
}

function string(value: unknown, pattern: RegExp): string {
  requireValue(typeof value === 'string' && value === value.trim() && pattern.test(value));
  return value;
}

function telegramId(value: unknown, actor = false): string {
  const normalized = Number.isSafeInteger(value) ? String(value) : value;
  return string(normalized, actor ? actorPattern : chatPattern);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function signApproval(key: string, fields: {
  approved_at: string; approved_sha256: string; approver: string; case_id: string; evidence_reference: string;
}): Promise<string> {
  requireValue(key.length >= 32 && !key.includes('TODO_'), 'APPROVAL_SIGNER_DISABLED', 503);
  // Exact key order and UTF-8 match Python validate_case_json.attestation_message.
  const { approved_at, approved_sha256, approver, case_id, evidence_reference } = fields;
  const message = JSON.stringify({ approved_at, approved_sha256, approver, case_id, evidence_reference });
  const hmacKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(message)));
}

async function readBody(request: Request): Promise<Obj> {
  requireValue(request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json',
    'JSON_REQUIRED', 415);
  requireValue(!(Number(request.headers.get('content-length')) > MAX_BODY_BYTES), 'PAYLOAD_TOO_LARGE', 413);
  const reader = request.body?.getReader();
  requireValue(reader);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel();
        throw new ApiError(413, 'PAYLOAD_TOO_LARGE');
      }
      text += decoder.decode(value, { stream: true });
    }
    return obj(JSON.parse(text + decoder.decode()));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_JSON');
  } finally {
    reader.releaseLock();
  }
}

function response(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

function scopeFor(body: Obj): Scope {
  switch (body.operation) {
    case 'claim_run': case 'persist': case 'legal_search': return 'audit';
    case 'issue_approval': case 'redeem_approval': return 'approval';
    case 'get_telegram_session': case 'save_telegram_session': case 'legal_documental_search': return 'telegram';
    case 'get_case':
      requireValue(body.audience === 'dashboard' || body.audience === 'telegram');
      return body.audience;
    default: throw new ApiError(400, 'UNKNOWN_OPERATION');
  }
}

function sessionKeys(value: unknown, allowed: string[], required = allowed): Obj {
  const record = obj(value);
  requireValue(Object.keys(record).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(record, key)), 'INVALID_SESSION');
  return record;
}

function sessionText(value: unknown, maximum: number): asserts value is string {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'INVALID_SESSION');
}

function sessionState(value: unknown): unknown {
  if (value === null) return null;
  const state = sessionKeys(value, ['active', 'pending']);
  requireValue(encoder.encode(JSON.stringify(state)).byteLength <= 65_536, 'INVALID_SESSION');
  if (state.active !== null) {
    const active = sessionKeys(state.active,
      ['case_id', 'document', 'title', 'context', 'jurisdiction', 'turns', 'provider', 'clarification', 'last_audit_status'],
      ['case_id', 'document', 'title', 'context', 'jurisdiction', 'turns']);
    string(active.case_id, uuidPattern);
    sessionText(active.document, 12_000);
    requireValue(encoder.encode(active.document).byteLength <= 36_000
      && active.document.split('\n').length <= 1500, 'INVALID_SESSION');
    sessionText(active.title, 200);
    if (active.provider !== undefined) requireValue(typeof active.provider === 'string'
      && ['gemini', 'openai'].includes(active.provider), 'INVALID_SESSION');
    if (active.clarification !== undefined) sessionText(active.clarification, 500);
    if (active.last_audit_status !== undefined) requireValue(
      typeof active.last_audit_status === 'string'
      && ['AWAITING_HUMAN', 'HELD', 'CONTEXT_REQUIRED', 'NO_REWRITE_REQUIRED'].includes(active.last_audit_status),
      'INVALID_SESSION');
    const context = sessionKeys(active.context,
      ['our_party', 'counterparty', 'our_role', 'objectives', 'confirmed'], []);
    for (const field of ['our_party', 'counterparty', 'our_role']) {
      if (context[field] !== undefined) sessionText(context[field], 200);
    }
    if (context.objectives !== undefined) {
      requireValue(Array.isArray(context.objectives) && context.objectives.length <= 10, 'INVALID_SESSION');
      for (const objective of context.objectives) sessionText(objective, 500);
    }
    if (context.confirmed !== undefined) requireValue(typeof context.confirmed === 'boolean', 'INVALID_SESSION');
    const jurisdiction = sessionKeys(active.jurisdiction,
      ['region', 'entity_code', 'municipality_code', 'country', 'as_of'],
      ['region', 'entity_code', 'municipality_code']);
    sessionText(jurisdiction.region, 120);
    if (jurisdiction.entity_code !== null) string(jurisdiction.entity_code, /^(0[1-9]|[12][0-9]|3[0-2])$/);
    if (jurisdiction.municipality_code !== null) {
      requireValue(jurisdiction.entity_code !== null, 'INVALID_SESSION');
      string(jurisdiction.municipality_code, /^(?!000)[0-9]{3}$/);
    }
    if (jurisdiction.country !== undefined) string(jurisdiction.country, /^(MX|México|Mexico)$/);
    if (jurisdiction.as_of !== undefined) {
      const date = string(jurisdiction.as_of, /^\d{4}-\d{2}-\d{2}$/);
      const timestamp = new Date(date);
      requireValue(Number.isFinite(timestamp.valueOf()) && timestamp.toISOString().slice(0, 10) === date, 'INVALID_SESSION');
    }
    requireValue(Array.isArray(active.turns) && active.turns.length <= 3, 'INVALID_SESSION');
    for (const turn of active.turns) {
      const pair = sessionKeys(turn, ['question', 'answer']);
      sessionText(pair.question, 600);
      sessionText(pair.answer, 1200);
    }
  }
  if (state.pending !== null) {
    const pending = sessionKeys(state.pending, ['case_id', 'attachment']);
    string(pending.case_id, uuidPattern);
    const attachment = sessionKeys(pending.attachment, ['file_id', 'file_size']);
    string(attachment.file_id, /^[0-9A-Za-z_-]{1,512}$/);
    requireValue(Number.isInteger(attachment.file_size) && Number(attachment.file_size) >= 1
      && Number(attachment.file_size) <= 36_000, 'INVALID_SESSION');
  }
  return state;
}

function claimArgs(body: Obj): Obj {
  requireValue(typeof body.synthetic === 'boolean');
  return { p_run_id: string(body.run_id, uuidPattern), p_synthetic: body.synthetic,
    p_owner_chat_id: body.owner_chat_id == null ? null : telegramId(body.owner_chat_id) };
}

function legalArgs(body: Obj): Obj {
  requireValue(typeof body.p_query === 'string' && body.p_query.trim().length >= 2 && body.p_query.length <= 1000);
  requireValue(body.p_country_code === 'MX' && Number.isInteger(body.p_limit)
    && Number(body.p_limit) >= 1 && Number(body.p_limit) <= 25);
  const date = string(body.p_as_of, /^\d{4}-\d{2}-\d{2}$/);
  const timestamp = new Date(date);
  requireValue(Number.isFinite(timestamp.valueOf()) && timestamp.toISOString().slice(0, 10) === date);
  const entity = body.p_entity_code == null ? null : string(body.p_entity_code, /^(0[1-9]|[12][0-9]|3[0-2])$/);
  const municipality = body.p_municipality_code == null ? null : string(body.p_municipality_code, /^(?!000)[0-9]{3}$/);
  requireValue(municipality === null || entity !== null);
  return { p_query: body.p_query.trim(), p_country_code: 'MX', p_entity_code: entity,
    p_municipality_code: municipality, p_as_of: date, p_limit: body.p_limit, p_include_unreviewed: false };
}

function documentaryArgs(body: Obj): Obj {
  requireValue(Object.keys(body).every(key => ['operation', 'query', 'jurisdiction', 'limit'].includes(key)));
  const jurisdiction = obj(body.jurisdiction);
  const fields = ['country', 'region', 'entity_code', 'municipality_code', 'as_of'];
  requireValue(Object.keys(jurisdiction).every(key => fields.includes(key))
    && fields.every(key => Object.hasOwn(jurisdiction, key)));
  requireValue(typeof jurisdiction.region === 'string' && jurisdiction.region.trim().length > 0
    && jurisdiction.region.length <= 120);
  requireValue(jurisdiction.entity_code !== null || /^(federal|nacional)$/i.test(jurisdiction.region.trim()));
  const limit = body.limit === undefined ? 2 : body.limit;
  requireValue(Number.isInteger(limit) && Number(limit) >= 1 && Number(limit) <= 3);
  return { ...legalArgs({
    p_query: body.query, p_country_code: jurisdiction.country, p_entity_code: jurisdiction.entity_code,
    p_municipality_code: jurisdiction.municipality_code, p_as_of: jurisdiction.as_of, p_limit: limit,
  }), p_include_unreviewed: true };
}

function documentaryResults(value: unknown, limit: number): Obj[] {
  requireValue(Array.isArray(value) && value.length <= limit, 'LEGAL_DOCUMENTAL_RESPONSE', 502);
  const results: Obj[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.source_id !== 'string' || !Object.hasOwn(documentarySources, row.source_id)
      || row.source_url !== documentarySources[row.source_id]
      || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 600
      || typeof row.locator !== 'string' || !row.locator.trim() || row.locator.length > 600
      || typeof row.excerpt !== 'string' || !row.excerpt.trim() || row.excerpt.length > 3000
      || !['pending', 'approved'].includes(row.review_status)
      || !['unknown', 'in_force', 'future', 'superseded', 'repealed'].includes(row.effectivity_status)) continue;
    const result = {
      title: row.title.slice(0, 200), locator: row.locator.slice(0, 160), url: row.source_url,
      quote: row.excerpt.slice(0, 450), review_status: row.review_status, effectivity_status: row.effectivity_status,
    };
    const key = JSON.stringify(result);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(result);
    if (results.length === 2) break;
  }
  return results;
}

async function redeem(body: Obj, rpc: Rpc, approvalKey: string, now: () => Date): Promise<unknown> {
  // Only the approval ingress can forward this object. That workflow must take
  // it directly from the authenticated Telegram Trigger, never a generic hook.
  const callback = obj(body.callback_query);
  const data = string(callback.data, /^ca:[ar]:[0-9a-f]{32}$/);
  const match = /^ca:([ar]):([0-9a-f]{32})$/.exec(data);
  requireValue(match);
  const decision = match[1] === 'a' ? 'APPROVED' : 'REJECTED';
  const chat = telegramId(obj(obj(callback.message).chat).id);
  const actor = telegramId(obj(callback.from).id, true);
  const callbackId = string(callback.id, callbackPattern);
  const args = { p_nonce_sha256: await sha256(match[2]), p_chat_id: chat, p_actor_id: actor,
    p_callback_id: callbackId, p_decision: decision };
  const found = obj(await rpc('contracter_lookup_approval', args));
  if (found.replayed === true) return found;
  requireValue(found.status === 'PENDING', 'INVALID_APPROVAL_STATE', 502);
  const approvedAt = now().toISOString();
  const signature = decision === 'APPROVED' ? await signApproval(approvalKey, {
    approved_at: approvedAt, approved_sha256: string(found.v2_sha256, shaPattern),
    approver: `telegram:${actor}`, case_id: string(found.case_id, uuidPattern),
    evidence_reference: `telegram-callback:${callbackId}`,
  }) : null;
  return rpc('contracter_redeem_approval', { ...args, p_signed_at: approvedAt, p_signature: signature });
}

export function createHandler(rpc: Rpc, approvalKey = '', now = () => new Date()) {
  return async (request: Request): Promise<Response> => {
    try {
      requireValue(request.method === 'POST', 'METHOD_NOT_ALLOWED', 405);
      const match = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '');
      requireValue(match, 'UNAUTHORIZED', 401);
      const body = await readBody(request);
      const scope = scopeFor(body);
      const authorized = await rpc('contracter_runtime_authorize', { p_scope: scope, p_token_sha256: await sha256(match[1]) });
      requireValue(authorized === true, 'UNAUTHORIZED', 401);
      switch (body.operation) {
        case 'claim_run': return response(await rpc('contracter_claim_run', claimArgs(body)));
        case 'persist': {
          const args = claimArgs(body);
          requireValue(typeof body.status === 'string' && ['AWAITING_HUMAN','HELD','QA','CONTEXT_REQUIRED'].includes(body.status));
          requireValue(Array.isArray(body.agent_logs) && Array.isArray(body.usage_events));
          const candidate = body.status === 'AWAITING_HUMAN';
          const pendingCase = candidate ? obj(body.case) : null;
          requireValue(candidate || body.case == null);
          const reason = body.reason == null ? null : string(body.reason, /^[A-Z0-9_]{1,120}$/);
          return response(await rpc('contracter_persist_run', { p_request: {
            run_id: args.p_run_id, status: body.status, synthetic: args.p_synthetic,
            owner_chat_id: args.p_owner_chat_id, case: pendingCase, reason,
            agent_logs: body.agent_logs, usage_events: body.usage_events,
          } }));
        }
        case 'legal_search': {
          const args = legalArgs(body);
          return response({ results: await rpc('legal_search_fts', args), as_of: args.p_as_of });
        }
        case 'legal_documental_search': {
          const args = documentaryArgs(body);
          const rows = await rpc('legal_search_fts', args);
          return response({ results: documentaryResults(rows, Number(args.p_limit)) });
        }
        case 'get_case': {
          const owner = scope === 'telegram' ? telegramId(body.owner_chat_id) : null;
          return response(await rpc('contracter_get_case', { p_case_id: string(body.case_id, uuidPattern), p_owner_chat_id: owner }));
        }
        case 'get_telegram_session':
          sessionKeys(body, ['operation', 'owner_chat_id']);
          return response(await rpc('contracter_get_telegram_session', {
            p_owner_chat_id: telegramId(body.owner_chat_id, true),
          }));
        case 'save_telegram_session': {
          sessionKeys(body, ['operation', 'owner_chat_id', 'expected_revision', 'message_id', 'state']);
          requireValue(Number.isInteger(body.expected_revision) && Number(body.expected_revision) >= 0
            && Number(body.expected_revision) <= 2_147_483_646
            && Number.isInteger(body.message_id) && Number(body.message_id) >= 1
            && Number(body.message_id) <= 2_147_483_647, 'INVALID_SESSION');
          return response(await rpc('contracter_save_telegram_session', {
            p_owner_chat_id: telegramId(body.owner_chat_id, true),
            p_expected_revision: body.expected_revision, p_message_id: body.message_id,
            p_state: sessionState(body.state),
          }));
        }
        case 'issue_approval': {
          requireValue(approvalKey.length >= 32 && !approvalKey.includes('TODO_'), 'APPROVAL_SIGNER_DISABLED', 503);
          return response(await rpc('contracter_issue_approval', { p_case_id: string(body.case_id, uuidPattern),
            p_chat_id: telegramId(body.chat_id), p_actor_id: telegramId(body.approver_id, true) }));
        }
        case 'redeem_approval': return response(await redeem(body, rpc, approvalKey, now));
        default: throw new ApiError(400, 'UNKNOWN_OPERATION');
      }
    } catch (error) {
      const normalized = error instanceof ApiError ? error : new ApiError(502, 'RUNTIME_UNAVAILABLE');
      return response({ error: normalized.code, retryable: normalized.status >= 500 || normalized.code === 'RUN_BUSY' }, normalized.status);
    }
  };
}

export function createRestRpc(url: string, key: string, fetcher = fetch): Rpc {
  return async (name, args) => {
    requireValue(url && key, 'RUNTIME_DISABLED', 503);
    const headers: Record<string, string> = { apikey: key, 'content-type': 'application/json' };
    if (!key.startsWith('sb_secret_')) headers.authorization = `Bearer ${key}`;
    const result = await fetcher(new URL(`/rest/v1/rpc/${name}`, url), {
      method: 'POST', headers, body: JSON.stringify(args), signal: AbortSignal.timeout(10_000),
    });
    const data = await result.json();
    if (result.ok) return data;
    if (typeof data?.code === 'string' && /^PT(?:400|403|404|409|410)$/.test(data.code)
      && typeof data.message === 'string' && /^[A-Z0-9_]{1,64}$/.test(data.message)) {
      throw new ApiError(Number(data.code.slice(2)), data.message);
    }
    if (typeof data?.code === 'string' && /^(?:22\d{3}|23514)$/.test(data.code)) {
      throw new ApiError(400, 'INVALID_DATA');
    }
    // Never reflect PostgreSQL details, submitted contracts or credentials.
    throw new ApiError(502, 'RUNTIME_UNAVAILABLE');
  };
}

if (typeof Deno !== 'undefined') {
  const modernKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
  const key = (modernKeys ? JSON.parse(modernKeys).default : '') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  Deno.serve(createHandler(createRestRpc(Deno.env.get('SUPABASE_URL') ?? '', key),
    Deno.env.get('CONTRACTER_APPROVAL_HMAC_KEY') ?? ''));
}
