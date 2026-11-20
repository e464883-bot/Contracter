"""Collect a bounded pilot from Mexico's Cámara de Diputados and the UN depositary.

Usage: python legal_sources/sync_pilot.py
       python legal_sources/sync_pilot.py --replay
       python legal_sources/sync_pilot.py --export-stage-sql
       python legal_sources/sync_pilot.py --export-review-pages 1 2

Local only. A complete run writes raw captures, a provenance manifest, and a
candidate bundle for the optional private SQL staging RPC. --replay reads the
latest complete capture and checks hashes and parsers without refreshing dates.
--export-stage-sql prepares one query from the replayed official PDF and index.
--export-review-pages prepares a local packet from selected PDF pages.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
from html import escape
from html.parser import HTMLParser
import io
import json
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
DEFAULT_DATA = ROOT / '.pilot_data'
PILOT_SOURCE_ID = 'mx_diputados_ccom_pilot'
PARSER_VERSION = 'contracter-mx-pilot-1'
CANDIDATE_SCHEMA = 'contracter-mx-ccom-candidate-v1'
TREATY_SCHEMA = 'contracter-mx-treaty-inventory-v1'
MAX_PDF_PAGES = 350
MAX_CHUNKS = 1200
CHUNK_SIZE = 2800
MAX_SECONDS_PER_FETCH = 35
SOCKET_TIMEOUT = 12
CODE_URL = 'https://www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf'
REFORM_URL = 'https://www.diputados.gob.mx/LeyesBiblio/ref/ccom.htm'
UNTC_ROOT = 'https://treaties.un.org/pages/ViewDetails.aspx?'
TREATIES = {
    'untc_cisg': ('X-10', 'United Nations Convention on Contracts for the International Sale of Goods'),
    'untc_ny_arbitration': ('XXII-1', 'Convention on the Recognition and Enforcement of Foreign Arbitral Awards'),
}


@dataclass(frozen=True)
class Source:
    id: str
    url: str
    mime: str
    suffix: str
    max_bytes: int


SOURCES = (
    Source('ccom_pdf', CODE_URL, 'application/pdf', 'pdf', 16_000_000),
    Source('ccom_reforms', REFORM_URL, 'text/html', 'html', 1_000_000),
    Source('untc_cisg', UNTC_ROOT + 'chapter=10&clang=_en&mtdsg_no=X-10&src=TREATY', 'text/html', 'html', 1_000_000),
    Source('untc_ny_arbitration', UNTC_ROOT + 'chapter=22&clang=_en&mtdsg_no=XXII-1&src=TREATY', 'text/html', 'html', 1_000_000),
)


class PilotError(RuntimeError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise PilotError(f'Redirección no permitida para {request.full_url} ({code}).')


def require(condition, message):
    if not condition:
        raise PilotError(message)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
        temporary_path.replace(path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


@contextmanager
def exclusive_capture(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.capture.lock').open('a+b') as lock:
        lock.seek(0)
        try:
            if sys.platform == 'win32':
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise PilotError('Ya hay una captura en curso para este directorio.') from error
        yield


def raw_path(directory, source, raw_sha256):
    require(re.fullmatch(r'[a-f0-9]{64}', raw_sha256), 'Huella de captura inválida.')
    return directory / 'raw' / f'{raw_sha256}.{source.suffix}'


def checked_raw(directory, source, metadata):
    require(metadata['url'] == source.url, 'La captura corresponde a otra URL.')
    path = raw_path(directory, source, metadata['raw_sha256'])
    require(0 < path.stat().st_size == metadata['raw_bytes'] <= source.max_bytes,
            'Tamaño de captura inconsistente.')
    raw = path.read_bytes()
    require(len(raw) == metadata['raw_bytes'], 'La captura cambió durante la lectura.')
    require(digest(raw) == metadata['raw_sha256'], 'La huella de la captura local cambió.')
    return raw


def fetch_source(directory, source, prior):
    headers = {
        'User-Agent': 'Contracter/1.0 bounded public-source verification',
        'Accept': source.mime,
        'Accept-Encoding': 'identity',
    }
    if prior:
        for header, field in [('If-None-Match', 'etag'), ('If-Modified-Since', 'last_modified')]:
            value = prior.get(field)
            if isinstance(value, str) and 0 < len(value) < 512 and '\r' not in value and '\n' not in value:
                headers[header] = value
    opener = build_opener(NoRedirect())
    started = time.monotonic()
    request = Request(source.url, headers=headers)
    try:
        with opener.open(request, timeout=SOCKET_TIMEOUT) as response:
            require(response.status == 200 and response.geturl() == source.url, 'Respuesta de origen inesperada.')
            require(response.headers.get_content_type() == source.mime, 'Tipo de contenido inesperado.')
            require(response.headers.get('Content-Encoding', 'identity').lower() == 'identity', 'Codificación HTTP inesperada.')
            declared_length = response.headers.get('Content-Length')
            if declared_length is not None:
                require(declared_length.isdecimal() and int(declared_length) <= source.max_bytes, 'Tamaño anunciado fuera del límite.')
            body = bytearray()
            while piece := response.read(64 * 1024):
                require(time.monotonic() - started <= MAX_SECONDS_PER_FETCH, 'Tiempo de descarga agotado.')
                body.extend(piece)
                require(len(body) <= source.max_bytes, 'Tamaño de descarga fuera del límite.')
            raw = bytes(body)
            if declared_length is not None:
                require(len(raw) == int(declared_length), 'Captura HTTP incompleta.')
            require(bool(raw), 'Respuesta vacía.')
            capture_time = utc_now()
            metadata = {
                'url': source.url, 'media_type': source.mime, 'http_status': 200,
                'raw_sha256': digest(raw), 'raw_bytes': len(raw),
                'observed_at': capture_time, 'body_fetched_at': capture_time,
                'etag': response.headers.get('ETag'),
                'last_modified': response.headers.get('Last-Modified'),
                'charset': response.headers.get_content_charset(),
            }
    except HTTPError as error:
        if error.code != 304 or not prior or not {'If-None-Match', 'If-Modified-Since'} & headers.keys():
            raise
        raw = checked_raw(directory, source, prior)
        metadata = {**prior, 'http_status': 304, 'observed_at': utc_now()}
    target = raw_path(directory, source, metadata['raw_sha256'])
    if target.exists():
        require(digest(target.read_bytes()) == metadata['raw_sha256'], 'Captura archivada alterada.')
    else:
        atomic_write(target, raw)
    metadata['local_raw_path'] = target.relative_to(directory).as_posix()
    metadata['raw_changed'] = None if not prior else prior['raw_sha256'] != metadata['raw_sha256']
    return raw, metadata


def clean(value):
    return ' '.join(value.split())


def fold(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value.casefold()) if not unicodedata.combining(c))


def decode_html(raw, metadata):
    charset = metadata.get('charset')
    if charset and charset.casefold() in {'windows-1252', 'cp1252', 'iso-8859-1', 'latin-1'}:
        return raw.decode(charset)
    try:
        return raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return raw.decode('cp1252')


class PageParser(HTMLParser):
    """Collect visible text and table rows. No scripts or styles are executed."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text = []
        self.rows = []
        self.row = None
        self.cell = None
        self.skip = None

    def handle_starttag(self, tag, attrs):
        if tag in {'script', 'style', 'noscript'}:
            self.skip = tag
            return
        if self.skip:
            return
        if tag == 'tr':
            self.row = []
        elif tag in {'td', 'th'} and self.row is not None:
            self.cell = []

    def handle_endtag(self, tag):
        if self.skip:
            if tag == self.skip:
                self.skip = None
            return
        if tag in {'td', 'th'} and self.row is not None and self.cell is not None:
            self.row.append(clean(' '.join(self.cell)))
            self.cell = None
        elif tag == 'tr' and self.row is not None:
            self.rows.append(self.row)
            self.row = None
            self.cell = None

    def handle_data(self, data):
        if not self.skip:
            self.text.append(data)
            if self.cell is not None:
                self.cell.append(data)


