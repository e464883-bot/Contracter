import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const model = 'gpt-6-luna';
const schemaName = 'contracter_gateway_probe';
const schema = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['ok'] } },
  required: ['status'],
  additionalProperties: false,
};

function inspectResponse(body, expectedModel, expectedSchema) {
  const parts = (Array.isArray(body?.output) ? body.output : [])
    .flatMap(item => item?.type === 'message' && Array.isArray(item.content) ? item.content : []);
  const refused = parts.some(part => part?.type === 'refusal');
  const outputs = parts.filter(part => part?.type === 'output_text');
  const text = outputs.length === 1 ? outputs[0].text : null;
  let parsed = text;
  if (typeof text === 'string') {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  const exactJson = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && Object.keys(parsed).length === 1 && parsed.status === 'ok');
  const format = body?.text?.format;
  const providerStrict = format?.type === 'json_schema' && format.name === expectedSchema
    && format.strict === true;
  const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const usage = {
    input_tokens: tokenCount(body?.usage?.input_tokens),
    output_tokens: tokenCount(body?.usage?.output_tokens),
    cached_input_tokens: tokenCount(body?.usage?.input_tokens_details?.cached_tokens),
    cache_write_tokens: tokenCount(body?.usage?.input_tokens_details?.cache_write_tokens),
  };
  const usageAvailable = usage.input_tokens > 0 && usage.output_tokens > 0
    && usage.cached_input_tokens !== null && usage.cached_input_tokens <= usage.input_tokens;
  const completed = body?.object === 'response' && body.status === 'completed';
  const modelMatches = body?.model === expectedModel;
  const providerStoreOff = body?.store === false;
  return {
    compatible: completed && modelMatches && !refused && exactJson && providerStrict && usageAvailable && providerStoreOff,
    synthetic_input: true,
    completed_responses_envelope: completed,
    model_matches: modelMatches,
    provider_refusal: refused,
    output_matches_schema: exactJson,
    output_encoding: typeof text === 'string' ? 'string' : text && typeof text === 'object' ? 'parsed' : null,
    provider_strict_confirmed: providerStrict,
    provider_store_off_confirmed: providerStoreOff,
    usage_available: usageAvailable,
    usage,
  };
}

export function buildGatewayProbe() {
  const names = ['Inicio manual', 'OpenAI · Responses', 'Comprobar compatibilidad'];
  const [start, response, check] = names;
  const nodes = [
    {
      id: 'a011a54c-b7c9-4b97-9eed-5900c7745c81', name: start,
      type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {},
    },
    {
      id: '49a630c8-cb5a-4a6b-9354-310c7ba8b1f6', name: response,
      type: '@n8n/n8n-nodes-langchain.openAi', typeVersion: 2.3, position: [250, 0],
      parameters: {
        resource: 'text', operation: 'response',
        modelId: { __rl: true, mode: 'list', value: model },
        responses: { values: [{ type: 'text', role: 'user', content: 'Prueba ficticia de conectividad. Devuelve status ok.' }] },
        simplify: false,
        options: {
          store: false,
          maxTokens: 256,
          reasoning: { reasoningOptions: { effort: 'low', summary: 'none' } },
          textFormat: { textOptions: { type: 'json_schema', name: schemaName, schema: JSON.stringify(schema), strict: true } },
        },
      },
      retryOnFail: false,
    },
    {
      id: '006114be-2f7c-4d82-84e6-2ac1637976ba', name: check,
      type: 'n8n-nodes-base.code', typeVersion: 2, position: [500, 0],
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: `const inspectResponse = ${inspectResponse.toString()};\nreturn [{json: inspectResponse($input.first().json, ${JSON.stringify(model)}, ${JSON.stringify(schemaName)})}];`,
      },
    },
    {
      id: 'bc840526-f08c-43dd-9714-378397fe3d69', name: 'Alcance y configuración',
      type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, 180],
      parameters: {
        width: 735, height: 260,
        content: [
          '## Prueba puntual de Gateway',
          'En **OpenAI · Responses**, selecciona **Use Gateway credits**. Verifica que el modelo `gpt-6-luna` figure como disponible y consulta su tarifa en n8n antes de ejecutar manualmente. Una ejecución consume parte del saldo Gateway.',
          'El último nodo verifica la respuesta, el modelo, la señal de JSON estricto, Store desactivado y los contadores de tokens. Algunas versiones del nodo muestran Strict aunque el código público revisado no lo envía. La validación local por sí sola no confirma que OpenAI haya recibido Strict.',
          'La prueba usa un mensaje ficticio fijo. El saldo descontado se verifica por separado en el panel de n8n. Este flujo sólo comprueba la conexión y el formato de una llamada.',
          '[Documentación de Gateway](https://docs.n8n.io/build/understand-workflows/use-gateway-credits) · [Tarifas de n8n](https://app.n8n.cloud/service-pricing)',
        ].join('\n\n'),
      },
    },
  ];
  const to = name => ({ main: [[{ node: name, type: 'main', index: 0 }]] });
  return {
    name: 'CONTRACTER · Prueba sintética de Gateway', nodes,
    connections: { [start]: to(response), [response]: to(check) },
    settings: {
      executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none',
      saveManualExecutions: false, saveExecutionProgress: false,
    },
    active: false,
    pinData: {},
  };
}

function selfTest() {
  const workflow = buildGatewayProbe();
  assert.equal(workflow.active, false);
  assert(workflow.nodes.every(node => !node.credentials));
  const node = workflow.nodes.find(candidate => candidate.type.endsWith('.code'));
  const runCheck = new Function('$input', node.parameters.jsCode);
  const check = json => runCheck({ first: () => ({ json }) })[0].json;
  const response = {
    object: 'response', status: 'completed', model, store: false,
    output: [{ type: 'message', content: [{ type: 'output_text', text: { status: 'ok' } }] }],
    text: { format: { type: 'json_schema', name: schemaName, strict: true } },
    usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
  };
  assert.equal(check(response).compatible, true);
  const output = text => [{ type: 'message', content: [{ type: 'output_text', text }] }];
  assert.equal(check({ ...response, output: output('{"status":"ok"}') }).compatible, true);
  assert.equal(check({ ...response, output: output({ status: 'ok', extra: true }) }).compatible, false);
  assert.equal(check({ ...response, output: output('not JSON') }).compatible, false);
  assert.equal(check({ ...response, output: [{ type: 'message', content: [{ type: 'refusal' }] }] }).compatible, false);
  assert.equal(check({ ...response, status: 'incomplete' }).compatible, false);
  assert.equal(check({ ...response, model: 'another-model' }).compatible, false);
  assert.equal(check({ ...response, store: true }).compatible, false);
  assert.equal(check({ ...response, usage: {} }).compatible, false);
  assert.equal(check({ ...response, usage: { input_tokens: 20, output_tokens: 5 } }).compatible, false);
  const unconfirmed = check({ ...response, text: { format: { ...response.text.format, strict: false } } });
  assert.equal(unconfirmed.output_matches_schema, true);
  assert.equal(unconfirmed.provider_strict_confirmed, false);
  assert.equal(unconfirmed.compatible, false);
  console.log('Gateway probe: local fixture checks passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target] = process.argv.slice(2);
  if (target === '--self-test') selfTest();
  else if (target) await writeFile(target, JSON.stringify(buildGatewayProbe(), null, 2) + '\n', 'utf8');
  else throw new Error('Uso: node scripts/build_gateway_probe.mjs destino.json | --self-test');
}
