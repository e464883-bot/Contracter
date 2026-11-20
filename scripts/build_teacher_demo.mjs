import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8').replaceAll('\r\n', '\n');
const hash = (value) => createHash('sha256').update(value).digest('base64');

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`No se encontró la sección ${start}`);
  return source.slice(startIndex, endIndex);
}

const sample = JSON.parse(read('docs/data/sample_case.json'));
if (sample.mode !== 'mock' || sample.publication.contains_sensitive_data !== false
    || sample.costs.pricing_status !== 'mock' || sample.costs.total_usd !== 0
    || sample.jurisdiction.sources.length !== 0
    || sample.costs.events.some((event) => event.cost_usd !== 0 || event.tokens_input !== 0 || event.tokens_output !== 0)) {
  throw new Error('La demostración docente requiere una muestra ficticia pública, sin fuentes ni consumo de API.');
}

const workflow = JSON.parse(read('n8n_workflows/workflow_02_fast_qa.json'));
const perspectives = Object.fromEntries(['Harvey', 'Murdock', 'Lupin'].map((agent) => {
  const code = workflow.nodes.find((node) => node.name === `${agent} - consulta`)?.parameters.jsCode;
  const answer = code?.match(/answer:("(?:[^"\\]|\\.)*")/u)?.[1];
  if (!answer) throw new Error(`No se encontró la respuesta simulada de ${agent}`);
  return [agent, JSON.parse(answer)];
}));

const app = read('docs/app.js');
const script = [
  section(app, 'const AUDITORS', 'let renderRequest'),
  section(app, 'function element', '// A deliberately small display gate'),
  section(app, 'function displayDate', 'function sourceUrl'),
  section(app, 'function renderDecision', 'function apiBase')
    .replace('  currentCase = data;\n', '')
    .replace('  renderLegalSources(data);\n', ''),
  section(app, 'const tabs =', 'loadDemo();'),
  `const fixture = JSON.parse($("demo-data").textContent);
render(fixture.case, false, "expediente ficticio incluido en este archivo");
$("simulation-notice").querySelector("p").textContent = "Resultados ficticios preparados para ilustrar el flujo de trabajo. Durante la demostración se muestran estos resultados en el navegador.";
setText("legal-coverage", "Esta simulación usa México como supuesto de demostración. El expediente contiene cero referencias normativas.");
for (const [agent, answer] of Object.entries(fixture.perspectives)) setText("qa-" + agent, answer);
$("qa-guide").addEventListener("click", () => {
  $("fast-qa").open = true;
});`,
].join('\n');

let html = read('docs/index.html');
html = html.replace('Contracter · Operación', 'Contracter · Demostración docente');
html = html.replace(/<meta name="description"[^>]+>/u, '<meta name="description" content="Evaluación docente de Contracter con un expediente ficticio y una consulta simulada. Funciona sin internet.">');
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/u,
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`);
html = html.replace(/  <link rel="stylesheet" href="styles\.css">\n  <script src="app\.js" defer><\/script>/u,
  () => `<style>${read('docs/styles.css')}\n.teacher-route{margin-top:18px;margin-bottom:20px}.teacher-route .guide-link{display:inline-flex;margin-top:8px}.teacher-route .operation-body li{padding-bottom:8px}</style>`);

const sectionsToRemove = [
  ['          <div class="file-actions">', '        </div>\n        <div id="load-message"'],
  ['        <section class="panel backend-panel"', '        <div id="case-content"'],
  ['                <div class="voice-control">', '              </section>\n              <section class="panel context-panel"'],
  ['              <section class="panel integrations-panel">', '            </aside>'],
];
for (const [start, end] of sectionsToRemove) html = html.replace(section(html, start, end), '');

const walkthrough = `<section id="operation" class="panel operation-panel teacher-route"><details open><summary><span><strong>Cómo evaluar la demostración</strong></span><span class="details-symbol" aria-hidden="true">+</span></summary><div class="operation-body"><ol><li><a class="guide-link" href="#versions"><strong>Compare el contrato original y la propuesta</strong></a>. La bitácora de Jarvis registra qué cambió y por qué.</li><li><a class="guide-link" href="#team"><strong>Revise el consenso y los 13 roles</strong></a>. Observe por qué V2 sigue pendiente de aprobación humana.</li><li><a id="qa-guide" class="guide-link" href="#qa"><strong>Abra la consulta rápida simulada</strong></a>. Observe cómo se reúnen las tres perspectivas.</li></ol></div></details></section>`;
html = html.replace(section(html, '        <section id="operation"', '      </section>\n      <footer'), '');
html = html.replace('        <div id="case-content"', `${walkthrough}\n        <div id="case-content"`);

const qa = `<section id="qa" class="panel operation-panel teacher-route"><details id="fast-qa"><summary><span><strong>Consulta rápida simulada</strong></span><span class="details-symbol" aria-hidden="true">+</span></summary><div class="operation-body"><p><strong>¿Qué riesgos comerciales tiene esta muestra?</strong></p><ol><li><strong>Harvey</strong><p id="qa-Harvey"></p></li><li><strong>Murdock</strong><p id="qa-Murdock"></p></li><li><strong>Lupin</strong><p id="qa-Lupin"></p></li></ol><p>Watson reúne las tres perspectivas. La respuesta de muestra conserva el contrato original y requiere revisión humana.</p></div></details></section>`;
html = html.replace('              <section id="costs"', `${qa}\n              <section id="costs"`);
html = html.replace('Guía de operación', 'Guía de evaluación')
  .replace('Backend sin configurar', 'Archivo autónomo')
  .replace('SCAFFOLD / V1.0', 'EVALUACIÓN DOCENTE')
  .replace('Decide con el expediente a la vista.', 'Demostración de auditoría contractual')
  .replace('Revisa cambios, fuentes y aprobación antes de liberar la propuesta V2.', 'Explore el contrato ficticio, el control de cambios y la consulta rápida. Abrir este archivo cuesta USD 0 y funciona sin internet.')
  .replace('Estado de la tubería', 'Estado de la auditoría simulada')
  .replace('Operación · aprobación fuera del navegador', 'Evaluación docente · datos ficticios');
html = html.replace('<div id="load-message"', '<noscript><p class="load-message">Descargue este archivo y ábralo en un navegador con JavaScript habilitado para ver la demostración.</p></noscript>\n        <div id="load-message"');

const data = JSON.stringify({ case: sample, perspectives }).replaceAll('<', '\\u003c');
html = html.replace('</body>', () => `<script type="application/json" id="demo-data">${data}</script>\n<script>${script}</script>\n</body>`);
const output = new URL('../../Contracter_Demo_Docente.html', import.meta.url);
writeFileSync(output, html, 'utf8');
console.log(output.href);
