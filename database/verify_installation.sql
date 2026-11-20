-- Prueba transaccional: TODO dato fixture se revierte. No incorpora normas reales.
BEGIN;
DO $test$
DECLARE doc uuid; ver uuid; n integer; rejected boolean; fixture text := 'contracterpruebaunica plazo de pago';
BEGIN
    INSERT INTO public.legal_sources(source_id,title,authority,source_url,official_host,official_role,scope_levels)
    VALUES('contracter_fixture_test','TEST ONLY','TEST ONLY','https://example.invalid/test','example.invalid','official_compilation',ARRAY['state']);
    INSERT INTO public.legal_documents(source_id,official_identifier,title,instrument_type,jurisdiction_level,entity_code,canonical_url)
    VALUES('contracter_fixture_test','TEST ONLY','TEST ONLY','law','state','09','https://example.invalid/test') RETURNING document_id INTO doc;
    INSERT INTO public.legal_document_versions(document_id,source_id,raw_sha256,original_storage_path,original_source_url,extractor_version,extraction_method,index_status)
    VALUES(doc,'contracter_fixture_test',repeat('a',64),'TEST ONLY - transaction rollback','https://example.invalid/test','test-only','official_text','ready') RETURNING version_id INTO ver;
    INSERT INTO public.legal_chunks(version_id,chunk_index,content,content_sha256,locator,locator_verified)
    VALUES(ver,0,fixture,encode(sha256(convert_to(fixture,'UTF8')),'hex'),'TEST ONLY',true);
    SELECT count(*) INTO n FROM public.legal_search_fts('contracterpruebaunica','MX','09',NULL,DATE '2026-11-04',8,false);
    IF n<>0 THEN RAISE EXCEPTION 'Unreviewed fixture escaped review filter'; END IF;
    SELECT count(*) INTO n FROM public.legal_search_fts('contracterpruebaunica','MX','09',NULL,DATE '2026-11-04',8,true);
    IF n<>1 THEN RAISE EXCEPTION 'Diagnostic retrieval failed'; END IF;
    SELECT count(*) INTO n FROM public.legal_search_fts('contracterpruebaunica','MX',NULL,NULL,DATE '2026-11-04',8,true);
    IF n<>0 THEN RAISE EXCEPTION 'State document escaped territorial filter'; END IF;
    rejected:=false;
    BEGIN
      UPDATE public.legal_document_versions SET raw_sha256=repeat('b',64) WHERE version_id=ver;
    EXCEPTION WHEN check_violation THEN rejected:=true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'Immutable version accepted a changed hash'; END IF;
    rejected:=false;
    BEGIN
      INSERT INTO public.legal_chunks(version_id,chunk_index,content,content_sha256)
      VALUES(ver,1,'TEST ONLY',repeat('c',64));
    EXCEPTION WHEN check_violation THEN rejected:=true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'Invalid content hash accepted'; END IF;
    UPDATE public.legal_sources SET governance_status='approved',approved_by='TEST ONLY',approved_at=now(),last_successful_ingestion_at=now()
    WHERE source_id='contracter_fixture_test';
    UPDATE public.legal_document_versions SET review_status='approved',reviewed_by='TEST ONLY',reviewed_at=now(),
      effectivity_status='in_force',effective_from=DATE '2026-01-01',review_evidence='[{"fixture":true}]'::jsonb WHERE version_id=ver;
    SELECT count(*) INTO n FROM public.legal_search_fts('contracterpruebaunica','MX','09',NULL,DATE '2026-11-04',8,false);
    IF n<>1 THEN RAISE EXCEPTION 'Reviewed fresh fixture was not retrieved'; END IF;
    UPDATE public.legal_sources SET last_successful_ingestion_at=now()-interval '72 hours' WHERE source_id='contracter_fixture_test';
    SELECT count(*) INTO n FROM public.legal_search_fts('contracterpruebaunica','MX','09',NULL,DATE '2026-11-04',8,false);
    IF n<>0 THEN RAISE EXCEPTION 'Stale source accepted'; END IF;
    UPDATE public.legal_sources SET governance_status='suspended' WHERE source_id='contracter_fixture_test';
    SELECT count(*) INTO n FROM public.legal_search_fts('contracterpruebaunica','MX','09',NULL,DATE '2026-11-04',8,true);
    IF n<>0 THEN RAISE EXCEPTION 'Suspended source accepted'; END IF;
END;
$test$;
ROLLBACK;
SELECT jsonb_build_object('transactional_tests','passed','fixture_rows_remaining',
  (SELECT count(*) FROM public.legal_sources WHERE source_id='contracter_fixture_test'),
  'actual_legal_documents',(SELECT count(*) FROM public.legal_documents)) AS verification;
