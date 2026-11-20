"""Capture two additional official candidates without changing the CCom pipeline.

python legal_sources/sync_additional.py
python legal_sources/sync_additional.py --replay

Downloads the Código Civil Federal plus its reform index and the Spanish UNCITRAL
publication of the CISG plus Mexico's depositary record. Writes local candidates
with pending review. No database or LLM calls are made by this command.
"""
from __future__ import annotations

import argparse
from contextlib import nullcontext
import io
import json
from pathlib import Path
import re
import sys
from uuid import uuid4

from sync_pilot import (
    Source, PilotError, atomic_write, build_treaty_inventory, checked_raw, clean,
    digest, exclusive_capture, fetch_source, fold, json_bytes, page_blocks,
    parse_page, read_json, read_reform_date, utc_now,
)

ROOT = Path(__file__).resolve().parent
DEFAULT_DATA = ROOT / '.pilot_data' / 'additional'
PDF_CCF = 'https://www.diputados.gob.mx/LeyesBiblio/pdf/CCF.pdf'
INDEX_CCF = 'https://www.diputados.gob.mx/LeyesBiblio/ref/ccf.htm'
PDF_CISG = 'https://uncitral.un.org/sites/default/files/media-documents/uncitral/es/v1057000-cisg-s.pdf'
STATUS_CISG = 'https://treaties.un.org/pages/ViewDetails.aspx?chapter=10&clang=_en&mtdsg_no=X-10&src=TREATY'
SOURCES = (
    Source('ccf_pdf', PDF_CCF, 'application/pdf', 'pdf', 16_000_000),
    Source('ccf_index', INDEX_CCF, 'text/html', 'html', 1_000_000),
    Source('cisg_pdf', PDF_CISG, 'application/pdf', 'pdf', 12_000_000),
    Source('untc_cisg', STATUS_CISG, 'text/html', 'html', 1_000_000),
)


def require(condition, message):
    if not condition:
        raise PilotError(message)


def extract_pages(raw, lower_bound, upper_bound):
    try:
        import pypdf
    except ImportError as error:
        raise PilotError('La extracción requiere pypdf en el entorno Python.') from error
    require(raw.startswith(b'%PDF-'), 'La descarga no contiene un PDF.')
    reader = pypdf.PdfReader(io.BytesIO(raw), strict=True)
    require(not reader.is_encrypted, 'El PDF está cifrado.')
    require(lower_bound <= len(reader.pages) <= upper_bound, 'Cantidad de páginas fuera de los límites del candidato.')
    pages = []
    for number, page in enumerate(reader.pages, start=1):
        contents = page.get_contents()
        require(contents is not None and len(contents.get_data()) <= 5_000_000,
                f'Contenido descomprimido fuera del límite en página {number}.')
        text = (page.extract_text() or '').replace('\r\n', '\n').replace('\r', '\n').strip()
        require(1 <= len(text) <= 80_000 and '\x00' not in text, f'Extracción incompleta en página {number}.')
        pages.append(text)
    return pages, pypdf.__version__


def page_chunks(pages):
    chunks = []
    for number, text in enumerate(pages, start=1):
        for block, content in enumerate(page_blocks(text), start=1):
            chunks.append({
                'chunk_index': len(chunks), 'page': number,
                'locator': f'Página {number}, bloque {block}',
                'locator_verified': False, 'content': content,
                'content_sha256': digest(content.encode('utf-8')),
            })
    require(len(chunks) <= 1800, 'El candidato supera el límite de fragmentos.')
    return chunks


def candidate_base(source_id, title, identifier, language, metadata, pages, extractor):
    return {
        'schema': 'contracter-additional-source-candidate-v1',
        'source_id': source_id, 'title': title, 'official_identifier': identifier,
        'document_language': language, 'source_url': metadata['url'],
        'observed_at': metadata['observed_at'], 'body_fetched_at': metadata['body_fetched_at'],
        'raw_sha256': metadata['raw_sha256'], 'raw_bytes': metadata['raw_bytes'],
        'normalized_text_sha256': digest('\n\f\n'.join(pages).encode('utf-8')),
        'extractor_version': f'contracter-additional-1/pypdf-{extractor}',
        'page_count': len(pages), 'chunks': page_chunks(pages),
        'review_status': 'pending', 'effectivity_status': 'unknown',
        'effective_from': None, 'effective_to': None,
        'database_staged': False, 'audit_eligible': False,
    }


def build_ccf(captures):
    raw, metadata = captures['ccf_pdf']
    pages, extractor = extract_pages(raw, 200, 420)
    identity = fold(clean(pages[0]))
    require('codigo civil federal' in identity and 'camara de diputados' in identity,
            'El PDF no se identifica como Código Civil Federal de la Cámara de Diputados.')
    index_raw, index_metadata = captures['ccf_index']
    parser = parse_page(index_raw, index_metadata)
    index_text = clean(' '.join(parser.text))
    require('codigo civil federal' in fold(index_text), 'La ficha de reformas no identifica el Código Civil Federal.')
    reform = read_reform_date(pages[0])
    require(reform is not None and reform == read_reform_date(index_text),
            'Las fechas de reforma no coinciden entre el CCF y su ficha.')
    candidate = candidate_base('mx_diputados_ccf', 'Código Civil Federal', 'CCF', 'es', metadata, pages, extractor)
    candidate.update({
        'jurisdiction_level': 'federal', 'instrument_type': 'law',
        'support_url': INDEX_CCF, 'support_raw_sha256': index_metadata['raw_sha256'],
        'support_observed_at': index_metadata['observed_at'], 'observed_last_reform_on': reform,
        'applicability_note': 'Ámbito federal. La aplicación al contrato y su relación con legislación local requieren comprobación.',
    })
    return candidate


