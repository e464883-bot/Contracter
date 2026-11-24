-- Cotejo documental de la demostración, realizado el 2026-11-23.
-- Registra procedencia sin convertirla en revisión jurídica ni habilitar el corpus de auditoría.
BEGIN;

INSERT INTO public.legal_sources (
    source_id, title, authority, source_url, official_host, official_role, scope_levels, notes
) VALUES
    ('mx_diputados_ccf_documental', 'Código Civil Federal', 'Cámara de Diputados',
     'https://www.diputados.gob.mx/LeyesBiblio/pdf/CCF.pdf', 'www.diputados.gob.mx',
     'official_compilation', ARRAY['federal'],
     'Cotejo del 2026-11-23 con la ficha de reformas. PDF de 370 páginas, última reforma DOF 2025-11-14. SHA-256 4d4090f60137ce0d82bf321c24c962f698c407910fc94ebeb34b49d0a4236a76. Artículos 1796 y 1797, p. 175. Referencia documental sin versión indexada.'),
    ('un_cisg_documental', 'Convención de Viena sobre compraventa internacional de mercaderías',
     'Colección de Tratados de las Naciones Unidas',
     'https://treaties.un.org/pages/ViewDetails.aspx?chapter=10&clang=_en&mtdsg_no=X-10&src=TREATY',
     'treaties.un.org', 'official_informational_catalog', ARRAY['treaties'],
     'Ficha del depositario cotejada el 2026-11-23, capítulo X.10, fila México. Adhesión registrada el 1987-12-29. Referencia documental del depósito, sin pronunciamiento sobre efectos o aplicabilidad al expediente.')
ON CONFLICT (source_id) DO NOTHING;

INSERT INTO public.legal_documents (
    source_id, official_identifier, title, instrument_type, jurisdiction_level, canonical_url
)
SELECT source_id, 'CCF', title, 'law', 'federal', source_url
FROM public.legal_sources
WHERE source_id = 'mx_diputados_ccf_documental'
  AND source_url = 'https://www.diputados.gob.mx/LeyesBiblio/pdf/CCF.pdf'
UNION ALL
SELECT source_id, 'UNTC-X-10', title, 'treaty', 'treaties', source_url
FROM public.legal_sources
WHERE source_id = 'un_cisg_documental'
  AND official_host = 'treaties.un.org'
ON CONFLICT (source_id, official_identifier) DO NOTHING;

UPDATE public.legal_document_versions AS version
SET review_evidence = version.review_evidence || jsonb_build_array(jsonb_build_object(
    'kind', 'official_provenance',
    'checked_on', '2026-11-23',
    'authority', 'Cámara de Diputados',
    'official_url', 'https://www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf',
    'reforms_url', 'https://www.diputados.gob.mx/LeyesBiblio/ref/ccom.htm',
    'observed_latest_reform', '2025-11-14',
    'official_pdf_sha256', version.raw_sha256,
    'reference_pages', jsonb_build_array(51),
    'reference_articles', jsonb_build_array(379, 380, 383),
    'scope', 'Coincidencia de bytes con el PDF oficial y localización de artículos. Revisión jurídica pendiente.'
))
WHERE version.source_id = 'mx_diputados_ccom_pilot'
  AND version.raw_sha256 = 'b99bbf981434011b6351ef308922fea90f6f0f8777b113183cf1737840c5bbef'
  AND version.review_status = 'pending'
  AND NOT version.review_evidence @> '[{"kind":"official_provenance","checked_on":"2026-11-23"}]'::jsonb;

COMMIT;
