import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { loadAuditConfig } from '../scripts/build_live_workflow.mjs';
import { CLARIFICATION_QUESTIONS, runLiveAudit } from './live-audit.mjs';
import { acceptStep, advanceWorkflow, GEMINI_FREE_PRICE, GEMINI_URL, geminiTestState } from './live-transport.mjs';
import {
  conversationAccess, finishTelegramConversationAudit, finishTelegramConversationDownload, planTelegramConversation,
} from './telegram-conversation.mjs';

const telegramOrigin = 'https://api.telegram.org';
const tokenPattern = /^[1-9][0-9]{4,15}:[A-Za-z0-9_-]{30,80}$/;
const idPattern = /^[1-9][0-9]{0,15}$/;
const storeUrlPattern = /^https:\/\/[a-z0-9]{20}\.supabase\.co\/functions\/v1\/contracter-store$/;
const storeTokenPattern = /^[a-f0-9]{64}$/;
const geminiKeyPattern = /^AIza[A-Za-z0-9_-]{35}$/;
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const messages = {
  TELEGRAM_AUTH: 'Telegram rechazó la credencial del bot. Verifica el token local.',
  TELEGRAM_CONFLICT: 'Otro proceso o webhook está recibiendo mensajes de este bot. Detén esa conexión antes de iniciar el respaldo.',
  TELEGRAM_REQUEST_FAILED: 'Telegram rechazó la operación del respaldo.',
  TELEGRAM_UNAVAILABLE: 'No hay respuesta válida de Telegram. Comprueba la conexión e inténtalo de nuevo.',
  TELEGRAM_WEBHOOK_ACTIVE: 'Telegram sigue enviando mensajes a un webhook. Detén el disparador anterior y comprueba su estado antes de iniciar el respaldo.',
  STOPPED: 'Respaldo detenido.',
};

function standbyError(code) {
  return Object.assign(new Error(messages[code]), { code });
}

function checked(value, pattern, name) {
  if (typeof value !== 'string' || value !== value.trim() || !pattern.test(value)) {
    throw Object.assign(new Error('Completa o corrige ' + name + ' en la configuración privada.'), { code: 'INVALID_CONFIG' });
  }
  return value;
}

export function loadStandbyConfig(env = process.env) {
  const token = checked(env.CONTRACTER_TELEGRAM_BOT_TOKEN, tokenPattern, 'CONTRACTER_TELEGRAM_BOT_TOKEN');
  const owner_chat_id = checked(env.CONTRACTER_TELEGRAM_CHAT_ID, idPattern, 'CONTRACTER_TELEGRAM_CHAT_ID');
  const owner_user_id = checked(env.CONTRACTER_TELEGRAM_OWNER_ID, idPattern, 'CONTRACTER_TELEGRAM_OWNER_ID');
  const storeUrl = checked(env.CONTRACTER_STORE_URL, storeUrlPattern, 'CONTRACTER_STORE_URL');
  const telegramStoreToken = checked(env.CONTRACTER_STORE_TELEGRAM_TOKEN, storeTokenPattern, 'CONTRACTER_STORE_TELEGRAM_TOKEN');
  const auditStoreToken = checked(env.CONTRACTER_STORE_AUDIT_TOKEN, storeTokenPattern, 'CONTRACTER_STORE_AUDIT_TOKEN');
  if (telegramStoreToken === auditStoreToken) {
    throw Object.assign(new Error('Usa dos credenciales privadas distintas de Supabase, una para el chat y otra para la auditoría.'), {
      code: 'INVALID_CONFIG',
    });
  }
  const geminiKey = checked(env.CONTRACTER_GEMINI_API_KEY, geminiKeyPattern, 'CONTRACTER_GEMINI_API_KEY');
  return Object.freeze({ token, owner_chat_id, owner_user_id, storeUrl, telegramStoreToken, auditStoreToken, geminiKey });
}