def build_cisg(captures):
    raw, metadata = captures['cisg_pdf']
    pages, extractor = extract_pages(raw, 15, 100)
    beginning = fold(clean(' '.join(pages[:3])))
    whole_text = clean(' '.join(pages))
    require('naciones unidas' in beginning and 'compraventa internacional' in beginning and 'mercaderias' in beginning,
            'El PDF no se identifica como publicación ONU de la Convención de Compraventa.')
    require(re.search(r'articulo\s+101\b', fold(whole_text)), 'El artículo final del tratado no se identificó en la extracción.')
    status_source = next(source for source in SOURCES if source.id == 'untc_cisg')
    inventory = build_treaty_inventory([(status_source, captures['untc_cisg'])])
    observation = inventory['observations'][0]
    candidate = candidate_base(
        'un_cisg_fulltext', 'Convención de las Naciones Unidas sobre los Contratos de Compraventa Internacional de Mercaderías',
        'CISG-1980', 'es', metadata, pages, extractor,
    )
    candidate.update({
        'jurisdiction_level': 'treaties', 'instrument_type': 'treaty',
        'support_url': STATUS_CISG, 'support_raw_sha256': observation['raw_sha256'],
        'support_observed_at': observation['observed_at'],
        'mexico_depositary_observation': observation,
        'applicability_note': 'Publicación oficial en español de la CNUDMI. Revisar ámbito material, exclusiones, reservas, fechas y aplicación al caso.',
    })
    return candidate


def summarize(candidate):
    return {key: candidate[key] for key in (
        'source_id', 'title', 'source_url', 'document_language', 'raw_sha256',
        'normalized_text_sha256', 'observed_at', 'body_fetched_at', 'support_url',
        'support_raw_sha256', 'page_count', 'review_status', 'effectivity_status',
        'database_staged', 'audit_eligible',
    )} | {'chunk_count': len(candidate['chunks'])}


def run_capture(directory, replay=False):
    latest_path = directory / 'latest.json'
    prior = read_json(latest_path) if latest_path.is_file() else None
    require(not replay or prior is not None, 'No existe una captura adicional completa para reproducir.')
    run_id = utc_now().replace(':', '').replace('-', '') + '-' + uuid4().hex
    captures, metadata, errors = {}, {}, []
    for source in SOURCES:
        try:
            previous = prior['sources'].get(source.id) if prior else None
            if replay:
                require(previous is not None, f'Falta la captura de {source.id}.')
                raw, observation = checked_raw(directory, source, previous), previous.copy()
            else:
                raw, observation = fetch_source(directory, source, previous)
            captures[source.id], metadata[source.id] = (raw, observation), observation
        except (PilotError, OSError, ValueError, KeyError, TypeError) as error:
            errors.append({'source_id': source.id, 'error': str(error)[:350]})
    candidates = {}
    for name, dependencies, builder in (
        ('ccf', {'ccf_pdf', 'ccf_index'}, build_ccf),
        ('cisg', {'cisg_pdf', 'untc_cisg'}, build_cisg),
    ):
        if dependencies <= captures.keys():
            try:
                candidates[name] = builder(captures)
            except Exception as error:
                errors.append({'source_id': name, 'error': f'{type(error).__name__}: {str(error)[:320]}'})
    summaries = {name: summarize(candidate) for name, candidate in candidates.items()}
    if replay:
        require(not errors and set(candidates) == {'ccf', 'cisg'}, f'La reproducción falló: {errors!r}.')
        require(summaries == prior['candidates'], 'La reproducción difiere de los candidatos registrados.')
    report = {
        'schema': 'contracter-additional-captures-v1', 'run_id': run_id,
        'run_kind': 'replay' if replay else 'fetch', 'recorded_at': utc_now(),
        'status': 'complete' if not errors and len(candidates) == 2 else 'partial' if candidates else 'failed',
        'sources': metadata, 'candidates': summaries, 'errors': errors,
        'coverage_status': 'two_local_candidates_pending_review',
    }
    if not replay:
        run_directory = directory / 'runs' / run_id
        for name, candidate in candidates.items():
            candidate['run_id'] = run_id
            atomic_write(run_directory / f'{name}_candidate.json', json_bytes(candidate))
        atomic_write(run_directory / 'manifest.json', json_bytes(report))
        if report['status'] == 'complete':
            atomic_write(latest_path, json_bytes(report))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--replay', action='store_true')
    parser.add_argument('--data-dir', type=Path, default=DEFAULT_DATA)
    args = parser.parse_args()
    try:
        directory = args.data_dir.resolve()
        with nullcontext() if args.replay else exclusive_capture(directory):
            report = run_capture(directory, args.replay)
        code = 0 if report['status'] == 'complete' else 2
    except (PilotError, ValueError, OSError, KeyError, TypeError) as error:
        report = {'status': 'failed', 'errors': [{'error': str(error)[:350]}]}
        code = 1
    print(json.dumps({key: value for key, value in report.items() if key != 'sources'}, ensure_ascii=False, indent=2))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
