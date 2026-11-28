import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Changes to the public example must be reviewed before updating this digest.
const fixtureDigest = '7d4426926185ece9c605a44c972a3825b21dcfddcb503aab10b8db9732631285';
const fixturePath = new URL('../docs/data/sample_case.json', import.meta.url);
const fixtureText = readFileSync(fixturePath, 'utf8').replaceAll('\r\n', '\n');
const hash = (content, encoding) => createHash('sha256').update(content).digest(encoding);
if (hash(fixtureText, 'hex') !== fixtureDigest) {
  throw new Error('La muestra pública cambió. Revisa todo su contenido antes de autorizar la nueva huella.');
}
const sample = JSON.parse(fixtureText);
if (sample.mode !== 'mock' || sample.publication.target !== 'preview' ||
    sample.publication.contains_sensitive_data !== false || sample.publication.redacted_for_public !== true ||
    sample.fury.released || sample.human_approval.status !== 'PENDING' || sample.jurisdiction.sources.length ||
    sample.costs.total_usd !== 0 || sample.costs.pricing_status !== 'mock') {
  throw new Error('Sólo se puede publicar la muestra ficticia, sin liberación ni consumo de API.');
}

const roles = [
  ['Fury', 'Coordina el flujo y controla la liberación.'],
  ['Afton', 'Inspecciona el documento recibido.'],
  ['House', 'Supervisa las respuestas de los agentes.'],
  ['Jane', 'Reúne los datos que faltan.'],
  ['Sherlock', 'Organiza el contexto y sus fuentes.'],
  ['Morty', 'Comprueba la claridad del texto.'],
  ['Harvey', 'Revisa el equilibrio comercial.'],
  ['Murdock', 'Evalúa el sustento normativo.'],
  ['Lupin', 'Busca vacíos e interpretaciones adversas.'],
  ['Hamilton', 'Redacta la propuesta V2.'],
  ['Jarvis', 'Explica los cambios por cláusula.'],
  ['Watson', 'Presenta el reporte ejecutivo.'],
  ['Glenn', 'Explica el resultado en lenguaje sencillo.'],
];

