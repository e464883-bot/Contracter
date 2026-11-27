import { setTimeout as delay } from 'node:timers/promises';
import { createStandby, loadStandbyConfig } from './telegram-standby.mjs';

const telegramOrigin = 'https://api.telegram.org';
const telegramTrigger = 'n8n-nodes-base.telegramTrigger';
const requestTimeout = 10_000;
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;

function failure(status, code, message) {
  return Object.assign(new Error(message), { name: 'OperatorSwitchError', status, code });
}

const mismatch = () => failure(409, 'OPERATOR_CONFLICT',
  'El estado del webhook y del workflow no coincide. Revisa qué operador tiene el bot antes de cambiarlo.');
const unavailable = () => failure(503, 'OPERATOR_UNAVAILABLE',
  'No se pudo comprobar el estado del bot y del workflow. Verifica las credenciales y la conexión.');
const draftChanged = () => failure(409, 'OPERATOR_WORKFLOW_DRAFT',
  'El workflow tiene una versión distinta de la versión de retorno. Revisa el borrador antes de cambiar el operador.');

function loadConfig(env) {
  try {
    const n8n = new URL(env.CONTRACTER_OPERATOR_N8N_URL);
    const webhook = new URL(env.CONTRACTER_OPERATOR_N8N_WEBHOOK_URL);
    const workflowId = env.CONTRACTER_OPERATOR_N8N_WORKFLOW_ID || '';
    const versionId = env.CONTRACTER_OPERATOR_N8N_VERSION_ID || '';
    const apiKey = env.CONTRACTER_OPERATOR_N8N_API_KEY || '';
    if (n8n.protocol !== 'https:' || !/^[a-z0-9-]+\.app\.n8n\.cloud$/.test(n8n.hostname)
      || n8n.port || n8n.pathname !== '/' || n8n.username || n8n.password || n8n.search || n8n.hash
      || webhook.origin !== n8n.origin || !webhook.pathname.startsWith('/webhook/')
      || webhook.username || webhook.password || webhook.search || webhook.hash
      || !idPattern.test(workflowId) || (versionId && !idPattern.test(versionId))
      || !/^[\x21-\x7E]{16,4096}$/.test(apiKey) || /^(TODO|REPLACE)/i.test(apiKey)) throw new Error();
    const standby = loadStandbyConfig(env);
    return { standby, apiKey, workflowId, versionId, webhook: webhook.href,
      workflowUrl: `${n8n.origin}/api/v1/workflows/${workflowId}` };
  } catch {
    throw failure(500, 'OPERATOR_CONFIG_INVALID',
      'Revisa las variables privadas del operador de Contracter y las credenciales del modo Node.js.');
  }
}

function validateWorkflow(workflow, id, expectedVersion) {
  if (workflow?.id !== id || typeof workflow.active !== 'boolean' || !Array.isArray(workflow.nodes)
    || typeof workflow.versionId !== 'string' || !idPattern.test(workflow.versionId)) throw unavailable();
  const publishedVersion = workflow.activeVersionId || workflow.activeVersion?.versionId;
  if ((expectedVersion && workflow.versionId !== expectedVersion)
    || (workflow.active && publishedVersion && publishedVersion !== workflow.versionId)) throw draftChanged();
  const nodeSets = [workflow.nodes];
  if (workflow.activeVersion?.nodes) nodeSets.push(workflow.activeVersion.nodes);
  for (const nodes of nodeSets) {
    const inputs = Array.isArray(nodes) ? nodes.filter(node => node?.type === telegramTrigger && node.disabled !== true) : [];
    const version = inputs[0]?.typeVersion;
    if (inputs.length !== 1 || typeof version !== 'number' || version < 1 || version >= 1.3) {
      throw failure(409, 'OPERATOR_WORKFLOW_UNSAFE',
        'Se requiere un único disparador activo de Telegram en una versión anterior a 1.3 para conservar los mensajes pendientes.');
    }
  }
  return workflow.active;
}

async function beforeTimeout(promise, ms, error) {
  const timer = new AbortController();
  try {
    return await Promise.race([promise, delay(ms, undefined, { signal: timer.signal }).then(() => { throw error; })]);
  } finally {
    timer.abort();
  }
}

