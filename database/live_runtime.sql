-- Apply after schema.sql and legal_corpus.sql. No runtime credentials or actors
-- are seeded. The Edge Function is the only intended client of these RPCs.
BEGIN;

CREATE SCHEMA IF NOT EXISTS contracter_private;
REVOKE ALL ON SCHEMA contracter_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS contracter_private.runtime_tokens (
    scope text NOT NULL CHECK (scope IN ('audit','approval','telegram','dashboard')),
    token_sha256 text NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
    active boolean NOT NULL DEFAULT true,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (scope, token_sha256),
    UNIQUE (token_sha256)
);

CREATE TABLE IF NOT EXISTS contracter_private.approval_principals (
    chat_id bigint NOT NULL CHECK (chat_id <> 0),
    telegram_user_id bigint NOT NULL CHECK (telegram_user_id > 0),
    active boolean NOT NULL DEFAULT true,
    PRIMARY KEY (chat_id, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS contracter_private.runtime_claims (
    run_id uuid PRIMARY KEY,
    synthetic boolean NOT NULL,
    owner_chat_id bigint CHECK (owner_chat_id <> 0),
    claimed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contracter_private.runtime_runs (
    run_id uuid PRIMARY KEY REFERENCES contracter_private.runtime_claims(run_id) ON DELETE RESTRICT,
    id_caso uuid UNIQUE REFERENCES public.cases(id_caso) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('AWAITING_HUMAN','HELD','QA','CONTEXT_REQUIRED')),
    synthetic boolean NOT NULL,
    owner_chat_id bigint CHECK (owner_chat_id <> 0),
    reason text CHECK (reason ~ '^[A-Z0-9_]{1,120}$'),
    request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((id_caso IS NOT NULL) = (status = 'AWAITING_HUMAN'))
);

CREATE TABLE IF NOT EXISTS contracter_private.runtime_events (
    event_id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES contracter_private.runtime_runs(run_id) ON DELETE RESTRICT,
    agent_log jsonb NOT NULL CHECK (jsonb_typeof(agent_log) = 'object'),
    usage_event jsonb CHECK (jsonb_typeof(usage_event) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_events_run_idx ON contracter_private.runtime_events(run_id);

-- A rejected decision never receives an approval signature. This prevents a
-- rejection from being replayed as approval against the v1 attestation format.
ALTER TABLE public.human_approvals ALTER COLUMN attestation_signature DROP NOT NULL;
DO $rejection$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.human_approvals'::regclass
        AND conname = 'human_approval_signed_decision') THEN
        ALTER TABLE public.human_approvals ADD CONSTRAINT human_approval_signed_decision
            CHECK ((status = 'APPROVED') = (attestation_signature IS NOT NULL)) NOT VALID;
    END IF;
END
$rejection$;

CREATE TABLE IF NOT EXISTS contracter_private.approval_challenges (
    nonce_sha256 text PRIMARY KEY CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
    id_caso uuid NOT NULL REFERENCES public.cases(id_caso) ON DELETE RESTRICT,
    v2_sha256 text NOT NULL CHECK (v2_sha256 ~ '^[0-9a-f]{64}$'),
    chat_id bigint NOT NULL,
    actor_id bigint NOT NULL,
    expires_at timestamptz NOT NULL,
    superseded boolean NOT NULL DEFAULT false,
    callback_id text UNIQUE,
    decision text CHECK (decision IN ('APPROVED','REJECTED')),
    FOREIGN KEY (chat_id, actor_id) REFERENCES contracter_private.approval_principals(chat_id, telegram_user_id),
    CHECK ((callback_id IS NULL) = (decision IS NULL))
);

CREATE INDEX IF NOT EXISTS approval_challenges_case_idx ON contracter_private.approval_challenges(id_caso);

ALTER TABLE contracter_private.runtime_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracter_private.approval_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracter_private.runtime_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracter_private.runtime_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracter_private.runtime_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracter_private.approval_challenges ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.contracter_runtime_authorize(p_scope text, p_token_sha256 text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM contracter_private.runtime_tokens
        WHERE scope = p_scope AND token_sha256 = p_token_sha256 AND active AND expires_at > now());
$$;

CREATE OR REPLACE FUNCTION public.contracter_claim_run(p_run_id uuid, p_synthetic boolean, p_owner_chat_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    v_claim contracter_private.runtime_claims%ROWTYPE;
    v_status text;
BEGIN
    IF p_run_id IS NULL OR p_synthetic IS NULL OR p_owner_chat_id = 0 THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_CLAIM';
    END IF;
    INSERT INTO contracter_private.runtime_claims(run_id,synthetic,owner_chat_id)
    VALUES(p_run_id,p_synthetic,p_owner_chat_id) ON CONFLICT (run_id) DO NOTHING;
    IF FOUND THEN RETURN jsonb_build_object('run_id',p_run_id,'accepted',true,'status','CLAIMED'); END IF;
    SELECT * INTO v_claim FROM contracter_private.runtime_claims WHERE run_id=p_run_id;
    IF v_claim.synthetic IS DISTINCT FROM p_synthetic OR v_claim.owner_chat_id IS DISTINCT FROM p_owner_chat_id THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'CLAIM_PAYLOAD_CONFLICT';
    END IF;
    SELECT COALESCE(c.status,r.status) INTO v_status FROM contracter_private.runtime_runs r
        LEFT JOIN public.cases c ON c.id_caso=r.id_caso WHERE r.run_id=p_run_id;
    -- Never start a second billable execution for the same request. STALE is
    -- diagnostic only because the previous run may have already used tokens.
    RETURN jsonb_build_object('run_id',p_run_id,'accepted',false,'status',COALESCE(v_status,
        CASE WHEN v_claim.claimed_at <= now()-interval '30 minutes' THEN 'STALE' ELSE 'CLAIMED' END));
END;
$$;

CREATE OR REPLACE FUNCTION public.contracter_persist_run(p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    v_case jsonb := p_request->'case';
    v_run uuid := (p_request->>'run_id')::uuid;
    v_status text := p_request->>'status';
    v_synthetic boolean := (p_request->>'synthetic')::boolean;
    v_owner bigint := (p_request->>'owner_chat_id')::bigint;
    v_reason text := p_request->>'reason';
    v_mode text;
    v_id uuid;
    v_v1 text;
    v_v2 text;
    v_request_sha text := encode(sha256(convert_to(p_request::text,'UTF8')),'hex');
    v_saved contracter_private.runtime_runs%ROWTYPE;
    v_log jsonb;
    v_usage jsonb;
    v_usage_events jsonb := p_request->'usage_events';
    v_event_id uuid;
    v_created timestamptz;
    v_agent text;
    v_auditors constant text[] := ARRAY['Harvey','Lupin','Morty','Murdock'];
    v_agents constant text[] := ARRAY['Fury','Afton','House','Jane','Sherlock','Morty','Harvey',
        'Murdock','Lupin','Hamilton','Jarvis','Watson','Glenn'];
BEGIN
    IF v_run IS NULL OR v_status IS NULL OR v_status NOT IN ('AWAITING_HUMAN','HELD','QA','CONTEXT_REQUIRED')
       OR jsonb_typeof(p_request->'synthetic') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(p_request->'agent_logs') IS DISTINCT FROM 'array'
       OR jsonb_typeof(v_usage_events) IS DISTINCT FROM 'array'
       OR (v_reason IS NOT NULL AND v_reason !~ '^[A-Z0-9_]{1,120}$')
       OR jsonb_array_length(p_request->'agent_logs') > 250 OR jsonb_array_length(v_usage_events) > 250 THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_RUN';
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended(v_run::text,0)) THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'RUN_BUSY';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM contracter_private.runtime_claims WHERE run_id=v_run
                   AND synthetic=v_synthetic AND owner_chat_id IS NOT DISTINCT FROM v_owner) THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'RUN_NOT_CLAIMED';
    END IF;
    SELECT * INTO v_saved FROM contracter_private.runtime_runs WHERE run_id = v_run;
    IF FOUND THEN
        IF v_saved.request_sha256 IS DISTINCT FROM v_request_sha THEN
            RAISE SQLSTATE 'PT409' USING MESSAGE = 'RUN_PAYLOAD_CONFLICT';
        END IF;
        RETURN jsonb_build_object('run_id',v_run,'case_id',v_saved.id_caso,'status',
            COALESCE((SELECT c.status FROM public.cases c WHERE c.id_caso=v_saved.id_caso),v_saved.status),
            'v2_sha256', (SELECT v.sha256 FROM public.contract_versions v WHERE v.id_caso=v_saved.id_caso AND v.version='V2'),
            'replayed',true);
    END IF;
    IF v_status = 'AWAITING_HUMAN' THEN
        v_id := (v_case->>'case_id')::uuid;
        v_mode := v_case->>'mode';
        v_created := (v_case->>'created_at')::timestamptz;
        v_v1 := v_case#>>'{versions,v1,sha256}';
        v_v2 := v_case#>>'{versions,v2,sha256}';
        IF v_id IS NULL OR v_created IS NULL OR v_mode IS NULL OR v_mode NOT IN ('live','mock')
           OR (v_mode = 'mock' AND NOT v_synthetic) OR v_case->>'schema_version' IS DISTINCT FROM '1.0.0'
           OR v_case#>>'{versions,v1,text}' IS NULL OR v_case#>>'{versions,v2,text}' IS NULL
           OR v_v1 IS DISTINCT FROM encode(sha256(convert_to(v_case#>>'{versions,v1,text}','UTF8')),'hex')
           OR v_v2 IS DISTINCT FROM encode(sha256(convert_to(v_case#>>'{versions,v2,text}','UTF8')),'hex')
           OR v_v1 = v_v2 OR v_case#>>'{security,sanitized_text}' IS DISTINCT FROM v_case#>>'{versions,v1,text}'
           OR v_case#>>'{security,status}' IS DISTINCT FROM 'CLEAN'
           OR v_case#>>'{fury,status}' IS DISTINCT FROM 'CONSENSUS'
           OR jsonb_typeof(v_case#>'{fury,auditors_required}') IS DISTINCT FROM 'array'
           OR v_case#>>'{fury,reviewed_sha256}' IS DISTINCT FROM v_v2
           OR v_case#>'{fury,released}' IS DISTINCT FROM 'false'::jsonb
           OR v_case#>'{context,confirmed}' IS DISTINCT FROM 'true'::jsonb
           OR v_case#>>'{house,status}' IS DISTINCT FROM 'CLEAN'
           OR v_case#>'{house,contract_access}' IS DISTINCT FROM 'false'::jsonb
           OR v_case#>>'{human_approval,status}' IS DISTINCT FROM 'PENDING'
           OR v_case#>'{human_approval,required}' IS DISTINCT FROM 'true'::jsonb
           OR v_case#>>'{human_approval,approver}' IS NOT NULL
           OR v_case#>>'{human_approval,approved_at}' IS NOT NULL
           OR v_case#>>'{human_approval,approved_sha256}' IS NOT NULL
           OR v_case#>>'{human_approval,evidence_reference}' IS NOT NULL
           OR v_case#>>'{human_approval,attestation,algorithm}' IS DISTINCT FROM 'HMAC-SHA256'
           OR v_case#>>'{human_approval,attestation,signature}' IS NOT NULL
           OR v_case#>>'{costs,currency}' IS DISTINCT FROM 'USD'
           OR v_case#>>'{costs,pricing_status}' IS DISTINCT FROM (CASE WHEN v_mode='mock' THEN 'mock' ELSE 'verified' END)
           OR v_case#>'{costs,events}' IS DISTINCT FROM v_usage_events
           OR jsonb_array_length(v_usage_events) = 0
           OR jsonb_typeof(v_case#>'{costs,total_usd}') IS DISTINCT FROM 'number'
           OR jsonb_typeof(v_case->'changelog') IS DISTINCT FROM 'array'
           OR jsonb_array_length(v_case->'changelog') = 0
           OR jsonb_typeof(v_case->'audits') IS DISTINCT FROM 'array'
           OR jsonb_array_length(v_case->'audits') <> 4 THEN
            RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_PENDING_CASE';
        END IF;
        IF (SELECT array_agg(a->>'agent' ORDER BY (a->>'agent') COLLATE "C")
            FROM jsonb_array_elements(v_case->'audits') a) IS DISTINCT FROM v_auditors
           OR (SELECT array_agg(a ORDER BY a COLLATE "C")
               FROM jsonb_array_elements_text(v_case#>'{fury,auditors_required}') a) IS DISTINCT FROM v_auditors
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_case->'audits') a
               WHERE a->>'status' IS DISTINCT FROM 'ENTENDIDO' OR a->>'reviewed_version' IS DISTINCT FROM 'V2'
               OR a->>'reviewed_sha256' IS DISTINCT FROM v_v2 OR jsonb_typeof(a->'findings') IS DISTINCT FROM 'array')
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_case->'audits') a,
               LATERAL jsonb_array_elements(a->'findings') f WHERE f->'resolved' IS DISTINCT FROM 'true'::jsonb)
           OR (SELECT array_agg(h->>'agent' ORDER BY (h->>'agent') COLLATE "C")
                FROM jsonb_array_elements(v_case#>'{house,checks}') h) IS DISTINCT FROM v_auditors
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_case#>'{house,checks}') h
                WHERE h->'output_schema_valid' IS DISTINCT FROM 'true'::jsonb
                OR h->'anomaly_detected' IS DISTINCT FROM 'false'::jsonb
                OR h->'quarantine_required' IS DISTINCT FROM 'false'::jsonb) THEN
            RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_CONSENSUS';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_usage_events) e
                   WHERE jsonb_typeof(e->'cost_usd') IS DISTINCT FROM 'number')
           OR abs((SELECT sum((e->>'cost_usd')::numeric) FROM jsonb_array_elements(v_usage_events) e)
                  -(v_case#>>'{costs,total_usd}')::numeric) > 0.000000001 THEN
            RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_COST_TOTAL';
        END IF;
        IF NOT v_synthetic AND (v_case#>>'{jurisdiction,legal_basis_status}' IS DISTINCT FROM 'verified'
           OR jsonb_typeof(v_case#>'{jurisdiction,sources}') IS DISTINCT FROM 'array'
           OR jsonb_array_length(v_case#>'{jurisdiction,sources}') = 0) THEN
            RAISE SQLSTATE 'PT400' USING MESSAGE = 'LEGAL_EVIDENCE_REQUIRED';
        END IF;
        INSERT INTO public.cases(id_caso,titulo,mode,status,case_json,created_at)
        VALUES(v_id,v_case->>'title',v_mode,'AWAITING_HUMAN',v_case,v_created)
        ON CONFLICT (id_caso) DO NOTHING;
        IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'CASE_ALREADY_EXISTS'; END IF;
        INSERT INTO public.contract_versions(id_caso,version,texto,sha256,created_at)
        VALUES (v_id,'V1',v_case#>>'{versions,v1,text}',v_v1,v_created),
               (v_id,'V2',v_case#>>'{versions,v2,text}',v_v2,v_created);
    ELSIF v_case IS DISTINCT FROM 'null'::jsonb AND v_case IS NOT NULL THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'NON_CANDIDATE_HAS_CASE';
    END IF;
    INSERT INTO contracter_private.runtime_runs(run_id,id_caso,status,synthetic,owner_chat_id,request_sha256,reason)
    VALUES(v_run,v_id,v_status,v_synthetic,v_owner,v_request_sha,v_reason);
    FOR v_log IN SELECT value FROM jsonb_array_elements(p_request->'agent_logs') LOOP
        v_event_id := (v_log->>'event_id')::uuid;
        v_agent := v_log->>'agent';
        IF v_event_id IS NULL OR v_agent IS NULL OR NOT v_agent=ANY(v_agents)
           OR length(btrim(COALESCE(v_log->>'stage',''))) = 0 OR length(btrim(COALESCE(v_log->>'status',''))) = 0
           OR COALESCE((v_log->>'round')::integer,0) NOT BETWEEN 1 AND 50
           OR jsonb_typeof(v_log->'output') IS DISTINCT FROM 'object'
           OR jsonb_typeof(v_log->'quarantined') IS DISTINCT FROM 'boolean' THEN
            RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_AGENT_EVENT';
        END IF;
        v_usage := (SELECT value FROM jsonb_array_elements(v_usage_events)
                    WHERE (value->>'event_id')::uuid=v_event_id);
        IF v_usage IS NOT NULL AND (v_usage->>'agent') IS DISTINCT FROM v_agent THEN
            RAISE SQLSTATE 'PT400' USING MESSAGE = 'USAGE_AGENT_MISMATCH';
        END IF;
        INSERT INTO contracter_private.runtime_events(event_id,run_id,agent_log,usage_event)
        VALUES(v_event_id,v_run,v_log,v_usage);
        IF v_id IS NOT NULL THEN
            INSERT INTO public.agent_logs(event_id,id_caso,agente,mode,etapa,ronda,estado,output_json,quarantined)
            VALUES(v_event_id,v_id,v_agent,v_mode,v_log->>'stage',(v_log->>'round')::integer,
                   v_log->>'status',v_log->'output',(v_log->>'quarantined')::boolean);
            IF v_usage IS NOT NULL THEN
                INSERT INTO public.cost_logs(event_id,id_caso,agente,tokens_input,tokens_output,modelo,latencia_ms,
                    pricing_status,input_rate_per_million,output_rate_per_million,pricing_source,costo_usd)
                VALUES(v_event_id,v_id,v_agent,(v_usage->>'tokens_input')::bigint,(v_usage->>'tokens_output')::bigint,
                    v_usage->>'model',(v_usage->>'latency_ms')::bigint,
                    CASE WHEN v_mode='mock' THEN 'mock' WHEN v_usage->>'cost_usd' IS NULL THEN 'unverified' ELSE 'verified' END,
                    (v_usage->>'input_rate_per_million')::numeric,(v_usage->>'output_rate_per_million')::numeric,
                    v_usage->>'pricing_source',(v_usage->>'cost_usd')::numeric);
            END IF;
        END IF;
    END LOOP;
    IF (SELECT count(*) FROM contracter_private.runtime_events WHERE run_id=v_run AND usage_event IS NOT NULL)
       <> jsonb_array_length(v_usage_events) THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'UNMATCHED_USAGE_EVENT';
    END IF;
    RETURN jsonb_build_object('run_id',v_run,'case_id',v_id,'status',v_status,'v2_sha256',v_v2,'replayed',false);
EXCEPTION WHEN unique_violation OR cardinality_violation THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'EVENT_ID_CONFLICT';
END;
$$;

CREATE OR REPLACE FUNCTION public.contracter_issue_approval(p_case_id uuid, p_chat_id bigint, p_actor_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    v_case public.cases%ROWTYPE;
    v_run contracter_private.runtime_runs%ROWTYPE;
    v_hash text;
    v_nonce text := replace(gen_random_uuid()::text,'-','');
    v_expiry timestamptz := now() + interval '15 minutes';
BEGIN
    SELECT * INTO v_case FROM public.cases WHERE id_caso=p_case_id FOR UPDATE;
    SELECT * INTO v_run FROM contracter_private.runtime_runs WHERE id_caso=p_case_id;
    IF v_run.run_id IS NULL OR v_case.id_caso IS NULL THEN
        RAISE SQLSTATE 'PT404' USING MESSAGE = 'CASE_NOT_FOUND';
    END IF;
    IF v_run.synthetic OR v_case.mode <> 'live' OR
       (v_run.owner_chat_id IS NOT NULL AND v_run.owner_chat_id IS DISTINCT FROM p_chat_id)
       OR NOT EXISTS (SELECT 1 FROM contracter_private.approval_principals
           WHERE chat_id=p_chat_id AND telegram_user_id=p_actor_id AND active) THEN
        RAISE SQLSTATE 'PT403' USING MESSAGE = 'APPROVAL_NOT_AUTHORIZED';
    END IF;
    IF v_case.status <> 'AWAITING_HUMAN' THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'APPROVAL_ALREADY_SETTLED';
    END IF;
    SELECT sha256 INTO v_hash FROM public.contract_versions WHERE id_caso=p_case_id AND version='V2';
    IF v_hash IS NULL OR v_hash IS DISTINCT FROM v_case.case_json#>>'{versions,v2,sha256}' THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'V2_MISMATCH';
    END IF;
    UPDATE contracter_private.approval_challenges SET superseded=true
    WHERE id_caso=p_case_id AND callback_id IS NULL AND NOT superseded;
    INSERT INTO contracter_private.approval_challenges(nonce_sha256,id_caso,v2_sha256,chat_id,actor_id,expires_at)
    VALUES(encode(sha256(convert_to(v_nonce,'UTF8')),'hex'),p_case_id,v_hash,p_chat_id,p_actor_id,v_expiry);
    RETURN jsonb_build_object('case_id',p_case_id,'status','AWAITING_HUMAN','v2_sha256',v_hash,
        'expires_at',v_expiry,'approve_data','ca:a:'||v_nonce,'reject_data','ca:r:'||v_nonce);
END;
$$;

CREATE OR REPLACE FUNCTION public.contracter_lookup_approval(p_nonce_sha256 text, p_chat_id bigint,
    p_actor_id bigint, p_callback_id text, p_decision text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_row contracter_private.approval_challenges%ROWTYPE;
BEGIN
    SELECT * INTO v_row FROM contracter_private.approval_challenges WHERE nonce_sha256=p_nonce_sha256;
    IF v_row.nonce_sha256 IS NULL OR v_row.chat_id IS DISTINCT FROM p_chat_id
       OR v_row.actor_id IS DISTINCT FROM p_actor_id
       OR NOT EXISTS (SELECT 1 FROM contracter_private.approval_principals
           WHERE chat_id=p_chat_id AND telegram_user_id=p_actor_id AND active) THEN
        RAISE SQLSTATE 'PT403' USING MESSAGE = 'APPROVAL_NOT_AUTHORIZED';
    END IF;
    IF v_row.callback_id = p_callback_id AND v_row.decision = p_decision THEN
        RETURN jsonb_build_object('case_id',v_row.id_caso,'status',v_row.decision,
            'v2_sha256',v_row.v2_sha256,'replayed',true);
    END IF;
    IF v_row.callback_id IS NOT NULL OR v_row.superseded THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'APPROVAL_ALREADY_SETTLED';
    END IF;
    IF v_row.expires_at <= now() THEN
        RAISE SQLSTATE 'PT410' USING MESSAGE = 'APPROVAL_EXPIRED';
    END IF;
    RETURN jsonb_build_object('case_id',v_row.id_caso,'status','PENDING','v2_sha256',v_row.v2_sha256,'replayed',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.contracter_redeem_approval(p_nonce_sha256 text, p_chat_id bigint,
    p_actor_id bigint, p_callback_id text, p_decision text, p_signed_at text, p_signature text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    v_lookup jsonb;
    v_id uuid;
    v_hash text;
    v_case public.cases%ROWTYPE;
    v_signed_at timestamptz := p_signed_at::timestamptz;
    v_approver text := 'telegram:'||p_actor_id::text;
    v_evidence text := 'telegram-callback:'||p_callback_id;
    v_approval jsonb;
BEGIN
    IF p_decision IS NULL OR p_decision NOT IN ('APPROVED','REJECTED')
       OR p_callback_id IS NULL OR p_callback_id !~ '^[0-9A-Za-z_-]{1,128}$'
       OR v_signed_at IS NULL OR v_signed_at < now() - interval '2 minutes' OR v_signed_at > now() + interval '30 seconds'
       OR (p_decision='APPROVED' AND (p_signature IS NULL OR p_signature !~ '^[0-9a-f]{64}$'))
       OR (p_decision='REJECTED' AND p_signature IS NOT NULL) THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_DECISION';
    END IF;
    v_lookup := public.contracter_lookup_approval(p_nonce_sha256,p_chat_id,p_actor_id,p_callback_id,p_decision);
    v_id := (v_lookup->>'case_id')::uuid;
    SELECT * INTO v_case FROM public.cases WHERE id_caso=v_id FOR UPDATE;
    -- Serialize by case, then re-read challenge and authorizations under lock.
    v_lookup := public.contracter_lookup_approval(p_nonce_sha256,p_chat_id,p_actor_id,p_callback_id,p_decision);
    IF (v_lookup->>'replayed')::boolean THEN RETURN v_lookup; END IF;
    v_hash := v_lookup->>'v2_sha256';
    IF v_case.status IS DISTINCT FROM 'AWAITING_HUMAN' OR v_case.mode IS DISTINCT FROM 'live'
       OR NOT EXISTS (SELECT 1 FROM contracter_private.runtime_runs
           WHERE id_caso=v_id AND NOT synthetic AND (owner_chat_id IS NULL OR owner_chat_id=p_chat_id))
       OR v_hash IS DISTINCT FROM v_case.case_json#>>'{versions,v2,sha256}'
       OR v_hash IS DISTINCT FROM encode(sha256(convert_to(v_case.case_json#>>'{versions,v2,text}','UTF8')),'hex')
       OR NOT EXISTS (SELECT 1 FROM public.contract_versions v WHERE id_caso=v_id AND version='V2'
          AND v.sha256=v_hash AND v.sha256=encode(sha256(convert_to(v.texto,'UTF8')),'hex'))
       OR v_case.case_json#>>'{fury,status}' IS DISTINCT FROM 'CONSENSUS'
       OR v_case.case_json#>'{fury,released}' IS DISTINCT FROM 'false'::jsonb
       OR v_signed_at < v_case.created_at THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'V2_NOT_APPROVABLE';
    END IF;
    UPDATE contracter_private.approval_challenges SET callback_id=p_callback_id,decision=p_decision
    WHERE nonce_sha256=p_nonce_sha256;
    INSERT INTO public.human_approvals(approval_id,id_caso,status,approver,approved_at,approved_sha256,
        evidence_reference,attestation_signature)
    VALUES(gen_random_uuid(),v_id,p_decision,v_approver,v_signed_at,v_hash,v_evidence,p_signature);
    v_approval := jsonb_build_object('required',true,'status',p_decision,'approver',v_approver,
        'approved_at',p_signed_at,'approved_sha256',v_hash,'evidence_reference',v_evidence,
        'attestation',jsonb_build_object('algorithm','HMAC-SHA256','signature',p_signature));
    UPDATE public.cases SET status=p_decision,updated_at=now(),case_json=jsonb_set(
        jsonb_set(case_json,'{human_approval}',v_approval),'{fury,released}',to_jsonb(p_decision='APPROVED'))
    WHERE id_caso=v_id;
    RETURN jsonb_build_object('case_id',v_id,'status',p_decision,'v2_sha256',v_hash,'replayed',false);
EXCEPTION WHEN unique_violation THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'CALLBACK_ID_CONFLICT';
END;
$$;

CREATE OR REPLACE FUNCTION public.contracter_get_case(p_case_id uuid, p_owner_chat_id bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_result jsonb;
BEGIN
    SELECT jsonb_build_object('case',c.case_json,'status',c.status,'synthetic',r.synthetic)
      INTO v_result FROM public.cases c
    JOIN contracter_private.runtime_runs r USING(id_caso)
    WHERE c.id_caso=p_case_id AND (p_owner_chat_id IS NULL OR r.owner_chat_id=p_owner_chat_id);
    IF v_result IS NULL THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'CASE_NOT_FOUND'; END IF;
    RETURN v_result;
END;
$$;

-- PostgreSQL grants EXECUTE to PUBLIC by default. Revoke explicitly and permit
-- service_role only, both for fresh projects and projects with auto-grants.
DO $runtime_permissions$
DECLARE
    v_function text;
    v_role text;
    v_functions constant text[] := ARRAY[
        'public.contracter_runtime_authorize(text,text)',
        'public.contracter_claim_run(uuid,boolean,bigint)',
        'public.contracter_persist_run(jsonb)',
        'public.contracter_issue_approval(uuid,bigint,bigint)',
        'public.contracter_lookup_approval(text,bigint,bigint,text,text)',
        'public.contracter_redeem_approval(text,bigint,bigint,text,text,text,text)',
        'public.contracter_get_case(uuid,bigint)'];
BEGIN
    REVOKE ALL ON ALL TABLES IN SCHEMA contracter_private FROM PUBLIC;
    FOREACH v_function IN ARRAY v_functions LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',v_function);
        FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
            IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_role) THEN
                EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',v_function,v_role);
            END IF;
        END LOOP;
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='service_role') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',v_function);
        END IF;
    END LOOP;
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_role) THEN
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA contracter_private FROM %I',v_role);
            EXECUTE format('REVOKE ALL ON SCHEMA contracter_private FROM %I',v_role);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='service_role') THEN
        GRANT USAGE ON SCHEMA contracter_private TO service_role;
        GRANT SELECT ON contracter_private.runtime_tokens,contracter_private.approval_principals TO service_role;
        GRANT SELECT,INSERT ON contracter_private.runtime_claims,contracter_private.runtime_runs,
            contracter_private.runtime_events TO service_role;
        GRANT SELECT,INSERT,UPDATE ON contracter_private.approval_challenges TO service_role;
        GRANT SELECT,INSERT,UPDATE ON public.cases TO service_role;
        GRANT SELECT,INSERT ON public.contract_versions,public.agent_logs,public.cost_logs,public.human_approvals TO service_role;
    END IF;
END
$runtime_permissions$;

NOTIFY pgrst, 'reload schema';
COMMIT;