function escape(value) {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function clauses(version) {
  return version.text.split('\n').map((line) => `<p>${escape(line)}</p>`).join('\n');
}

const changelog = sample.changelog.map((change) => `
  <li><h3>Cláusula ${change.line_v2}</h3>
    <dl><dt>Antes</dt><dd>${escape(change.before)}</dd>
    <dt>Después</dt><dd>${escape(change.after)}</dd></dl>
    <p>${escape(change.reason)}</p>
  </li>`).join('');

const findings = sample.audits.map(({agent, findings}) => `
  <article><h3>${escape(agent)}</h3>
    ${findings.map(({clause, observation, recommendation}) => `<p><strong>Cláusula ${escape(clause)}.</strong> ${escape(observation)}</p><p>${escape(recommendation)}</p>`).join('')}
  </article>`).join('');

const style = `
:root{color-scheme:dark;font:100%/1.6 system-ui,sans-serif;color:#ecf4f7;background:#101922}
*{box-sizing:border-box}html{scroll-padding-top:1rem}body{margin:0}
header,main,footer{max-width:1120px;margin:auto;padding:clamp(24px,6vw,76px)}
header{padding-bottom:20px}main{padding-top:20px}footer{padding-top:0;color:#9cafbd}
nav{display:flex;flex-wrap:wrap;gap:12px 24px;margin:24px 0 0}a{color:#a4ebd6;text-underline-offset:4px}
a:focus-visible{outline:3px solid #a4ebd6;outline-offset:4px}
h1,h2,h3,p{margin:0 0 14px}h1{font-size:clamp(2.9rem,9vw,6.5rem);line-height:.95;letter-spacing:-.06em}
h2{font-size:clamp(1.5rem,4vw,2.3rem);line-height:1.15;letter-spacing:-.025em}h3{font-size:1.06rem}
section{padding:34px 0;border-top:1px solid #384a54}section p:last-child{margin-bottom:0}
.eyebrow{color:#a4ebd6;letter-spacing:.14em;font-size:.8rem;text-transform:uppercase;font-weight:700}
.intro{max-width:65ch;color:#c7d6de;font-size:1.18rem}
.notice{max-width:68ch;border-left:3px solid #efc380;padding-left:16px;color:#f9dfb0}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:22px 0 0}
article{background:#172633;border:1px solid #344957;border-radius:12px;padding:clamp(16px,3vw,24px)}
article p{overflow-wrap:anywhere}article strong,dt,summary{color:#a4ebd6}dl{margin:0}
dd{margin:0 0 .55rem}ul,ol{padding-left:1.35rem}
li{margin-bottom:.55rem}.changes{list-style:none;padding-left:0}.changes li+li{margin-top:18px}
.changes li{padding:16px 0;border-bottom:1px solid #344957}.changes li p{color:#c7d6de}
summary{cursor:pointer;font-weight:650}.reports{max-width:75ch}
@media(max-width:650px){.grid{grid-template-columns:1fr}header,main,footer{padding-left:20px;padding-right:20px}}
`;

const html = `<!doctype html>
<html lang="es-MX">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Demostración pública de revisión contractual con un expediente de ejemplo.">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-${hash(style, 'base64')}'; connect-src 'none'; base-uri 'none'; form-action 'none'">
  <title>Contracter · Demostración</title>
  <style>${style}</style>
</head>
<body>
<header>
  <p class="eyebrow">Demostración pública</p>
  <h1>Contracter</h1>
  <p class="intro">Explora cómo se revisa un contrato, qué cambios podrían resolver sus ambigüedades y qué debe validar una persona antes de aprobarlos.</p>
  <p class="notice">Este recorrido usa un expediente de ejemplo y resultados simulados. La propuesta V2 está pendiente de revisión humana.</p>
  <nav aria-label="Secciones">
    <a href="#versiones">Comparar versiones</a>
    <a href="#jarvis">Cambios de Jarvis</a>
    <a href="#analisis">Hallazgos y agentes</a>
    <a href="#reportes">Reportes</a>
  </nav>
</header>
<main>
  <section id="versiones" aria-labelledby="versiones-titulo">
    <h2 id="versiones-titulo">Comparar versiones</h2>
    <div class="grid">
      <article><h3>V1 · Contrato recibido</h3>${clauses(sample.versions.v1)}</article>
      <article><h3>V2 · Propuesta de edición</h3>${clauses(sample.versions.v2)}</article>
    </div>
  </section>
  <section id="jarvis" aria-labelledby="jarvis-titulo">
    <h2 id="jarvis-titulo">Bitácora de Jarvis</h2>
    <ol class="changes">${changelog}</ol>
  </section>
  <section id="analisis" aria-labelledby="analisis-titulo">
    <h2 id="analisis-titulo">Hallazgos de la auditoría simulada</h2>
    <p>Las cuatro perspectivas revisaron el mismo borrador. Su consenso sigue sujeto a la revisión humana.</p>
    <div class="grid">${findings}</div>
    <details><summary>Ver los 13 roles</summary>
      <ul>${roles.map(([name, job]) => `<li><strong>${escape(name)}.</strong> ${escape(job)}</li>`).join('')}</ul>
    </details>
  </section>
  <section id="reportes" class="reports" aria-labelledby="reportes-titulo">
    <h2 id="reportes-titulo">Reportes del expediente de ejemplo</h2>
    <h3>Watson · Resumen ejecutivo</h3>
    <p>${escape(sample.reports.watson.summary)}</p>
    <h3>Glenn · Explicación en lenguaje sencillo</h3>
    <p>${escape(sample.reports.glenn.explanation)}</p>
  </section>
</main>
<footer><p>Contracter · Ejecución simulada con costo de modelo de USD 0</p></footer>
</body>
</html>
`;

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) {
  throw new Error('Uso: node scripts/build_teacher_demo.mjs [--output ruta.html]');
}
const output = args.length
  ? resolve(args[1])
  : fileURLToPath(new URL('../../Contracter_Demo_Docente.html', import.meta.url));
if (!output.endsWith('.html')) throw new Error('La salida debe tener extensión .html.');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, html, 'utf8');
console.log(output);
