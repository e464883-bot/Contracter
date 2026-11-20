-- Optional private staging for the Cámara de Diputados Código de Comercio pilot.
-- Apply after legal_corpus.sql in the intended project. The pilot runner does not
-- call this migration or RPC. Its ccom_candidate.json supplies p_bundle.
-- Before calling, retain the exact raw PDF in private storage and verify its SHA-256.
-- p_original_storage_path is a private object reference, not a public or signed URL.
-- This RPC only reads Supabase Storage metadata. It requires the caller to have
-- access to storage.buckets and storage.objects and never grants that access itself.
-- This migration registers the source; only an explicit RPC call stages a candidate.
BEGIN;

INSERT INTO public.legal_sources(
    source_id, title, authority, source_url, official_host, official_role, scope_levels, notes
) VALUES (
    'mx_diputados_ccom_pilot', 'Código de Comercio · piloto Cámara de Diputados',
    'Cámara de Diputados del H. Congreso de la Unión',
    'https://www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf', 'www.diputados.gob.mx',
    'official_compilation', ARRAY['federal']::text[],
    'Fuente dedicada a un solo documento. La sincronización de este PDF no acredita frescura del catálogo federal.'
) ON CONFLICT (source_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.legal_stage_pilot_ccom(
    p_bundle jsonb,
    p_original_storage_path text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    pilot_source constant text := 'mx_diputados_ccom_pilot';
    document_url constant text := 'https://www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf';
    index_url constant text := 'https://www.diputados.gob.mx/LeyesBiblio/ref/ccom.htm';
    raw_hash text;
    normalized_hash text;
    observation_time timestamptz;
    body_capture_time timestamptz;
    pages integer;
    chunk_count integer;
    run_key text;
    stored_document uuid;
    stored_version uuid;
    stored_run uuid;
    previous_observation timestamptz;
    source_status text;
    prior_hash text;
    prior_index_hash text;
    stored_text_hash text;
    existing_object_path text;
    new_version boolean := false;
    held boolean := false;
BEGIN
    IF jsonb_typeof(p_bundle) IS DISTINCT FROM 'object'
       OR pg_column_size(p_bundle) > 6000000
       OR p_bundle->>'schema' IS DISTINCT FROM 'contracter-mx-ccom-candidate-v1'
       OR p_bundle->>'source_id' IS DISTINCT FROM pilot_source
       OR p_bundle->>'source_url' IS DISTINCT FROM document_url
       OR p_bundle->>'reform_index_url' IS DISTINCT FROM index_url
       OR p_bundle->>'review_status' IS DISTINCT FROM 'pending'
       OR p_bundle->>'effectivity_status' IS DISTINCT FROM 'unknown'
       OR p_bundle->>'effective_from' IS NOT NULL THEN
        RAISE EXCEPTION 'Invalid pilot candidate bundle' USING ERRCODE='22023';
    END IF;

    raw_hash := p_bundle->>'raw_sha256';
    normalized_hash := p_bundle->>'normalized_text_sha256';
    run_key := p_bundle->>'run_id';
    IF NOT coalesce(raw_hash ~ '^[a-f0-9]{64}$',false)
       OR NOT coalesce(normalized_hash ~ '^[a-f0-9]{64}$',false)
       OR NOT coalesce((p_bundle->>'reform_index_raw_sha256') ~ '^[a-f0-9]{64}$',false)
       OR NOT coalesce(run_key ~ '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{32}$',false)
       OR NOT coalesce((p_bundle->>'observed_last_reform_on') ~ '^\d{4}-\d{2}-\d{2}$',false)
       OR NOT coalesce((p_bundle->>'extractor_version') ~ '^contracter-mx-pilot-[0-9]+/pypdf-[a-z0-9.]+$',false)
       OR p_original_storage_path IS DISTINCT FROM ('contracter-legal-private/raw/' || raw_hash || '.pdf')
       OR NOT coalesce((p_bundle->>'observed_at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$',false)
       OR NOT coalesce((p_bundle->>'body_fetched_at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$',false)
       OR jsonb_typeof(p_bundle->'chunks') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Invalid provenance or private original path' USING ERRCODE='22023';
    END IF;

    observation_time := (p_bundle->>'observed_at')::timestamptz;
    body_capture_time := (p_bundle->>'body_fetched_at')::timestamptz;
    pages := (p_bundle->>'page_count')::integer;
    chunk_count := jsonb_array_length(p_bundle->'chunks');
    IF pages IS NULL OR pages NOT BETWEEN 100 AND 350
       OR chunk_count NOT BETWEEN pages AND 1200
       OR (p_bundle->>'raw_bytes')::bigint IS NULL
       OR (p_bundle->>'raw_bytes')::bigint NOT BETWEEN 1 AND 16000000
       OR body_capture_time > observation_time
       OR observation_time > now() + interval '5 minutes' THEN
        RAISE EXCEPTION 'Pilot candidate exceeds bounds' USING ERRCODE='22023';
    END IF;

    IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
        RAISE EXCEPTION 'Supabase Storage metadata is unavailable' USING ERRCODE='22023';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM storage.objects AS stored_object
        JOIN storage.buckets AS bucket ON bucket.id=stored_object.bucket_id
        WHERE bucket.id='contracter-legal-private'
          AND bucket."public" IS FALSE
          AND stored_object.name=('raw/' || raw_hash || '.pdf')
    ) THEN
        RAISE EXCEPTION 'Exact pilot PDF is missing from the private bucket' USING ERRCODE='22023';
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_bundle->'chunks') WITH ORDINALITY AS c(item,pos)
        WHERE c.item->>'chunk_index' IS DISTINCT FROM (c.pos-1)::text
           OR jsonb_typeof(c.item->'page') IS DISTINCT FROM 'number'
           OR NOT coalesce((c.item->>'page') ~ '^[0-9]{1,3}$',false)
           OR (c.item->>'page')::integer NOT BETWEEN 1 AND pages
           OR jsonb_typeof(c.item->'content') IS DISTINCT FROM 'string'
           OR NOT coalesce(length(btrim(c.item->>'content')) BETWEEN 1 AND 2800,false)
           OR NOT coalesce((c.item->>'locator') ~ '^Página [0-9]{1,3}, bloque [0-9]{1,3}$',false)
           OR split_part(c.item->>'locator',',',1) IS DISTINCT FROM ('Página ' || (c.item->>'page'))
           OR c.item->>'content_sha256' IS DISTINCT FROM
                encode(sha256(convert_to(c.item->>'content','UTF8')),'hex')
    ) OR (SELECT count(DISTINCT item->>'page') FROM jsonb_array_elements(p_bundle->'chunks') AS c(item)) <> pages THEN
        RAISE EXCEPTION 'Pilot chunks fail sequence, page coverage, or hash validation' USING ERRCODE='22023';
    END IF;

    -- The row lock serializes observations and makes repeat imports safe.
    SELECT last_attempt_at, governance_status INTO previous_observation,source_status
    FROM public.legal_sources WHERE source_id=pilot_source AND source_url=document_url FOR UPDATE;
    IF NOT FOUND OR source_status='suspended' THEN
        RAISE EXCEPTION 'Pilot source missing or suspended' USING ERRCODE='22023';
    END IF;

    SELECT run_id INTO stored_run FROM public.legal_sync_runs
    WHERE source_id=pilot_source AND idempotency_key=run_key
      AND checkpoint->>'raw_sha256'=raw_hash AND checkpoint->>'normalized_text_sha256'=normalized_hash;
    IF FOUND THEN
        RETURN jsonb_build_object('run_id',stored_run,'status','already_staged');
    END IF;
    IF previous_observation IS NOT NULL AND observation_time < previous_observation THEN
        RAISE EXCEPTION 'Pilot observation predates the last staged observation' USING ERRCODE='22023';
    END IF;
    SELECT checkpoint->>'raw_sha256', checkpoint->>'reform_index_raw_sha256'
    INTO prior_hash,prior_index_hash FROM public.legal_sync_runs
    WHERE source_id=pilot_source AND status='succeeded'
    ORDER BY started_at DESC,finished_at DESC,run_id DESC LIMIT 1;

    INSERT INTO public.legal_documents(
        source_id,official_identifier,title,instrument_type,country_code,jurisdiction_level,canonical_url
    ) VALUES (pilot_source,'CCom','Código de Comercio','law','MX','federal',document_url)
    ON CONFLICT (source_id,official_identifier) DO NOTHING;
    SELECT document_id INTO STRICT stored_document FROM public.legal_documents
    WHERE source_id=pilot_source AND official_identifier='CCom' AND canonical_url=document_url;

    SELECT version_id,normalized_text_sha256,original_storage_path
    INTO stored_version,stored_text_hash,existing_object_path
    FROM public.legal_document_versions WHERE document_id=stored_document AND raw_sha256=raw_hash;
    IF NOT FOUND THEN
        INSERT INTO public.legal_document_versions(
            document_id,source_id,raw_sha256,normalized_text_sha256,original_storage_path,
            original_source_url,raw_bytes,fetched_at,extractor_version,extraction_method,applicability_notes
        ) VALUES (
            stored_document,pilot_source,raw_hash,normalized_hash,p_original_storage_path,document_url,
            (p_bundle->>'raw_bytes')::bigint,body_capture_time,p_bundle->>'extractor_version','pdf_text',
            'Candidato. Reforma observada ' || (p_bundle->>'observed_last_reform_on') ||
            '. Actualización de cantidades observada ' || coalesce(p_bundle->>'observed_amount_update_on','sin dato') || '.'
        ) RETURNING version_id INTO stored_version;
        INSERT INTO public.legal_chunks(version_id,chunk_index,content,content_sha256,locator,locator_verified)
        SELECT stored_version,(c.item->>'chunk_index')::integer,c.item->>'content',
               c.item->>'content_sha256',c.item->>'locator',false
        FROM jsonb_array_elements(p_bundle->'chunks') AS c(item);
        UPDATE public.legal_document_versions SET index_status='ready' WHERE version_id=stored_version;
        new_version := true;
    ELSE
        IF stored_text_hash IS DISTINCT FROM normalized_hash OR existing_object_path IS DISTINCT FROM p_original_storage_path
           OR (SELECT count(*) FROM public.legal_chunks WHERE version_id=stored_version) <> chunk_count
           OR EXISTS (
               SELECT 1 FROM jsonb_array_elements(p_bundle->'chunks') AS incoming(item)
               LEFT JOIN public.legal_chunks AS stored ON stored.version_id=stored_version
                   AND stored.chunk_index=(incoming.item->>'chunk_index')::integer
               WHERE stored.content_sha256 IS DISTINCT FROM incoming.item->>'content_sha256'
           ) THEN
            RAISE EXCEPTION 'Existing immutable version differs from the supplied extraction' USING ERRCODE='22023';
        END IF;
    END IF;

    -- A detected change pauses the approved source until a reviewer reconciles
    -- its old and new effective versions. This prevents refreshing old RAG results.
    held := source_status='approved' AND
        (prior_hash IS DISTINCT FROM raw_hash OR prior_index_hash IS DISTINCT FROM (p_bundle->>'reform_index_raw_sha256'));
    UPDATE public.legal_sources SET
        last_attempt_at=observation_time,last_successful_ingestion_at=observation_time,updated_at=now(),
        governance_status=CASE WHEN held THEN 'pending' ELSE governance_status END,
        ingestion_enabled=CASE WHEN held THEN false ELSE ingestion_enabled END
    WHERE source_id=pilot_source;

    INSERT INTO public.legal_sync_runs(
        source_id,idempotency_key,status,started_at,finished_at,
        discovered_documents,changed_documents,rejected_documents,checkpoint
    ) VALUES (
        pilot_source,run_key,'succeeded',observation_time,greatest(observation_time,now()),1,
        CASE WHEN new_version THEN 1 ELSE 0 END,0,
        jsonb_build_object('raw_sha256',raw_hash,'normalized_text_sha256',normalized_hash,
            'reform_index_raw_sha256',p_bundle->>'reform_index_raw_sha256',
            'document_id',stored_document,'version_id',stored_version,'pages',pages,
            'chunks',chunk_count,'source_review_hold',held,'review_status','pending_on_new_version',
            'observed_last_reform_on',p_bundle->>'observed_last_reform_on',
            'observed_amount_update_on',p_bundle->>'observed_amount_update_on')
    ) RETURNING run_id INTO stored_run;
    RETURN jsonb_build_object('run_id',stored_run,'document_id',stored_document,
        'version_id',stored_version,'status',CASE WHEN new_version THEN 'candidate_staged' ELSE 'same_version_observed' END,
        'source_review_hold',held);
END;
$$;

REVOKE ALL ON FUNCTION public.legal_stage_pilot_ccom(jsonb,text) FROM PUBLIC;
DO $pilot_permissions$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
        REVOKE ALL ON FUNCTION public.legal_stage_pilot_ccom(jsonb,text) FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
        REVOKE ALL ON FUNCTION public.legal_stage_pilot_ccom(jsonb,text) FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
        GRANT EXECUTE ON FUNCTION public.legal_stage_pilot_ccom(jsonb,text) TO service_role;
    END IF;
END;
$pilot_permissions$;

COMMENT ON FUNCTION public.legal_stage_pilot_ccom(jsonb,text) IS
    'Stages only the bounded Cámara CCom candidate. No legal approval; change holds previous retrieval.';
COMMIT;