def parse_page(raw, metadata):
    parser = PageParser()
    parser.feed(decode_html(raw, metadata))
    parser.close()
    return parser


MONTHS = {name: index for index, name in enumerate((
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'), start=1)}


def read_reform_date(text):
    match = re.search(r'ultima reforma (?:publicada )?(?:en el diario oficial de la federacion el |dof\s*)'
                      r'(\d{1,2})(?:\s+de\s+([a-z]+)\s+de\s+|[-/](\d{1,2})[-/])(\d{4})', fold(clean(text)))
    if not match:
        return None
    day, month_name, month_number, year = match.groups()
    month = MONTHS.get(month_name) if month_name else int(month_number)
    return datetime(int(year), month, int(day)).date().isoformat() if month else None


def read_amount_update(text):
    match = re.search(r'cantidades actualizadas por acuerdo dof\s*(\d{1,2})[-/](\d{1,2})[-/](\d{4})', fold(clean(text)))
    if not match:
        return None
    day, month, year = map(int, match.groups())
    return datetime(year, month, day).date().isoformat()


def page_blocks(text):
    remaining = text.strip()
    while len(remaining) > CHUNK_SIZE:
        cut = remaining.rfind('\n', CHUNK_SIZE // 2, CHUNK_SIZE + 1)
        if cut < 0:
            cut = remaining.rfind(' ', CHUNK_SIZE // 2, CHUNK_SIZE + 1)
        cut = cut if cut > 0 else CHUNK_SIZE
        yield remaining[:cut].strip()
        remaining = remaining[cut:].strip()
    if remaining:
        yield remaining


def build_code_candidate(raw_pdf, pdf_metadata, index_html, index_metadata):
    try:
        import pypdf
    except ImportError as error:
        raise PilotError('Este piloto necesita pypdf en el entorno Python.') from error
    require(raw_pdf.startswith(b'%PDF-'), 'La respuesta no contiene un PDF.')
    reader = pypdf.PdfReader(io.BytesIO(raw_pdf), strict=True)
    require(not reader.is_encrypted, 'El PDF está cifrado.')
    page_count = len(reader.pages)
    require(100 <= page_count <= MAX_PDF_PAGES, 'Cantidad de páginas fuera del rango de revisión del piloto.')
    pages = []
    for page in reader.pages:
        contents = page.get_contents()
        require(len(contents.get_data() if contents is not None else b'') <= 5_000_000,
                'Contenido descomprimido de página fuera de límite.')
        page_text = page.extract_text() or ''
        page_text = page_text.replace('\r\n', '\n').replace('\r', '\n').strip()
        require(len(page_text) <= 80_000 and '\x00' not in page_text, 'Texto de página fuera de límite.')
        pages.append(page_text)
    first_page = fold(clean(pages[0]))
    require('codigo de comercio' in first_page and 'camara de diputados' in first_page,
            'El PDF no se identifica como Código de Comercio de la Cámara de Diputados.')
    require(sum(bool(p) for p in pages) == page_count, 'Hay páginas sin texto. Revisión de extracción requerida.')
    index = parse_page(index_html, index_metadata)
    index_text = clean(' '.join(index.text))
    require('codigo de comercio' in fold(index_text), 'La ficha de reformas no identifica el Código de Comercio.')
    pdf_reform = read_reform_date(pages[0])
    index_reform = read_reform_date(index_text)
    require(pdf_reform is not None and pdf_reform == index_reform,
            'La fecha de reforma no coincide entre el PDF y su ficha.')
    pdf_amounts = read_amount_update(pages[0])
    index_amounts = read_amount_update(index_text)
    require(pdf_amounts == index_amounts, 'La fecha de actualización de cantidades no coincide.')
    chunks = []
    for page_number, page in enumerate(pages, start=1):
        for part, content in enumerate(page_blocks(page), start=1):
            chunks.append({'chunk_index': len(chunks), 'page': page_number,
                           'locator': f'Página {page_number}, bloque {part}',
                           'content': content, 'content_sha256': digest(content.encode('utf-8'))})
    require(1 <= len(chunks) <= MAX_CHUNKS, 'La extracción supera el límite de fragmentos del piloto.')
    return {
        'schema': CANDIDATE_SCHEMA, 'source_id': PILOT_SOURCE_ID,
        'source_url': CODE_URL, 'reform_index_url': REFORM_URL,
        'observed_at': pdf_metadata['observed_at'], 'body_fetched_at': pdf_metadata['body_fetched_at'],
        'raw_sha256': pdf_metadata['raw_sha256'], 'raw_bytes': pdf_metadata['raw_bytes'],
        'reform_index_raw_sha256': index_metadata['raw_sha256'],
        'normalized_text_sha256': digest('\n\f\n'.join(pages).encode('utf-8')),
        'observed_last_reform_on': pdf_reform, 'observed_amount_update_on': pdf_amounts,
        'extractor_version': f'{PARSER_VERSION}/pypdf-{pypdf.__version__}',
        'page_count': page_count, 'chunks': chunks,
        'review_status': 'pending', 'effectivity_status': 'unknown', 'effective_from': None,
    }


def build_treaty_inventory(captures):
    observations = []
    for source, (raw, metadata) in captures:
        parser = parse_page(raw, metadata)
        normalized = fold(clean(' '.join(parser.text)))
        treaty_id, title = TREATIES[source.id]
        require(fold(title) in normalized and 'ratification' in normalized and 'participant' in normalized,
                f'Ficha del depositario no reconocida: {source.id}.')
        mexico_rows = [row for row in parser.rows if len(row) == 3 and fold(row[0]) == 'mexico'
                       and re.fullmatch(r'\d{1,2} [A-Za-z]{3} \d{4}(?: [A-Za-z]{1,2})?', row[2])]
        require(len(mexico_rows) == 1, f'No se identificó una fila inequívoca de México: {source.id}.')
        participant, signature, action = mexico_rows[0]
        observations.append({'official_identifier': treaty_id, 'title': title, 'participant_as_listed': participant,
                             'signature_as_listed': signature or None, 'depositary_action_as_listed': action,
                             'source_url': source.url, 'raw_sha256': metadata['raw_sha256'],
                             'observed_at': metadata['observed_at'],
                             'effectivity_for_mexico': 'not_verified', 'treaty_text_ingested': False})
    evidence_keys = [[item['official_identifier'], item['signature_as_listed'], item['depositary_action_as_listed']]
                     for item in observations]
    return {
        'schema': TREATY_SCHEMA, 'scope': 'two_fixed_un_depositary_records', 'coverage_status': 'partial_inventory_only',
        'full_treaty_texts_ingested': 0, 'observations': observations,
        'semantic_sha256': digest(json_bytes(sorted(evidence_keys))),
    }


def run_pilot(directory, replay=False):
    prior_path = directory / 'latest.json'
    prior = read_json(prior_path) if prior_path.is_file() else None
    require(not replay or prior is not None, 'No existe una captura completa para volver a procesar.')
    run_id = utc_now().replace(':', '').replace('-', '') + '-' + uuid4().hex
    run_directory = directory / 'runs' / run_id
    metadata = {}
    captures = {}
    errors = []
    for source in SOURCES:
        try:
            previous = prior['sources'].get(source.id) if prior else None
            if replay:
                require(previous is not None, f'Falta la captura {source.id}.')
                raw, observation = checked_raw(directory, source, previous), previous.copy()
            else:
                raw, observation = fetch_source(directory, source, previous)
            captures[source.id] = (raw, observation)
            metadata[source.id] = observation
        except (PilotError, OSError, URLError, ValueError) as error:
            errors.append({'source_id': source.id, 'error': str(error)[:350]})
    candidate = None
    treaties = None
    if {'ccom_pdf', 'ccom_reforms'} <= set(captures):
        try:
            candidate = build_code_candidate(*captures['ccom_pdf'], *captures['ccom_reforms'])
            candidate['run_id'] = run_id
        except (PilotError, ValueError, OSError) as error:
            errors.append({'source_id': PILOT_SOURCE_ID, 'error': str(error)[:350]})
        except Exception as error:
            errors.append({'source_id': PILOT_SOURCE_ID, 'error': f'Error de extracción: {type(error).__name__}.'})
    treaty_sources = [source for source in SOURCES if source.id in TREATIES]
    if all(source.id in captures for source in treaty_sources):
        try:
            treaties = build_treaty_inventory([(source, captures[source.id]) for source in treaty_sources])
        except (PilotError, ValueError, OSError) as error:
            errors.append({'source_id': 'un_depositary_treaties', 'error': str(error)[:350]})
    if replay:
        require(not errors and candidate and treaties, f'Falló la reproducción: {errors!r}.')
        require(candidate['raw_sha256'] == prior['candidate']['raw_sha256'] and
                candidate['normalized_text_sha256'] == prior['candidate']['normalized_text_sha256'] and
                len(candidate['chunks']) == prior['candidate']['chunks'] and
                treaties['semantic_sha256'] == prior['treaty_inventory']['semantic_sha256'],
                'La reproducción no coincide con la extracción registrada.')
    complete = not errors and candidate is not None and treaties is not None
    report = {
        'run_id': run_id, 'status': 'complete' if complete else 'partial' if candidate or treaties else 'failed',
        'run_kind': 'replay' if replay else 'fetch', 'recorded_at': utc_now(), 'sources': metadata, 'errors': errors,
        'candidate': None if not candidate else {
            'raw_sha256': candidate['raw_sha256'], 'normalized_text_sha256': candidate['normalized_text_sha256'],
            'pages': candidate['page_count'], 'chunks': len(candidate['chunks']), 'review_status': 'pending',
            'observed_last_reform_on': candidate['observed_last_reform_on'],
            'observed_amount_update_on': candidate['observed_amount_update_on'],
            'raw_changed': metadata['ccom_pdf']['raw_changed'],
        },
        'treaty_inventory': None if not treaties else {
            'observations': len(treaties['observations']), 'semantic_sha256': treaties['semantic_sha256'],
            'metadata_changed': None if not prior else prior['treaty_inventory']['semantic_sha256'] != treaties['semantic_sha256'],
        },
        'coverage': {
            'federal': 'one_candidate_pending_review' if candidate else 'pilot_unavailable',
            'state': '32_entities_catalogued_coverage_unknown',
            'municipal': 'inventory_pending_including_demarcations',
            'treaties': 'two_depositary_records_only' if treaties else 'pilot_unavailable',
            'interinstitutional_agreements': 'separate_inventory_pending',
        },
    }
    if not replay:
        if candidate:
            atomic_write(run_directory / 'ccom_candidate.json', json_bytes(candidate))
        if treaties:
            atomic_write(run_directory / 'treaty_inventory.json', json_bytes(treaties))
        atomic_write(run_directory / 'manifest.json', json_bytes(report))
        if complete:
            atomic_write(prior_path, json_bytes(report))
    return report


def checked_code_capture(directory):
    manifest = read_json(directory / 'latest.json')
    run_id = manifest.get('run_id', '')
    require(manifest.get('status') == 'complete' and manifest.get('run_kind') == 'fetch' and
            re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{32}', run_id),
            'La última captura completa no se puede identificar.')
    pdf_source, index_source = SOURCES[:2]
    pdf_metadata = manifest['sources'][pdf_source.id]
    index_metadata = manifest['sources'][index_source.id]
    pdf_bytes = checked_raw(directory, pdf_source, pdf_metadata)
    index_bytes = checked_raw(directory, index_source, index_metadata)
    bundle = build_code_candidate(pdf_bytes, pdf_metadata, index_bytes, index_metadata)
    bundle['run_id'] = run_id
    run_directory = directory / 'runs' / run_id
    require(bundle == read_json(run_directory / 'ccom_candidate.json'),
            'El candidato guardado no coincide con la extracción reproducida.')
    return bundle, run_directory


def export_stage_sql(directory):
    bundle, run_directory = checked_code_capture(directory)
    run_id = bundle['run_id']
    payload = json.dumps(bundle, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    delimiter = '$contracter_legal_candidate$'
    require(delimiter not in payload, 'El contenido colisiona con el delimitador de exportación SQL.')
    raw_sha256 = bundle['raw_sha256']
    storage_path = f'contracter-legal-private/raw/{raw_sha256}.pdf'
    sql_path = run_directory / 'stage_ccom.sql'
    query = (
        '-- Contracter. Staging de un candidato con revisión pendiente.\n'
        f'-- Captura {run_id}. Original {CODE_URL}\n'
        'SELECT public.legal_stage_pilot_ccom(\n'
        f'{delimiter}\n{payload}\n{delimiter}::jsonb,\n'
        f"    '{storage_path}'\n"
        ') AS stage_result;\n'
    )
    atomic_write(sql_path, query.encode('utf-8'))
    return {'sql': str(sql_path), 'pdf': str(raw_path(directory, SOURCES[0], raw_sha256)),
            'sha256': raw_sha256, 'private_storage_path': storage_path, 'review_status': 'pending'}


def export_review_pages(directory, requested_pages):
    bundle, run_directory = checked_code_capture(directory)
    pages = sorted(set(requested_pages))
    require(pages and 1 <= pages[0] <= pages[-1] <= bundle['page_count'],
            f"Las páginas deben estar entre 1 y {bundle['page_count']}.")
    raw_sha256 = bundle['raw_sha256']
    local_pdf = f'../../raw/{raw_sha256}.pdf'
    pages_text = ', '.join(map(str, pages))
    selected = [chunk for chunk in bundle['chunks'] if chunk['page'] in pages]
    excerpts = '\n'.join(
        f"""<section>
  <h2>Fragmento {chunk['chunk_index']} · {escape(chunk['locator'])}</h2>
  <p><a href="{local_pdf}#page={chunk['page']}">Ver página en el PDF archivado</a></p>
  <p>SHA-256 del fragmento <code>{chunk['content_sha256']}</code></p>
  <pre>{escape(chunk['content'])}</pre>
</section>"""
        for chunk in selected
    )
    html = f"""<!doctype html>
<html lang="es">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Código de Comercio · revisión de fragmentos</title>
<style>
  body {{ max-width: 52rem; margin: 2rem auto; padding: 0 1rem; color: #172335;
    background: #f7f9fc; font: 1rem/1.55 "Atkinson Hyperlegible Next", system-ui, sans-serif; }}
  h1, h2 {{ line-height: 1.25; }}
  a {{ color: #174d90; }}
  section {{ border-top: 1px solid #b7c4d5; margin-top: 1.75rem; }}
  code, pre {{ overflow-wrap: anywhere; }}
  pre {{ font: inherit; white-space: pre-wrap; background: white; padding: 1rem; }}
</style>
<main>
  <h1>Código de Comercio</h1>
  <p>Material para revisión jurídica. Vigencia y referencias pendientes.</p>
  <p>Páginas seleccionadas: {pages_text} de {bundle['page_count']}. Fragmentos: {len(selected)}.</p>
  <p><a href="{local_pdf}">PDF archivado</a> · <a href="{CODE_URL}">PDF de la Cámara de Diputados</a>
    · <a href="{REFORM_URL}">Ficha oficial de reformas</a></p>
  <p>Fecha de captura <time>{escape(bundle['observed_at'])}</time><br>
    SHA-256 del PDF <code>{raw_sha256}</code></p>
  <p>Coteja los fragmentos con el PDF y registra el artículo, el localizador exacto, la fecha de efectos y su evidencia oficial. Usa el número y la huella del fragmento al devolver observaciones.</p>
  {excerpts}
</main>
</html>
"""
    selection_id = digest(pages_text.encode('ascii'))[:12]
    output = run_directory / f'revision_ccom_{selection_id}.html'
    atomic_write(output, html.encode('utf-8'))
    return {'html': str(output), 'pages': pages, 'chunks': len(selected),
            'sha256': raw_sha256, 'review_status': 'pending'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--replay', action='store_true', help='Comprobar la última captura completa sin acceder a la red.')
    action.add_argument('--export-stage-sql', action='store_true', help='Preparar una consulta SQL desde la captura local.')
    action.add_argument('--export-review-pages', nargs='+', type=int, metavar='PÁGINA',
                        help='Preparar un HTML local para cotejar los fragmentos de las páginas seleccionadas.')
    parser.add_argument('--data-dir', type=Path, default=DEFAULT_DATA, help='Directorio local de capturas y manifiestos.')
    args = parser.parse_args()
    run_kind = ('export_review_pages' if args.export_review_pages else
                'export_stage_sql' if args.export_stage_sql else 'replay' if args.replay else 'fetch')
    try:
        directory = args.data_dir.resolve()
        if args.export_stage_sql:
            print(json.dumps(export_stage_sql(directory), indent=2))
            return 0
        if args.export_review_pages:
            print(json.dumps(export_review_pages(directory, args.export_review_pages), indent=2))
            return 0
        capture_lock = nullcontext() if args.replay else exclusive_capture(directory)
        with capture_lock:
            report = run_pilot(directory, args.replay)
    except (PilotError, ValueError, OSError, KeyError, TypeError) as error:
        report = {
            'run_id': None, 'status': 'failed', 'run_kind': run_kind, 'recorded_at': utc_now(),
            'candidate': None, 'treaty_inventory': None, 'coverage': None,
            'errors': [{'source_id': None, 'error': str(error)[:350]}],
        }
        exit_code = 1
    else:
        exit_code = 0 if report['status'] == 'complete' else 2
    summary_fields = ('run_id', 'status', 'run_kind', 'recorded_at', 'candidate',
                      'treaty_inventory', 'coverage', 'errors')
    print(json.dumps({key: report[key] for key in summary_fields}, indent=2))
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
