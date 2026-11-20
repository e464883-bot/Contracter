-- CONTRACTER / instalación inicial del corpus jurídico en PostgreSQL 14+.
-- Diseño local preparado; no acredita ejecución en una base real.
-- Antes de aplicarlo: inspeccionar el proyecto y sus tablas; usar una base propia.
-- No crea proyectos, planes, usuarios, claves ni conexiones. No lee archivos del
-- servidor. No requiere pgvector, embeddings ni una API de pago.
-- Este archivo no es un historial generado por Supabase CLI: al desplegar se
-- incorporará como migración revisada con la herramienta y proyecto confirmados.
-- Referencias verificadas el 2026-11-04:
-- https://supabase.com/changelog (CLI v3: target local/remote explícito)
-- https://supabase.com/docs/guides/database/full-text-search
-- https://supabase.com/docs/guides/api/securing-your-api
-- https://supabase.com/docs/guides/database/functions
BEGIN;

CREATE TABLE IF NOT EXISTS public.legal_sources (
    source_id text PRIMARY KEY CHECK (source_id ~ '^[a-z][a-z0-9_]{2,79}$'),
    title text NOT NULL CHECK (length(btrim(title)) > 0),
    authority text NOT NULL CHECK (length(btrim(authority)) > 0),
    source_url text NOT NULL CHECK (source_url ~ '^https://[^[:space:]@]+$'),
    official_host text NOT NULL CHECK (official_host ~ '^[a-z0-9][a-z0-9.-]*[a-z0-9]$'),
    country_code text NOT NULL DEFAULT 'MX' CHECK (country_code = 'MX'),
    official_role text NOT NULL CHECK (official_role IN (
        'official_publication', 'official_compilation',
        'official_informational_compilation', 'official_informational_catalog',
        'official_judicial_publication', 'geographic_reference_not_law')),
    scope_levels text[] NOT NULL CHECK (cardinality(scope_levels) > 0 AND
        scope_levels <@ ARRAY['federal','state','municipal','treaties',
                              'judicial_criteria','geographic_inventory']::text[]),
    governance_status text NOT NULL DEFAULT 'pending'
        CHECK (governance_status IN ('pending','approved','suspended')),
    approved_by text,
    approved_at timestamptz,
    ingestion_enabled boolean NOT NULL DEFAULT false,
    coverage_status text NOT NULL DEFAULT 'unknown'
        CHECK (coverage_status IN ('unknown','partial','inventoried','reviewed')),
    max_staleness_hours integer NOT NULL DEFAULT 48
        CHECK (max_staleness_hours BETWEEN 1 AND 720),
    last_attempt_at timestamptz,
    last_successful_ingestion_at timestamptz,
    notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (substring(source_url FROM '^https://([^/?#:]+)') = official_host),
    CHECK (governance_status <> 'approved' OR
        (approved_by IS NOT NULL AND length(btrim(approved_by)) > 0
         AND approved_at IS NOT NULL)),
    CHECK (NOT ingestion_enabled OR governance_status = 'approved')
);

CREATE TABLE IF NOT EXISTS public.legal_documents (
    document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id text NOT NULL REFERENCES public.legal_sources(source_id) ON DELETE RESTRICT,
    official_identifier text NOT NULL CHECK (length(btrim(official_identifier)) > 0),
    title text NOT NULL CHECK (length(btrim(title)) > 0),
    instrument_type text NOT NULL CHECK (instrument_type IN ('constitution','law',
        'regulation','decree','agreement','standard','treaty','judicial_criterion','other')),
    country_code text NOT NULL DEFAULT 'MX' CHECK (country_code = 'MX'),
    jurisdiction_level text NOT NULL CHECK (jurisdiction_level IN
        ('federal','state','municipal','treaties','judicial_criteria')),
    entity_code text CHECK (entity_code ~ '^(0[1-9]|[12][0-9]|3[0-2])$'),
    municipality_code text CHECK (municipality_code ~ '^[0-9]{3}$' AND municipality_code <> '000'),
    territorial_unit_kind text CHECK (territorial_unit_kind IN ('municipality','territorial_demarcation')),
    canonical_url text NOT NULL CHECK (canonical_url ~ '^https://[^[:space:]]+$'),
    discovery_status text NOT NULL DEFAULT 'catalogued'
        CHECK (discovery_status IN ('catalogued','missing_from_catalog','retired_from_catalog')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, official_identifier),
    UNIQUE (document_id, source_id),
    CHECK (jurisdiction_level NOT IN ('state','municipal') OR entity_code IS NOT NULL),
    CHECK (jurisdiction_level <> 'municipal' OR
        (municipality_code IS NOT NULL AND territorial_unit_kind IS NOT NULL)),
    CHECK (municipality_code IS NULL OR entity_code IS NOT NULL),
    CHECK (jurisdiction_level NOT IN ('federal','treaties') OR
        (entity_code IS NULL AND municipality_code IS NULL AND territorial_unit_kind IS NULL)),
    CHECK (jurisdiction_level = 'municipal' OR
        (municipality_code IS NULL AND territorial_unit_kind IS NULL))
);

