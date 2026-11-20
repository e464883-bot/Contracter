-- Run after schema.sql, seed_mock.sql and live_runtime.sql. All fixtures,
-- including the fake decisions, are temporary and rolled back.
BEGIN;
SET LOCAL statement_timeout = '20s';
DO $runtime_test$
DECLARE
    v_case jsonb;
    v_events jsonb;
    v_logs jsonb;
    v_request jsonb;
    v_result jsonb;
    v_case_id uuid := gen_random_uuid();
    v_run_id uuid := gen_random_uuid();
    v_hold_id uuid := gen_random_uuid();
    v_live_id uuid := gen_random_uuid();
    v_live_run uuid := gen_random_uuid();
    v_chat bigint := -9223372036854771000;
    v_actor bigint := 9223372036854771000;
    v_token_digest text := encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
    v_nonce text;
    v_signed_at text;
    v_callback text := 'fixture_'||replace(gen_random_uuid()::text,'-','');
    v_blocked boolean;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') AND
        has_function_privilege('anon','public.contracter_persist_run(jsonb)','EXECUTE') THEN
        RAISE EXCEPTION 'anon must not execute persistence';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') AND
        has_function_privilege('authenticated','public.contracter_get_case(uuid,bigint)','EXECUTE') THEN
        RAISE EXCEPTION 'authenticated must not read cases';
    END IF;
    INSERT INTO contracter_private.runtime_tokens(scope,token_sha256,expires_at)
    VALUES('audit',v_token_digest,now()+interval '1 minute');
    IF NOT public.contracter_runtime_authorize('audit',v_token_digest)
       OR public.contracter_runtime_authorize('approval',v_token_digest) THEN
        RAISE EXCEPTION 'token scope not isolated';
    END IF;
    UPDATE contracter_private.runtime_tokens SET expires_at=now()-interval '1 minute' WHERE token_sha256=v_token_digest;
    IF public.contracter_runtime_authorize('audit',v_token_digest) THEN RAISE EXCEPTION 'expired token accepted'; END IF;

    SELECT case_json INTO v_case FROM public.cases WHERE id_caso='11111111-1111-4111-8111-111111111111';
    IF v_case IS NULL THEN RAISE EXCEPTION 'seed_mock.sql must be installed before verification'; END IF;
    SELECT jsonb_agg(jsonb_set(e,'{event_id}',to_jsonb(gen_random_uuid()::text)) ORDER BY n)
    INTO v_events FROM jsonb_array_elements(v_case#>'{costs,events}') WITH ORDINALITY AS t(e,n);
    SELECT jsonb_agg(jsonb_build_object('event_id',e->>'event_id','agent',e->>'agent','stage','fixture',
        'round',1,'status','SIMULATED','output','{}'::jsonb,'quarantined',false) ORDER BY n)
    INTO v_logs FROM jsonb_array_elements(v_events) WITH ORDINALITY AS t(e,n);
    v_case := jsonb_set(jsonb_set(v_case,'{case_id}',to_jsonb(v_case_id::text)),'{costs,events}',v_events);
    v_request := jsonb_build_object('run_id',v_run_id,'status','AWAITING_HUMAN','synthetic',true,
        'owner_chat_id',v_chat,'case',v_case,'agent_logs',v_logs,'usage_events',v_events);
    v_result := public.contracter_claim_run(v_run_id,true,v_chat);
    IF NOT (v_result->>'accepted')::boolean OR (public.contracter_claim_run(v_run_id,true,v_chat)->>'accepted')::boolean THEN
        RAISE EXCEPTION 'duplicate claim accepted';
    END IF;
    BEGIN
        PERFORM public.contracter_persist_run(jsonb_set(v_request,'{agent_logs}','[]'::jsonb));
        RAISE EXCEPTION 'unmatched usage accepted';
    EXCEPTION WHEN SQLSTATE 'PT400' THEN NULL;
    END;
    IF EXISTS (SELECT 1 FROM public.cases WHERE id_caso=v_case_id) OR
       EXISTS (SELECT 1 FROM contracter_private.runtime_runs WHERE run_id=v_run_id) THEN
        RAISE EXCEPTION 'failed request did not roll back';
    END IF;
    v_result := public.contracter_persist_run(v_request);
    IF v_result->>'status' IS DISTINCT FROM 'AWAITING_HUMAN' OR (v_result->>'replayed')::boolean
       OR NOT (public.contracter_persist_run(v_request)->>'replayed')::boolean
       OR (SELECT count(*) FROM public.contract_versions WHERE id_caso=v_case_id) <> 2
       OR (SELECT count(*) FROM public.agent_logs WHERE id_caso=v_case_id) <> jsonb_array_length(v_logs)
       OR (SELECT count(*) FROM public.cost_logs WHERE id_caso=v_case_id) <> jsonb_array_length(v_events) THEN
        RAISE EXCEPTION 'case, versions, logs or costs not persisted atomically and idempotently';
    END IF;
    BEGIN
        PERFORM public.contracter_persist_run(jsonb_set(v_request,'{case,title}','"fixture modified"'::jsonb));
        RAISE EXCEPTION 'different payload for same run accepted';
    EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
    END;
    IF public.contracter_get_case(v_case_id,v_chat)#>>'{case,case_id}' IS DISTINCT FROM v_case_id::text THEN
        RAISE EXCEPTION 'owner lookup failed';
    END IF;
    BEGIN
        PERFORM public.contracter_get_case(v_case_id,v_chat+1);
        RAISE EXCEPTION 'another chat read the case';
    EXCEPTION WHEN SQLSTATE 'PT404' THEN NULL;
    END;
    INSERT INTO contracter_private.approval_principals(chat_id,telegram_user_id) VALUES(v_chat,v_actor);
    BEGIN
        PERFORM public.contracter_issue_approval(v_case_id,v_chat,v_actor);
        RAISE EXCEPTION 'synthetic case received approval challenge';
    EXCEPTION WHEN SQLSTATE 'PT403' THEN NULL;
    END;

    PERFORM public.contracter_claim_run(v_hold_id,true,v_chat);
    UPDATE contracter_private.runtime_claims SET claimed_at=now()-interval '31 minutes' WHERE run_id=v_hold_id;
    IF public.contracter_claim_run(v_hold_id,true,v_chat)->>'status' IS DISTINCT FROM 'STALE' THEN
        RAISE EXCEPTION 'stale claim must not restart';
    END IF;
    v_result := public.contracter_persist_run(jsonb_build_object('run_id',v_hold_id,'status','HELD',
        'synthetic',true,'owner_chat_id',v_chat,'case',null,'agent_logs','[]'::jsonb,'usage_events','[]'::jsonb));
    IF v_result->>'status' IS DISTINCT FROM 'HELD' OR v_result->>'case_id' IS NOT NULL THEN
        RAISE EXCEPTION 'non-candidate must not invent a case';
    END IF;

    -- Private fixture emulates a reviewed case ONLY inside the rollback. The
    -- Edge unit test verifies HMAC computation independently of SQL.
    SELECT jsonb_agg(e||jsonb_build_object('event_id',gen_random_uuid(),'model','fixture-only',
        'pricing_source','https://example.invalid/fixture') ORDER BY n)
    INTO v_events FROM jsonb_array_elements(v_events) WITH ORDINALITY AS t(e,n);
    SELECT jsonb_agg(jsonb_build_object('event_id',e->>'event_id','agent',e->>'agent','stage','fixture',
        'round',1,'status','SIMULATED','output','{}'::jsonb,'quarantined',false) ORDER BY n)
    INTO v_logs FROM jsonb_array_elements(v_events) WITH ORDINALITY AS t(e,n);
    v_case := v_case||jsonb_build_object('case_id',v_live_id,'mode','live','created_at',now()-interval '1 minute');
    v_case := jsonb_set(jsonb_set(v_case,'{costs,events}',v_events),'{costs,pricing_status}','"verified"'::jsonb);
    v_case := jsonb_set(v_case,'{jurisdiction}',jsonb_build_object('country','FIXTURE','region','FIXTURE',
        'legal_basis_status','verified','sources',jsonb_build_array(jsonb_build_object('id','fixture'))));
    PERFORM public.contracter_claim_run(v_live_run,false,v_chat);
    PERFORM public.contracter_persist_run(jsonb_build_object('run_id',v_live_run,'status','AWAITING_HUMAN',
        'synthetic',false,'owner_chat_id',v_chat,'case',v_case,'agent_logs',v_logs,'usage_events',v_events));
    v_result := public.contracter_issue_approval(v_live_id,v_chat,v_actor);
    v_nonce := encode(sha256(convert_to(substring(v_result->>'approve_data' from 6),'UTF8')),'hex');
    BEGIN
        PERFORM public.contracter_lookup_approval(v_nonce,v_chat,v_actor-1,v_callback,'APPROVED');
        RAISE EXCEPTION 'different Telegram actor accepted';
    EXCEPTION WHEN SQLSTATE 'PT403' THEN NULL;
    END;
    UPDATE contracter_private.approval_challenges SET expires_at=now()-interval '1 minute' WHERE nonce_sha256=v_nonce;
    BEGIN
        PERFORM public.contracter_lookup_approval(v_nonce,v_chat,v_actor,v_callback,'APPROVED');
        RAISE EXCEPTION 'expired callback accepted';
    EXCEPTION WHEN SQLSTATE 'PT410' THEN NULL;
    END;
    v_result := public.contracter_issue_approval(v_live_id,v_chat,v_actor);
    v_nonce := encode(sha256(convert_to(substring(v_result->>'approve_data' from 6),'UTF8')),'hex');
    v_signed_at := to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    BEGIN
        UPDATE public.cases SET case_json=jsonb_set(case_json,'{versions,v2,text}','"tampered"'::jsonb)
        WHERE id_caso=v_live_id;
        PERFORM public.contracter_redeem_approval(v_nonce,v_chat,v_actor,v_callback,'APPROVED',v_signed_at,repeat('a',64));
        RAISE EXCEPTION 'tampered V2 approved';
    EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
    END;
    v_result := public.contracter_redeem_approval(v_nonce,v_chat,v_actor,v_callback,'APPROVED',v_signed_at,repeat('a',64));
    IF v_result->>'status' IS DISTINCT FROM 'APPROVED' OR (v_result->>'replayed')::boolean
       OR NOT (public.contracter_redeem_approval(v_nonce,v_chat,v_actor,v_callback,'APPROVED',v_signed_at,repeat('a',64))->>'replayed')::boolean
       OR (SELECT count(*) FROM public.human_approvals WHERE id_caso=v_live_id AND approved_sha256=v_result->>'v2_sha256') <> 1 THEN
        RAISE EXCEPTION 'decision and one-time callback replay are inconsistent';
    END IF;
    BEGIN
        PERFORM public.contracter_redeem_approval(v_nonce,v_chat,v_actor,v_callback,'REJECTED',v_signed_at,NULL);
        RAISE EXCEPTION 'callback changed the settled decision';
    EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
    END;
END
$runtime_test$;
ROLLBACK;
SELECT 'runtime fixtures rolled back' AS result;
