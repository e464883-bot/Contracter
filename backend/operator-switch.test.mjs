import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorSwitch } from './operator-switch.mjs';

const origin = 'https://fixture.app.n8n.cloud';
const workflowId = 'TestWorkflow01';
const versionId = 'approved-version';
const webhook = `${origin}/webhook/fixture/webhook`;
const token = '12345:' + 'T'.repeat(32);
const key = 'test-n8n-fixture-api-key';
const env = {
  CONTRACTER_OPERATOR_ENABLED: 'true',
  CONTRACTER_OPERATOR_N8N_URL: origin,
  CONTRACTER_OPERATOR_N8N_API_KEY: key,
  CONTRACTER_OPERATOR_N8N_WORKFLOW_ID: workflowId,
  CONTRACTER_OPERATOR_N8N_WEBHOOK_URL: webhook,
  CONTRACTER_TELEGRAM_BOT_TOKEN: token,
  CONTRACTER_TELEGRAM_CHAT_ID: '101',
  CONTRACTER_TELEGRAM_OWNER_ID: '101',
  CONTRACTER_STORE_URL: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/contracter-store',
  CONTRACTER_STORE_TELEGRAM_TOKEN: '1'.repeat(64),
  CONTRACTER_STORE_AUDIT_TOKEN: '2'.repeat(64),
  CONTRACTER_GEMINI_API_KEY: 'AIza' + 'G'.repeat(35),
};

function services(options = {}) {
  const state = { active: true, webhook, activeVersion: versionId, version: versionId, triggerVersion: 1.2, ...options };
  const events = [];
  let polling = false;
  async function fetchFn(input, settings) {
    const url = new URL(input);
    assert.equal(settings.redirect, 'error');
    if (url.origin === origin) {
      assert.equal(settings.headers['X-N8N-API-KEY'], key);
      assert.equal(url.pathname.split('/')[4], workflowId);
      const action = url.pathname.split('/')[5];
      if (action === 'deactivate') {
        events.push(action);
        assert.equal(settings.method, 'POST');
        assert.equal(state.webhook, webhook);
        assert(!polling);
        await state.beforeDeactivate?.();
        state.active = false;
        state.webhook = '';
        return Response.json({ id: workflowId });
      }
      if (action === 'activate') {
        events.push(action);
        assert.equal(settings.method, 'POST');
        assert.deepEqual(JSON.parse(settings.body), { versionId });
        assert(!polling);
        assert.equal(state.webhook, '');
        if (state.activateFails) return Response.json({}, { status: 503 });
        state.active = true;
        state.webhook = webhook;
        return Response.json({ id: workflowId });
      }
      return Response.json({ id: workflowId, active: state.active,
        activeVersionId: state.active ? state.activeVersion : null, versionId: state.version,
        nodes: [{ type: 'n8n-nodes-base.telegramTrigger', typeVersion: state.triggerVersion }],
      });
    }
    assert.equal(url.origin, 'https://api.telegram.org');
    assert(settings.headers?.['X-N8N-API-KEY'] === undefined);
    const [bot, action] = url.pathname.slice(1).split('/');
    assert.equal(bot, `bot${token}`);
    if (action === 'getWebhookInfo') {
      return Response.json({ ok: true, result: { url: state.webhook } });
    }
    assert.equal(action, 'getUpdates');
    assert.equal(state.active, false);
    assert.equal(state.webhook, '');
    const body = JSON.parse(settings.body);
    if (body.timeout === 0) {
      events.push('first-poll');
      if (state.firstPollError) return Response.json({ ok: false, error_code: state.firstPollError }, { status: state.firstPollError });
      return Response.json({ ok: true, result: state.firstUpdates || [] });
    }
    assert.equal(body.timeout, 25);
    polling = true;
    return await new Promise((resolve, reject) => {
      settings.signal.addEventListener('abort', () => {
        events.push('stop-poll');
        polling = false;
        reject(settings.signal.reason);
      }, { once: true });
    });
  }
  return { state, events, fetchFn };
}

test('operator control is opt-in and does not perform work during construction', () => {
  assert.equal(createOperatorSwitch({ env: {}, fetchFn() { assert.fail(); } }), null);
  assert.throws(() => createOperatorSwitch({ env: { ...env, CONTRACTER_OPERATOR_N8N_URL: 'https://invalid.example' } }),
    { name: 'OperatorSwitchError', code: 'OPERATOR_CONFIG_INVALID' });
  assert(createOperatorSwitch({ env, fetchFn() { assert.fail(); } }));
});

test('waits for Telegram and pins the published n8n version during round-trip', async (t) => {
  const fixture = services();
  const operator = createOperatorSwitch({ env, fetchFn: fixture.fetchFn });
  t.after(() => operator.close());
  assert.deepEqual(await operator.status(), { active: 'n8n', switching: false });
  assert.deepEqual(await operator.select('node'), { active: 'node', switching: false });
  assert.deepEqual(await operator.status(), { active: 'node', switching: false });
  assert.deepEqual(await operator.select('n8n'), { active: 'n8n', switching: false });
  assert.deepEqual(fixture.events, ['deactivate', 'first-poll', 'stop-poll', 'activate']);
});