CREATE INDEX IF NOT EXISTS legal_documents_jurisdiction_idx
    ON public.legal_documents(country_code, entity_code, municipality_code, jurisdiction_level);

CREATE TABLE IF NOT EXISTS public.legal_document_versions (
    version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL,
    source_id text NOT NULL,
    raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[a-f0-9]{64}$'),
    normalized_text_sha256 text CHECK (normalized_text_sha256 ~ '^[a-f0-9]{64}$'),
    original_storage_path text NOT NULL CHECK (length(btrim(original_storage_path)) > 0),
    original_source_url text NOT NULL CHECK (original_source_url ~ '^https://[^[:space:]]+$'),
    raw_bytes bigint CHECK (raw_bytes > 0),
    fetched_at timestamptz NOT NULL DEFAULT now(),
    published_on date,
    http_etag text,
    http_last_modified text,
    extractor_version text NOT NULL CHECK (length(btrim(extractor_version)) > 0),
    extraction_method text NOT NULL CHECK (extraction_method IN ('html','pdf_text','ocr','official_text','manual_verified')),
    index_status text NOT NULL DEFAULT 'pending' CHECK (index_status IN ('pending','ready','failed')),
    review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
    effectivity_status text NOT NULL DEFAULT 'unknown'
        CHECK (effectivity_status IN ('unknown','in_force','future','superseded','repealed')),
    -- effective_to es un límite EXCLUSIVO; NULL no significa vigencia verificada.
    effective_from date,
    effective_to date,
    reviewed_by text,
    reviewed_at timestamptz,
    review_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(review_evidence) = 'array'),
    applicability_notes text NOT NULL DEFAULT '',
    treaty_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(treaty_metadata) = 'object'),
    UNIQUE (document_id, raw_sha256),
    FOREIGN KEY (document_id, source_id)
        REFERENCES public.legal_documents(document_id, source_id) ON DELETE RESTRICT,
    CHECK (effective_to IS NULL OR effective_from IS NOT NULL),
    CHECK (effective_to IS NULL OR effective_to > effective_from),
    CHECK (review_status <> 'approved' OR
        (reviewed_by IS NOT NULL AND length(btrim(reviewed_by)) > 0
         AND reviewed_at IS NOT NULL AND effective_from IS NOT NULL
         AND effectivity_status <> 'unknown' AND jsonb_array_length(review_evidence) > 0)),
    CHECK (effectivity_status NOT IN ('superseded','repealed') OR effective_to IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS legal_versions_document_idx
    ON public.legal_document_versions(document_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS legal_versions_source_idx
    ON public.legal_document_versions(source_id);
CREATE INDEX IF NOT EXISTS legal_versions_reviewed_dates_idx
    ON public.legal_document_versions(effective_from, effective_to)
    WHERE review_status = 'approved' AND index_status = 'ready';

CREATE TABLE IF NOT EXISTS public.legal_chunks (
    chunk_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id uuid NOT NULL REFERENCES public.legal_document_versions(version_id) ON DELETE RESTRICT,
    chunk_index integer NOT NULL CHECK (chunk_index >= 0),
    content text NOT NULL CHECK (length(btrim(content)) > 0 AND length(content) <= 100000),
    -- convert_to es STABLE en PG14: usar CHECK, no una columna generada que
    -- requiere expresiones IMMUTABLE. El ingestor calcula y envía el mismo hash.
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    locator text,
    locator_verified boolean NOT NULL DEFAULT false,
    search_vector tsvector GENERATED ALWAYS AS
        (to_tsvector('spanish'::regconfig, coalesce(locator,'') || ' ' || content)) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (version_id, chunk_index),
    CHECK (content_sha256 = encode(sha256(convert_to(content, 'UTF8')), 'hex')),
    CHECK (NOT locator_verified OR (locator IS NOT NULL AND length(btrim(locator)) > 0))
);

CREATE INDEX IF NOT EXISTS legal_chunks_fts_idx ON public.legal_chunks USING gin(search_vector);

CREATE TABLE IF NOT EXISTS public.legal_sync_runs (
    run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id text NOT NULL REFERENCES public.legal_sources(source_id) ON DELETE RESTRICT,
    idempotency_key text,
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','partial','failed')),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    http_status integer CHECK (http_status BETWEEN 100 AND 599),
    discovered_documents bigint CHECK (discovered_documents >= 0),
    changed_documents bigint CHECK (changed_documents >= 0),
    rejected_documents bigint CHECK (rejected_documents >= 0),
    error_code text,
    error_summary text,
    checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
    UNIQUE (source_id, idempotency_key),
    CHECK (finished_at IS NULL OR finished_at >= started_at),
    CHECK (status = 'running' OR finished_at IS NOT NULL),
    CHECK (status <> 'succeeded' OR error_code IS NULL)
);

CREATE INDEX IF NOT EXISTS legal_sync_runs_source_started_idx
    ON public.legal_sync_runs(source_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.legal_coverage (
    scope_key text PRIMARY KEY CHECK (length(btrim(scope_key)) > 0),
    country_code text NOT NULL DEFAULT 'MX' CHECK (country_code = 'MX'),
    scope_level text NOT NULL CHECK (scope_level IN
        ('federal','state','municipal','treaties','interinstitutional_agreements','judicial_criteria')),
    entity_code text CHECK (entity_code ~ '^(0[1-9]|[12][0-9]|3[0-2])$'),
    status text NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('unknown','partial','inventoried','reviewed')),
    -- Contar DOCUMENTOS distintos en el corte, no filas de versiones/chunks.
    expected_document_count bigint CHECK (expected_document_count >= 0),
    indexed_document_count bigint CHECK (indexed_document_count >= 0),
    reviewed_document_count bigint CHECK (reviewed_document_count >= 0),
    inventory_as_of date,
    denominator_method text,
    notes text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expected_document_count IS NULL OR
        (inventory_as_of IS NOT NULL AND denominator_method IS NOT NULL
         AND length(btrim(denominator_method)) > 0)),
    CHECK (expected_document_count IS NULL OR indexed_document_count IS NULL OR
        indexed_document_count <= expected_document_count),
    CHECK (indexed_document_count IS NULL OR reviewed_document_count IS NULL OR
        reviewed_document_count <= indexed_document_count),
    CHECK (scope_level NOT IN ('state','municipal') OR entity_code IS NOT NULL)
);

-- Impide modificar la identidad/contenido del original ya incorporado.
-- Cambiar el archivo produce una fila nueva; se permite revisar metadatos de vigencia.
CREATE OR REPLACE FUNCTION public.legal_prevent_version_identity_changes()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
    IF ROW(NEW.version_id,NEW.document_id,NEW.source_id,NEW.raw_sha256,
           NEW.normalized_text_sha256,NEW.original_storage_path,
           NEW.original_source_url,NEW.raw_bytes,NEW.fetched_at,NEW.extractor_version,NEW.extraction_method)
       IS DISTINCT FROM
       ROW(OLD.version_id,OLD.document_id,OLD.source_id,OLD.raw_sha256,
           OLD.normalized_text_sha256,OLD.original_storage_path,
           OLD.original_source_url,OLD.raw_bytes,OLD.fetched_at,OLD.extractor_version,OLD.extraction_method) THEN
        RAISE EXCEPTION 'Version identity/content metadata is immutable; insert a new version' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS legal_version_identity_immutable ON public.legal_document_versions;
CREATE TRIGGER legal_version_identity_immutable BEFORE UPDATE ON public.legal_document_versions
FOR EACH ROW EXECUTE FUNCTION public.legal_prevent_version_identity_changes();

-- RPC de consulta: sólo backend privilegiado, sin SECURITY DEFINER ni SQL dinámico.
-- p_entity_code NULL => sólo federal/tratados/criterios nacionales.
-- Al indicar entidad se agregan normas de ESA entidad; municipal requiere ambos códigos.
-- p_include_unreviewed es diagnóstico backend: no autoriza conclusiones de legalidad.
CREATE OR REPLACE FUNCTION public.legal_search_fts(
    p_query text,
    p_country_code text DEFAULT 'MX',
    p_entity_code text DEFAULT NULL,
    p_municipality_code text DEFAULT NULL,
    p_as_of date DEFAULT current_date,
    p_limit integer DEFAULT 8,
    p_include_unreviewed boolean DEFAULT false
)
RETURNS TABLE (
    source_id text, document_id uuid, version_id uuid, chunk_id uuid,
    title text, excerpt text, source_url text, locator text,
    published_on date, effective_from date, effective_to date,
    effectivity_status text, review_status text, raw_sha256 text,
    source_last_synced_at timestamptz, rank real
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE q tsquery;
BEGIN
    IF p_country_code IS DISTINCT FROM 'MX' OR p_as_of IS NULL OR
       p_query IS NULL OR length(btrim(p_query)) < 2 OR length(p_query) > 1000 OR
       p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 OR p_include_unreviewed IS NULL THEN
        RAISE EXCEPTION 'Invalid legal search parameters' USING ERRCODE='22023';
    END IF;
    IF (p_entity_code IS NOT NULL AND p_entity_code !~ '^(0[1-9]|[12][0-9]|3[0-2])$') OR
       (p_municipality_code IS NOT NULL AND
        (p_entity_code IS NULL OR p_municipality_code !~ '^[0-9]{3}$' OR p_municipality_code = '000')) THEN
        RAISE EXCEPTION 'Invalid territorial filter' USING ERRCODE='22023';
    END IF;
    q := plainto_tsquery('spanish'::regconfig, p_query);
    RETURN QUERY
    SELECT s.source_id,d.document_id,v.version_id,c.chunk_id,d.title,
           left(c.content,3000),v.original_source_url,c.locator,
           v.published_on,v.effective_from,v.effective_to,v.effectivity_status,
           v.review_status,v.raw_sha256,s.last_successful_ingestion_at,
           ts_rank_cd(c.search_vector,q,32)
    FROM public.legal_chunks AS c
    JOIN public.legal_document_versions AS v ON v.version_id = c.version_id
    JOIN public.legal_documents AS d ON d.document_id = v.document_id
    JOIN public.legal_sources AS s ON s.source_id = d.source_id
    WHERE d.country_code = p_country_code
      AND s.governance_status <> 'suspended'
      AND s.official_role <> 'geographic_reference_not_law'
      AND v.index_status = 'ready'
      AND c.search_vector @@ q
      AND (
          d.jurisdiction_level IN ('federal','treaties')
          OR (d.jurisdiction_level = 'judicial_criteria' AND d.entity_code IS NULL)
          OR (p_entity_code IS NOT NULL AND d.entity_code = p_entity_code
              AND d.jurisdiction_level IN ('state','judicial_criteria'))
          OR (p_entity_code IS NOT NULL AND p_municipality_code IS NOT NULL
              AND d.entity_code = p_entity_code AND d.municipality_code = p_municipality_code
              AND d.jurisdiction_level = 'municipal')
      )
      AND (
          p_include_unreviewed
          OR (
              s.governance_status = 'approved'
              AND s.last_successful_ingestion_at IS NOT NULL
              AND s.last_successful_ingestion_at >= now() - make_interval(hours => s.max_staleness_hours)
              AND v.review_status = 'approved' AND c.locator_verified
              AND v.effectivity_status IN ('in_force','superseded','repealed')
              AND v.effective_from <= p_as_of
              AND (v.effective_to IS NULL OR p_as_of < v.effective_to)
          )
      )
    ORDER BY ts_rank_cd(c.search_vector,q,32) DESC,v.published_on DESC NULLS LAST,c.chunk_id
    LIMIT p_limit;
END;
$$;

-- RLS deniega por defecto a clientes. Las consultas del servidor se autorizan
-- mediante grants explícitos; service_role jamás se entrega al HTML/ElevenLabs.
ALTER TABLE public.legal_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legal_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legal_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legal_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legal_coverage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legal_sources,public.legal_documents,public.legal_document_versions,
    public.legal_chunks,public.legal_sync_runs,public.legal_coverage FROM PUBLIC;
REVOKE ALL ON FUNCTION public.legal_prevent_version_identity_changes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.legal_search_fts(text,text,text,text,date,integer,boolean) FROM PUBLIC;

DO $legal_privileges$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
        REVOKE ALL ON public.legal_sources,public.legal_documents,public.legal_document_versions,
            public.legal_chunks,public.legal_sync_runs,public.legal_coverage FROM anon;
        REVOKE ALL ON FUNCTION public.legal_search_fts(text,text,text,text,date,integer,boolean) FROM anon;
        REVOKE ALL ON FUNCTION public.legal_prevent_version_identity_changes() FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
        REVOKE ALL ON public.legal_sources,public.legal_documents,public.legal_document_versions,
            public.legal_chunks,public.legal_sync_runs,public.legal_coverage FROM authenticated;
        REVOKE ALL ON FUNCTION public.legal_search_fts(text,text,text,text,date,integer,boolean) FROM authenticated;
        REVOKE ALL ON FUNCTION public.legal_prevent_version_identity_changes() FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
        REVOKE ALL ON public.legal_sources,public.legal_documents,public.legal_document_versions,
            public.legal_chunks,public.legal_sync_runs,public.legal_coverage FROM service_role;
        GRANT SELECT,INSERT,UPDATE ON public.legal_sources,public.legal_documents,
            public.legal_document_versions,public.legal_sync_runs,public.legal_coverage TO service_role;
        GRANT SELECT,INSERT ON public.legal_chunks TO service_role;
        GRANT UPDATE(locator,locator_verified) ON public.legal_chunks TO service_role;
        GRANT EXECUTE ON FUNCTION public.legal_search_fts(text,text,text,text,date,integer,boolean) TO service_role;
        GRANT EXECUTE ON FUNCTION public.legal_prevent_version_identity_changes() TO service_role;
    END IF;
END
$legal_privileges$;

COMMENT ON TABLE public.legal_sources IS 'Registro de fuentes; pending no habilita ingestión ni acredita cobertura.';
COMMENT ON TABLE public.legal_document_versions IS 'Original/versionado inmutable; vigencia requiere evidencia, fecha y revisor.';
COMMENT ON TABLE public.legal_coverage IS 'Cobertura documental por inventario fechado. NULL significa desconocido, nunca cero ni 100%.';
COMMENT ON FUNCTION public.legal_search_fts(text,text,text,text,date,integer,boolean) IS
    'RAG léxico sólo backend. Filtra territorio, fecha, revisión y frescura; un resultado vacío exige abstención.';

-- No se insertan normas ni se aprueban fuentes aquí. Inicializar metadatos desde
-- legal_sources/catalog.json con gobernanza pending y cobertura unknown; revisar
-- cada origen antes de habilitar un actualizador. Mantener originales privados.
COMMIT;

-- Después de aplicar, ejecutar pruebas de verdad antes de declarar operativo:
-- 1) Inspección grants/RLS:
-- SELECT relname,relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
-- WHERE n.nspname='public' AND relname IN ('legal_sources','legal_documents',
--   'legal_document_versions','legal_chunks','legal_sync_runs','legal_coverage');
-- SELECT has_function_privilege('anon','public.legal_search_fts(text,text,text,text,date,integer,boolean)','EXECUTE');
-- 2) Sin corpus revisado: debe devolver 0 filas, no inventar respuesta:
-- SELECT * FROM public.legal_search_fts('plazo de pago');
-- 3) Probar fuente suspendida, vigencia desconocida, cita no verificada, corpus
-- vencido y jurisdicción distinta con fixtures en una transacción ROLLBACK.
-- 4) Verificar con get_advisors security/performance y EXPLAIN (ANALYZE,BUFFERS)
-- sobre volumen representativo. Estas pruebas NO están acreditadas por el archivo.