export function createOperatorSwitch({ env = process.env, fetchFn = fetch, standbyFactory = createStandby,
  startupTimeout = 15_000, drainTimeout = 12_000 } = {}) {
  if (env.CONTRACTER_OPERATOR_ENABLED !== 'true') return null;
  const config = loadConfig(env);
  const botUrl = `${telegramOrigin}/bot${config.standby.token}`;
  const n8nHeaders = { accept: 'application/json', 'X-N8N-API-KEY': config.apiKey };
  let knownVersion = config.versionId;
  let runner = null;
  let operation = null;
  let closing = false;

  async function request(url, options = {}, readBody = true) {
    try {
      const response = await fetchFn(url, { ...options, signal: AbortSignal.timeout(requestTimeout), redirect: 'error' });
      if (!response.ok) throw new Error();
      return readBody ? await response.json() : null;
    } catch {
      throw unavailable();
    }
  }

  async function inspect() {
    const [workflow, webhook] = await Promise.all([
      request(config.workflowUrl, { headers: n8nHeaders }),
      request(`${botUrl}/getWebhookInfo`, { method: 'POST' }),
    ]);
    const n8nActive = validateWorkflow(workflow, config.workflowId, knownVersion);
    const url = webhook?.result?.url;
    if (webhook?.ok !== true || typeof url !== 'string') throw unavailable();
    if (n8nActive && url === config.webhook && !runner) {
      knownVersion = workflow.versionId;
      return 'n8n';
    }
    if (!n8nActive && !url) {
      if (!runner) return 'none';
      if (runner.ready) return 'node';
    }
    return 'unknown';
  }

  async function setWorkflow(active) {
    const activation = { headers: { ...n8nHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: knownVersion }) };
    await request(`${config.workflowUrl}/${active ? 'activate' : 'deactivate'}`,
      { method: 'POST', ...(active ? activation : { headers: n8nHeaders }) }, false);
  }

  async function startNode() {
    const controller = new AbortController();
    const startup = Promise.withResolvers();
    const next = { controller, ready: false, processing: false, draining: false };
    runner = next;

    // A first successful poll confirms that Telegram belongs to this runner.
    // The initial poll is immediate. Later polls keep the normal standby timeout.
    const standbyFetch = async (url, options) => {
      if (url !== `${botUrl}/getUpdates`) return fetchFn(url, options);
      next.processing = false;
      if (next.draining) {
        controller.abort();
        throw controller.signal.reason;
      }
      const body = next.ready ? options.body : JSON.stringify({ ...JSON.parse(options.body), timeout: 0 });
      let response;
      try {
        response = await fetchFn(url, { ...options, body });
        if (response.status === 409) next.conflict = true;
        const reply = response.ok ? await response.clone().json() : null;
        next.ready = reply?.ok === true && Array.isArray(reply.result);
        next.processing = next.ready && reply.result.length > 0;
        if (next.ready) startup.resolve();
        return response;
      } catch (error) {
        next.ready = false;
        if (!response) throw error;
        return response;
      }
    };

    const stopped = failure(503, 'OPERATOR_NODE_STOPPED', 'Telegram no confirmó el arranque del motor Node.js.');
    next.done = (async () => {
      try {
        const standby = standbyFactory({ config: config.standby, fetchFn: standbyFetch });
        await standby.run({ signal: controller.signal });
      } catch (error) {
        // The transport may contain a URL with the Telegram credential.
        if (error?.code === 'TELEGRAM_CONFLICT' || error?.code === 'TELEGRAM_WEBHOOK_ACTIVE') next.conflict = true;
      } finally {
        startup.reject(next.conflict ? mismatch() : stopped);
        if (runner === next) runner = null;
      }
    })();
    try {
      await beforeTimeout(startup.promise, startupTimeout, stopped);
    } catch (error) {
      controller.abort();
      await next.done;
      throw error;
    }
  }

  async function stopNode({ force = false } = {}) {
    const current = runner;
    if (!current) return;
    current.draining = true;
    if (force || !current.processing) current.controller.abort();
    try {
      await beforeTimeout(current.done, drainTimeout, failure(409, 'OPERATOR_NODE_BUSY',
        'Node.js todavía está atendiendo mensajes. Espera a que termine antes de cambiar el operador.'));
    } finally {
      current.draining = false;
    }
  }

  async function switchTo(target) {
    const previous = await inspect();
    if (previous === 'unknown') throw mismatch();
    if (previous === target) return { active: target, switching: false };
    if (target === 'n8n' && !knownVersion) throw failure(409, 'OPERATOR_VERSION_REQUIRED',
      'Para volver a n8n, configura el identificador de la versión aprobada del workflow.');
    try {
      if (target === 'node') {
        if (previous === 'n8n') {
          await setWorkflow(false);
          if (await inspect() !== 'none') throw mismatch();
        }
        if (closing) throw unavailable();
        await startNode();
      } else {
        await stopNode();
        if (await inspect() !== 'none') throw mismatch();
        if (closing) throw unavailable();
        await setWorkflow(true);
      }
      if (await inspect() !== target) throw mismatch();
      return { active: target, switching: false };
    } catch (error) {
      if (target === 'node') await stopNode({ force: true }).catch(() => {});
      // Restore the prior route only when a fresh check confirms an empty slot.
      if (error.code !== 'OPERATOR_CONFLICT' && previous !== 'none' && await inspect().catch(() => 'unknown') === 'none') {
        if (previous === 'n8n') await setWorkflow(true).catch(() => {});
        else if (!closing) await startNode().catch(() => {});
      }
      throw error;
    }
  }

  return {
    async status() {
      if (operation) return { active: 'unknown', switching: true };
      const active = await inspect();
      return operation ? { active: 'unknown', switching: true } : { active, switching: false };
    },
    async select(target) {
      if (target !== 'n8n' && target !== 'node') {
        throw failure(400, 'OPERATOR_INVALID_TARGET', 'Elige n8n o el motor Node.js.');
      }
      if (closing || operation) {
        throw failure(409, 'OPERATOR_BUSY', 'Ya hay un cambio de operador en curso.');
      }
      operation = switchTo(target);
      try {
        return await operation;
      } finally {
        operation = null;
      }
    },
    async close() {
      closing = true;
      await operation?.catch(() => {});
      await stopNode({ force: true });
    },
  };
}