function requestSignal(signal, timeout) {
  const deadline = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function checkStopped(signal) {
  if (signal?.aborted) throw standbyError('STOPPED');
}

function telegramError(status) {
  if (status === 401 || status === 403) return standbyError('TELEGRAM_AUTH');
  if (status === 409) return standbyError('TELEGRAM_CONFLICT');
  if (status >= 400 && status < 500 && status !== 429) return standbyError('TELEGRAM_REQUEST_FAILED');
  return standbyError('TELEGRAM_UNAVAILABLE');
}

function credentialMessage(scope) {
  return 'La credencial privada de Supabase para ' + (scope === 'audit' ? 'la auditoría' : 'el chat')
    + ' venció o no tiene acceso. Pide al administrador que la actualice.';
}

function isUnauthorized(status) {
  return status === 401 || status === 403;
}

function lookupText(command, response) {
  if (isUnauthorized(response.statusCode)) return credentialMessage('telegram');
  if (command.body.operation === 'legal_documental_search') {
    const { results } = response.body ?? {};
    if (response.statusCode !== 200 || !Array.isArray(results)) {
      return 'No pude consultar las referencias documentales. Intenta de nuevo en un momento.';
    }
    if (!results.length) {
      return 'No encontré ese término en los documentos incorporados. Prueba /fuentes compraventa o /fuentes para ver el catálogo.';
    }
    return [
      'Fragmentos del documento oficial. La aplicabilidad al contrato requiere revisión jurídica.',
      ...results.slice(0, 2).map(row => [
        row.title + ' · ' + row.locator,
        '«' + row.quote + '»',
        row.review_status === 'approved' ? 'Revisión registrada en el corpus.' : 'Revisión jurídica pendiente.',
        row.url,
      ].join('\n')),
    ].join('\n\n');
  }
  const detail = response.statusCode === 200 && response.body?.case ? response.body : null;
  return detail ? ['Expediente ' + detail.case.case_id, 'Estado ' + detail.status,
    detail.case.reports?.watson?.summary || 'Consulta el expediente en el panel privado.'].join('\n')
    : 'No encontré un expediente con ese ID en este chat. Usa /expediente para ver el caso activo.';
}

export function createStandby({ config, fetchFn = fetch, now = Date.now }) {
  const settings = loadStandbyConfig({
    CONTRACTER_TELEGRAM_BOT_TOKEN: config?.token,
    CONTRACTER_TELEGRAM_CHAT_ID: config?.owner_chat_id,
    CONTRACTER_TELEGRAM_OWNER_ID: config?.owner_user_id,
    CONTRACTER_STORE_URL: config?.storeUrl,
    CONTRACTER_STORE_TELEGRAM_TOKEN: config?.telegramStoreToken,
    CONTRACTER_STORE_AUDIT_TOKEN: config?.auditStoreToken,
    CONTRACTER_GEMINI_API_KEY: config?.geminiKey,
  });
  let auditConfigPromise;

  async function post(url, body, headers, signal, timeout = 35_000) {
    checkStopped(signal);
    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: requestSignal(signal, timeout),
      });
      const result = { statusCode: response.status, body: await response.json() };
      checkStopped(signal);
      return result;
    } catch {
      checkStopped(signal);
      return { statusCode: response?.status ?? 0, body: null };
    }
  }

  async function telegram(method, body, signal, timeout) {
    const { statusCode, body: wire } = await post(
      telegramOrigin + '/bot' + settings.token + '/' + method, body, {}, signal, timeout,
    );
    if (statusCode !== 200 || wire?.ok !== true) throw telegramError(wire?.error_code ?? statusCode);
    return wire.result;
  }

  function store(body, scope, signal, timeout) {
    const token = scope === 'audit' ? settings.auditStoreToken : settings.telegramStoreToken;
    return post(settings.storeUrl, body, { authorization: 'Bearer ' + token }, signal, timeout);
  }

  async function check({ signal } = {}) {
    const info = await telegram('getWebhookInfo', {}, signal, 10_000);
    if (typeof info?.url !== 'string') throw standbyError('TELEGRAM_UNAVAILABLE');
    return { webhookActive: info.url !== '' };
  }

  async function download(command, signal) {
    const { file_id, file_size } = command.attachment;
    try {
      const file = await telegram('getFile', { file_id }, signal, 15_000);
      const path = file?.file_path;
      if (typeof path !== 'string' || path.length > 256
          || !path.split('/').every(segment => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..')
          || (file.file_size !== undefined && file.file_size !== file_size)) return undefined;
      const response = await fetchFn(telegramOrigin + '/file/bot' + settings.token + '/' + path, {
        method: 'GET', redirect: 'error', signal: requestSignal(signal, 20_000),
      });
      if (!response.ok || !response.body) return undefined;
      const declaredSize = response.headers.get('content-length');
      if (declaredSize !== null && Number(declaredSize) !== file_size) {
        await response.body.cancel();
        return undefined;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return Buffer.concat(chunks, size);
          size += value.byteLength;
          if (size > file_size) {
            await reader.cancel();
            return undefined;
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      checkStopped(signal);
      return undefined;
    }
  }

  async function audit(command, signal) {
    auditConfigPromise ??= loadAuditConfig().then(base => ({ ...base, pricing: GEMINI_FREE_PRICE }));
    const auditConfig = await auditConfigPromise;
    let packet = { state: geminiTestState(command.input, { now: new Date(now()).toISOString(), uuid: randomUUID, sha256 }) };
    for (let index = 0; index < 48; index++) {
      checkStopped(signal);
      const step = await advanceWorkflow(packet, { runLiveAudit, sha256, config: auditConfig, now: now(), provider: 'gemini' });
      if (step.next === 'done') {
        return finishTelegramConversationAudit(command, step.result, CLARIFICATION_QUESTIONS);
      }
      const { kind, body } = step.request;
      const remainder = step.state.deadline - now();
      const timeout = Math.max(1, Math.min(35_000, remainder));
      let response = { statusCode: 0, body: null };
      if (step.next === 'openai' && kind === 'model') {
        if (remainder > 0) {
          response = await post(GEMINI_URL, body, { 'x-goog-api-key': settings.geminiKey }, signal, timeout);
        }
      } else if (step.next === 'store' && ['claim', 'persist', 'legal'].includes(kind)) {
        const finalWrite = kind === 'persist';
        if (finalWrite || remainder > 0) {
          response = await store(body, 'audit', signal, finalWrite ? 10_000 : timeout);
        }
        if (isUnauthorized(response.statusCode)) {
          return { ...command, action: 'reply', text: credentialMessage('audit') };
        }
      } else {
        throw new Error('UNSUPPORTED_AUDIT_STEP');
      }
      packet = acceptStep(step, response, now(), 'gemini');
    }
    return finishTelegramConversationAudit(command, { status: 'HELD', reason: 'RUN_BUDGET_EXCEEDED' }, CLARIFICATION_QUESTIONS);
  }

  async function reply(chat, text, signal) {
    try {
      await telegram('sendMessage', { chat_id: chat, text: text.slice(0, 3900) }, signal, 15_000);
      return { status: 'replied' };
    } catch (error) {
      checkStopped(signal);
      if (error?.code === 'TELEGRAM_AUTH') throw error;
      return { status: 'failed' };
    }
  }

  async function processUpdate(update, { signal } = {}) {
    checkStopped(signal);
    const access = conversationAccess(update, settings);
    if (!access) return { status: 'ignored' };
    const respond = text => reply(access.chat_id, text, signal);
    const response = await store({ operation: 'get_telegram_session', owner_chat_id: access.chat_id }, 'telegram', signal);
    const session = response.body;
    if (isUnauthorized(response.statusCode)) return respond(credentialMessage('telegram'));
    if (response.statusCode !== 200 || !Number.isSafeInteger(session?.revision) || session.revision < 0
        || (session.last_message_id !== null && (!Number.isSafeInteger(session.last_message_id) || session.last_message_id < 1))) {
      return respond('No pude abrir la sesión del chat. Intenta de nuevo en un momento.');
    }
    try {
      let command = planTelegramConversation(update, access, session, sha256);
      if (!command) return { status: 'ignored' };
      if (command.action === 'download') {
        command = finishTelegramConversationDownload(command, await download(command, signal));
      }
      if (command.action === 'gemini') command = await audit(command, signal);
      if (command.action === 'lookup') {
        return respond(lookupText(command, await store(command.body, 'telegram', signal)));
      }
      if (command.action === 'save') {
        const saved = await store(command.body, 'telegram', signal);
        if (saved.statusCode === 409) {
          if (!command.input) {
            const notice = await respond('Otro mensaje cambió el expediente. Envía tu mensaje otra vez para aplicarlo al caso actual.');
            if (notice.status === 'failed') return notice;
          }
          return { status: 'conflict' };
        }
        if (isUnauthorized(saved.statusCode)) return respond(credentialMessage('telegram'));
        const committed = saved.statusCode === 200 && saved.body?.last_message_id === command.message_id
          && Number.isSafeInteger(saved.body.revision) && saved.body.revision > command.revision;
        if (!committed) return respond('No pude confirmar el cambio en la sesión. Intenta de nuevo en un momento.');
      }
      return respond(command.text);
    } catch {
      checkStopped(signal);
      return respond('El servicio de auditoría no pudo completar la solicitud. Intenta de nuevo en un momento.');
    }
  }

  async function run({ signal, onReady = () => {}, onPollFailure = () => {}, onReplyFailure = () => {} } = {}) {
    try {
      if ((await check({ signal })).webhookActive) throw standbyError('TELEGRAM_WEBHOOK_ACTIVE');
      checkStopped(signal);
      onReady();
      let offset;
      let failures = 0;
      while (!signal?.aborted) {
        let updates;
        try {
          updates = await telegram('getUpdates', {
            ...(offset !== undefined ? { offset } : {}), timeout: 25, limit: 20, allowed_updates: ['message'],
          }, signal, 35_000);
          if (!Array.isArray(updates)) throw standbyError('TELEGRAM_UNAVAILABLE');
          failures = 0;
        } catch (error) {
          if (error?.code !== 'TELEGRAM_UNAVAILABLE') throw error;
          if (failures === 0) onPollFailure();
          failures = Math.min(failures + 1, 6);
          await sleep(Math.min(30_000, 1000 * 2 ** (failures - 1)), undefined, { signal });
          continue;
        }
        // An empty result confirms the previous offset. Dropping it also lets
        // Telegram restart its update numbering after a long period of inactivity.
        if (!updates.length) offset = undefined;
        const ordered = updates.filter(update => Number.isSafeInteger(update?.update_id)
          && update.update_id >= 0 && update.update_id < Number.MAX_SAFE_INTEGER)
          .sort((left, right) => left.update_id - right.update_id);
        for (const update of ordered) {
          if (offset !== undefined && update.update_id < offset) continue;
          const result = await processUpdate(update, { signal });
          if (result.status === 'failed') onReplyFailure();
          offset = update.update_id + 1;
        }
      }
    } catch (error) {
      if (!signal?.aborted) throw error;
    }
  }

  return { check, processUpdate, run };
}

async function main() {
  const [mode, extra] = process.argv.slice(2);
  if (!['--check', '--run'].includes(mode) || extra !== undefined) {
    console.log('Uso: node --env-file=.env.standby backend/telegram-standby.mjs --check | --run');
    if (mode !== undefined) process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const standby = createStandby({ config: loadStandbyConfig() });
    if (mode === '--check') {
      const { webhookActive } = await standby.check({ signal: controller.signal });
      console.log(webhookActive ? 'Telegram tiene un webhook activo.' : 'Telegram está sin webhook.');
    } else {
      await standby.run({
        signal: controller.signal,
        onReady: () => console.log('Respaldo activo. Pulsa Ctrl+C para detenerlo.'),
        onPollFailure: () => console.error('Telegram no respondió. El respaldo seguirá intentando restablecer la conexión.'),
        onReplyFailure: () => console.error('Telegram no confirmó una respuesta del respaldo.'),
      });
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    const text = error?.code === 'INVALID_CONFIG' ? error.message : messages[error?.code];
    console.error(text || 'No fue posible iniciar o completar la ejecución del respaldo.');
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