test('refuses an unrecognized webhook, drafts and triggers that could clear updates', async () => {
  for (const [overrides, code] of [
    [{ webhook: 'https://another.example/telegram' }, 'OPERATOR_CONFLICT'],
    [{ activeVersion: 'older-published' }, 'OPERATOR_WORKFLOW_DRAFT'],
    [{ triggerVersion: 1.4 }, 'OPERATOR_WORKFLOW_UNSAFE'],
  ]) {
    const fixture = services(overrides);
    const operator = createOperatorSwitch({ env, fetchFn: fixture.fetchFn });
    await assert.rejects(operator.select('node'), { code });
    assert.deepEqual(fixture.events, []);
    await operator.close();
  }
});

test('serializes switch requests and discloses only active and switching', async (t) => {
  const entered = Promise.withResolvers();
  const advance = Promise.withResolvers();
  const fixture = services({ beforeDeactivate() { entered.resolve(); return advance.promise; } });
  const operator = createOperatorSwitch({ env, fetchFn: fixture.fetchFn });
  t.after(async () => { advance.resolve(); await operator.close(); });
  const pending = operator.select('node');
  await entered.promise;
  assert.deepEqual(await operator.status(), { active: 'unknown', switching: true });
  await assert.rejects(operator.select('n8n'), { code: 'OPERATOR_BUSY' });
  advance.resolve();
  assert.deepEqual(await pending, { active: 'node', switching: false });
});

test('restores the last n8n version after failed Node startup and only if the webhook slot is empty', async () => {
  const fixture = services({ firstPollError: 401 });
  const operator = createOperatorSwitch({ env, fetchFn: fixture.fetchFn });
  await assert.rejects(operator.select('node'), { code: 'OPERATOR_NODE_STOPPED' });
  assert.deepEqual(fixture.events, ['deactivate', 'first-poll', 'activate']);
  assert.deepEqual(await operator.status(), { active: 'n8n', switching: false });
  await operator.close();

  const conflict = services({ firstPollError: 409 });
  const second = createOperatorSwitch({ env, fetchFn: conflict.fetchFn });
  await assert.rejects(second.select('node'), { code: 'OPERATOR_CONFLICT' });
  assert.deepEqual(conflict.events, ['deactivate', 'first-poll']);
  await second.close();
});

test('keeps a processing runner alive until it reaches the next polling boundary', async (t) => {
  const fixture = services({ firstUpdates: [{ update_id: 1 }] });
  const releaseUpdate = Promise.withResolvers();
  const finishedUpdate = Promise.withResolvers();
  const operator = createOperatorSwitch({ env, fetchFn: fixture.fetchFn, drainTimeout: 25,
    standbyFactory({ fetchFn }) {
      return {
        async run({ signal }) {
          const url = `https://api.telegram.org/bot${token}/getUpdates`;
          const options = { signal, method: 'POST', redirect: 'error', body: '{"timeout":25}' };
          await fetchFn(url, options);
          await releaseUpdate.promise;
          finishedUpdate.resolve(signal.aborted);
          await fetchFn(url, options);
        },
      };
    },
  });
  t.after(async () => { releaseUpdate.resolve(); await operator.close(); });
  await operator.select('node');
  await assert.rejects(operator.select('n8n'), { code: 'OPERATOR_NODE_BUSY' });
  assert.equal((await operator.status()).active, 'node');
  assert(!fixture.events.includes('activate'));
  releaseUpdate.resolve();
  assert.equal(await finishedUpdate.promise, false);
  assert.deepEqual(await operator.select('n8n'), { active: 'n8n', switching: false });
  assert.deepEqual(fixture.events, ['deactivate', 'first-poll', 'stop-poll', 'activate']);
});

test('does not activate a draft after restart without a verified version', async () => {
  const fixture = services({ active: false, webhook: '' });
  const operator = createOperatorSwitch({ env, fetchFn: fixture.fetchFn });
  await assert.rejects(operator.select('n8n'), { code: 'OPERATOR_VERSION_REQUIRED' });
  assert.deepEqual(fixture.events, []);
  await operator.close();

  const pinned = createOperatorSwitch({ env: { ...env, CONTRACTER_OPERATOR_N8N_VERSION_ID: versionId }, fetchFn: fixture.fetchFn });
  assert.deepEqual(await pinned.select('n8n'), { active: 'n8n', switching: false });
  assert.deepEqual(fixture.events, ['activate']);
  await pinned.close();
});

test('sanitizes provider error messages', async () => {
  const operator = createOperatorSwitch({ env, fetchFn() { throw new Error(`${webhook} ${token} ${key}`); } });
  await assert.rejects(operator.status(), (error) => {
    assert.equal(error.code, 'OPERATOR_UNAVAILABLE');
    for (const privateValue of [webhook, token, key]) assert(!error.message.includes(privateValue));
    return true;
  });
  await operator.close();
});
