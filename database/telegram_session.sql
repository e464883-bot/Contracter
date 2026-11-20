-- Apply after live_runtime.sql. A reset keeps only the revision/message tombstone.
-- Conversation state is private and is independent of persisted audit records.
BEGIN;

CREATE OR REPLACE FUNCTION contracter_private.telegram_session_text(p_value jsonb, p_maximum integer)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path = '' AS $$
    SELECT jsonb_typeof(p_value) = 'string'
       AND char_length(btrim(p_value #>> '{}')) BETWEEN 1 AND p_maximum
       AND char_length(p_value #>> '{}') <= p_maximum
       AND translate(p_value #>> '{}', E'\t\r\n', '') !~ '[[:cntrl:]]';
$$;

CREATE OR REPLACE FUNCTION contracter_private.valid_telegram_session_state(p_state jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    v_active jsonb;
    v_context jsonb;
    v_jurisdiction jsonb;
    v_pending jsonb;
    v_attachment jsonb;
    v_item jsonb;
    v_field text;
    v_uuid constant text := '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$';
BEGIN
    IF p_state IS NULL OR p_state = 'null'::jsonb THEN RETURN true; END IF;
    IF jsonb_typeof(p_state) <> 'object' OR octet_length(p_state::text) > 65536
       OR p_state - ARRAY['active','pending'] <> '{}'::jsonb
       OR NOT p_state ?& ARRAY['active','pending'] THEN RETURN false; END IF;

    v_active := p_state->'active';
    IF v_active <> 'null'::jsonb THEN
        IF jsonb_typeof(v_active) <> 'object'
           OR v_active - ARRAY['case_id','document','title','context','jurisdiction','turns',
                              'provider','clarification','last_audit_status'] <> '{}'::jsonb
           OR NOT v_active ?& ARRAY['case_id','document','title','context','jurisdiction','turns']
           OR jsonb_typeof(v_active->'case_id') <> 'string'
           OR (v_active->>'case_id') !~ v_uuid
           OR contracter_private.telegram_session_text(v_active->'document',12000) IS NOT TRUE
           OR octet_length(v_active->>'document') > 36000
           OR cardinality(string_to_array(v_active->>'document', E'\n')) > 1500
           OR contracter_private.telegram_session_text(v_active->'title',200) IS NOT TRUE
           THEN RETURN false; END IF;
        IF v_active ? 'provider' AND (jsonb_typeof(v_active->'provider') <> 'string'
           OR v_active->>'provider' NOT IN ('gemini','openai')) THEN RETURN false; END IF;
        IF v_active ? 'clarification' AND
           contracter_private.telegram_session_text(v_active->'clarification',500) IS NOT TRUE
           THEN RETURN false; END IF;
        IF v_active ? 'last_audit_status' AND (jsonb_typeof(v_active->'last_audit_status') <> 'string'
           OR v_active->>'last_audit_status' NOT IN
              ('AWAITING_HUMAN','HELD','CONTEXT_REQUIRED','NO_REWRITE_REQUIRED')) THEN RETURN false; END IF;

        v_context := v_active->'context';
        IF jsonb_typeof(v_context) <> 'object'
           OR v_context - ARRAY['our_party','counterparty','our_role','objectives','confirmed'] <> '{}'::jsonb
           THEN RETURN false; END IF;
        FOREACH v_field IN ARRAY ARRAY['our_party','counterparty','our_role'] LOOP
            IF v_context ? v_field AND
               contracter_private.telegram_session_text(v_context->v_field,200) IS NOT TRUE
               THEN RETURN false; END IF;
        END LOOP;
        IF v_context ? 'confirmed' AND jsonb_typeof(v_context->'confirmed') <> 'boolean'
           THEN RETURN false; END IF;
        IF v_context ? 'objectives' THEN
            IF jsonb_typeof(v_context->'objectives') <> 'array'
               OR jsonb_array_length(v_context->'objectives') > 10 THEN RETURN false; END IF;
            FOR v_item IN SELECT value FROM jsonb_array_elements(v_context->'objectives') LOOP
                IF contracter_private.telegram_session_text(v_item,500) IS NOT TRUE THEN RETURN false; END IF;
            END LOOP;
        END IF;

        v_jurisdiction := v_active->'jurisdiction';
        IF jsonb_typeof(v_jurisdiction) <> 'object'
           OR v_jurisdiction - ARRAY['region','entity_code','municipality_code','country','as_of'] <> '{}'::jsonb
           OR NOT v_jurisdiction ?& ARRAY['region','entity_code','municipality_code']
           OR contracter_private.telegram_session_text(v_jurisdiction->'region',120) IS NOT TRUE
           THEN RETURN false; END IF;
        IF v_jurisdiction->'entity_code' <> 'null'::jsonb AND
           (jsonb_typeof(v_jurisdiction->'entity_code') <> 'string'
            OR (v_jurisdiction->>'entity_code') !~ '^(0[1-9]|[12][0-9]|3[0-2])$') THEN RETURN false; END IF;
        IF v_jurisdiction->'municipality_code' <> 'null'::jsonb AND
           (v_jurisdiction->'entity_code' = 'null'::jsonb
            OR jsonb_typeof(v_jurisdiction->'municipality_code') <> 'string'
            OR (v_jurisdiction->>'municipality_code') !~ '^[0-9]{3}$'
            OR v_jurisdiction->>'municipality_code' = '000') THEN RETURN false; END IF;
        IF v_jurisdiction ? 'country' AND
           (jsonb_typeof(v_jurisdiction->'country') <> 'string'
            OR v_jurisdiction->>'country' NOT IN ('MX','México','Mexico')) THEN RETURN false; END IF;
        IF v_jurisdiction ? 'as_of' AND
           (jsonb_typeof(v_jurisdiction->'as_of') <> 'string'
            OR (v_jurisdiction->>'as_of') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            OR to_char((v_jurisdiction->>'as_of')::date,'YYYY-MM-DD') <> v_jurisdiction->>'as_of')
            THEN RETURN false; END IF;

        IF jsonb_typeof(v_active->'turns') <> 'array'
           OR jsonb_array_length(v_active->'turns') > 3 THEN RETURN false; END IF;
        FOR v_item IN SELECT value FROM jsonb_array_elements(v_active->'turns') LOOP
            IF jsonb_typeof(v_item) <> 'object'
               OR v_item - ARRAY['question','answer'] <> '{}'::jsonb
               OR NOT v_item ?& ARRAY['question','answer']
               OR contracter_private.telegram_session_text(v_item->'question',600) IS NOT TRUE
               OR contracter_private.telegram_session_text(v_item->'answer',1200) IS NOT TRUE
               THEN RETURN false; END IF;
        END LOOP;
    END IF;

    v_pending := p_state->'pending';
    IF v_pending <> 'null'::jsonb THEN
        IF jsonb_typeof(v_pending) <> 'object'
           OR v_pending - ARRAY['case_id','attachment'] <> '{}'::jsonb
           OR NOT v_pending ?& ARRAY['case_id','attachment']
           OR jsonb_typeof(v_pending->'case_id') <> 'string'
           OR (v_pending->>'case_id') !~ v_uuid THEN RETURN false; END IF;
        v_attachment := v_pending->'attachment';
        IF jsonb_typeof(v_attachment) <> 'object'
           OR v_attachment - ARRAY['file_id','file_size'] <> '{}'::jsonb
           OR NOT v_attachment ?& ARRAY['file_id','file_size']
           OR jsonb_typeof(v_attachment->'file_id') <> 'string'
           OR (v_attachment->>'file_id') !~ '^[0-9A-Za-z_-]+$'
           OR char_length(v_attachment->>'file_id') > 512
           OR jsonb_typeof(v_attachment->'file_size') <> 'number'
           OR (v_attachment->>'file_size') !~ '^[0-9]+$'
           OR (v_attachment->>'file_size')::integer NOT BETWEEN 1 AND 36000
           THEN RETURN false; END IF;
    END IF;
    RETURN true;
EXCEPTION WHEN OTHERS THEN
    RETURN false;
END;
$$;

CREATE TABLE IF NOT EXISTS contracter_private.telegram_sessions (
    owner_chat_id bigint PRIMARY KEY CHECK (owner_chat_id BETWEEN 1 AND 9999999999999999),
    revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
    last_message_id integer CHECK (last_message_id > 0),
    state jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (contracter_private.valid_telegram_session_state(state))
);

ALTER TABLE contracter_private.telegram_sessions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.contracter_get_telegram_session(p_owner_chat_id bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_session contracter_private.telegram_sessions%ROWTYPE;
BEGIN
    IF p_owner_chat_id IS NULL OR p_owner_chat_id NOT BETWEEN 1 AND 9999999999999999 THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SESSION';
    END IF;
    SELECT * INTO v_session FROM contracter_private.telegram_sessions WHERE owner_chat_id=p_owner_chat_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('revision',0,'last_message_id',null,'state',null); END IF;
    RETURN jsonb_build_object('revision',v_session.revision,'last_message_id',v_session.last_message_id,
        'state',v_session.state);
END;
$$;

CREATE OR REPLACE FUNCTION public.contracter_save_telegram_session(
    p_owner_chat_id bigint, p_expected_revision integer, p_message_id integer, p_state jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_session contracter_private.telegram_sessions%ROWTYPE;
BEGIN
    IF p_owner_chat_id IS NULL OR p_owner_chat_id NOT BETWEEN 1 AND 9999999999999999
       OR p_expected_revision IS NULL OR p_expected_revision NOT BETWEEN 0 AND 2147483646
       OR p_message_id IS NULL OR p_message_id < 1
       OR contracter_private.valid_telegram_session_state(p_state) IS NOT TRUE THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'INVALID_SESSION';
    END IF;
    INSERT INTO contracter_private.telegram_sessions(owner_chat_id)
    VALUES(p_owner_chat_id) ON CONFLICT(owner_chat_id) DO NOTHING;
    SELECT * INTO v_session FROM contracter_private.telegram_sessions
    WHERE owner_chat_id=p_owner_chat_id FOR UPDATE;
    -- A newer reset clears a slow answer that committed after the reset's read.
    -- Its message order still prevents erasing a contract opened later.
    IF (p_state IS NOT NULL AND p_state <> 'null'::jsonb AND v_session.revision <> p_expected_revision)
       OR (v_session.last_message_id IS NOT NULL AND p_message_id <= v_session.last_message_id) THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'SESSION_CONFLICT';
    END IF;
    UPDATE contracter_private.telegram_sessions
       SET revision=revision+1,last_message_id=p_message_id,
           state=NULLIF(p_state,'null'::jsonb),updated_at=now()
     WHERE owner_chat_id=p_owner_chat_id
     RETURNING * INTO v_session;
    RETURN jsonb_build_object('revision',v_session.revision,'last_message_id',v_session.last_message_id,
        'state',v_session.state);
END;
$$;

DO $telegram_session_permissions$
DECLARE
    v_role text;
    v_function text;
    v_functions constant text[] := ARRAY[
        'contracter_private.telegram_session_text(jsonb,integer)',
        'contracter_private.valid_telegram_session_state(jsonb)',
        'public.contracter_get_telegram_session(bigint)',
        'public.contracter_save_telegram_session(bigint,integer,integer,jsonb)'];
BEGIN
    REVOKE ALL ON contracter_private.telegram_sessions FROM PUBLIC;
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=v_role) THEN
            EXECUTE format('REVOKE ALL ON contracter_private.telegram_sessions FROM %I',v_role);
        END IF;
    END LOOP;
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
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='service_role') THEN
        GRANT USAGE ON SCHEMA contracter_private TO service_role;
        GRANT SELECT,INSERT,UPDATE ON contracter_private.telegram_sessions TO service_role;
    END IF;
END;
$telegram_session_permissions$;

COMMIT;
