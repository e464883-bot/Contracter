-- CONTRACTER / PostgreSQL 14+ o editor SQL de Supabase.
-- Ejecutar primero este archivo y después seed_mock.sql, sólo en una base propia.
-- No abre conexiones, no crea usuarios ni contiene credenciales.
-- CREATE IF NOT EXISTS permite instalación inicial repetida; no es un migrador.
-- Los adaptadores backend deben usar transacciones, consultas parametrizadas y
-- autorización propia. No conceder acceso directo desde GitHub Pages.
BEGIN;

CREATE TABLE IF NOT EXISTS public.cases (
    id_caso uuid PRIMARY KEY,
    schema_version text NOT NULL DEFAULT '1.0.0' CHECK (schema_version = '1.0.0'),
    titulo text NOT NULL CHECK (length(btrim(titulo)) > 0),
    mode text NOT NULL DEFAULT 'mock' CHECK (mode IN ('mock', 'live')),
    status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
        ('DRAFT', 'CONSENSUS', 'AWAITING_HUMAN', 'APPROVED', 'REJECTED', 'QUARANTINED')),
    case_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(case_json) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (mode <> 'mock' OR status <> 'APPROVED')
);

CREATE TABLE IF NOT EXISTS public.contract_versions (
    id_caso uuid NOT NULL REFERENCES public.cases(id_caso) ON DELETE RESTRICT,
    version text NOT NULL CHECK (version IN ('V1', 'V2')),
    texto text NOT NULL CHECK (length(texto) > 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id_caso, version),
    UNIQUE (id_caso, sha256),
    UNIQUE (id_caso, version, sha256)
);

-- Un registro por intervención, no una fila mutable por agente.
-- House recibe proyecciones de metadatos por lista permitida; no case_json,
-- texto contractual, respuestas libres ni fragmentos de otros agentes.
CREATE TABLE IF NOT EXISTS public.agent_logs (
    event_id uuid PRIMARY KEY,
    id_caso uuid NOT NULL REFERENCES public.cases(id_caso) ON DELETE RESTRICT,
    agente text NOT NULL CHECK (agente IN ('Fury', 'Afton', 'House', 'Jane',
        'Sherlock', 'Morty', 'Harvey', 'Murdock', 'Lupin', 'Hamilton',
        'Jarvis', 'Watson', 'Glenn')),
    mode text NOT NULL CHECK (mode IN ('mock', 'live')),
    etapa text NOT NULL CHECK (length(btrim(etapa)) > 0),
    ronda integer NOT NULL DEFAULT 1 CHECK (ronda >= 1),
    estado text NOT NULL CHECK (length(btrim(estado)) > 0),
    output_json jsonb NOT NULL CHECK (jsonb_typeof(output_json) = 'object'),
    quarantined boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, id_caso, agente)
);

CREATE INDEX IF NOT EXISTS agent_logs_case_created_idx
    ON public.agent_logs(id_caso, created_at);

CREATE TABLE IF NOT EXISTS public.cost_logs (
    event_id uuid PRIMARY KEY,
    id_caso uuid NOT NULL,
    agente text NOT NULL,
    tokens_input bigint NOT NULL CHECK (tokens_input >= 0),
    tokens_output bigint NOT NULL CHECK (tokens_output >= 0),
    modelo text NOT NULL CHECK (length(btrim(modelo)) > 0),
    latencia_ms bigint NOT NULL CHECK (latencia_ms >= 0),
    currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    pricing_status text NOT NULL CHECK (pricing_status IN ('mock', 'verified', 'unverified')),
    -- NULL significa pendiente de tarifa, nunca consumo gratuito.
    input_rate_per_million numeric(20,10) CHECK (input_rate_per_million >= 0),
    output_rate_per_million numeric(20,10) CHECK (output_rate_per_million >= 0),
    pricing_source text,
    costo_usd numeric(24,12) CHECK (costo_usd >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (event_id, id_caso, agente)
        REFERENCES public.agent_logs(event_id, id_caso, agente) ON DELETE RESTRICT,
    CHECK (pricing_status = 'unverified' OR
        (input_rate_per_million IS NOT NULL AND output_rate_per_million IS NOT NULL
         AND costo_usd IS NOT NULL AND pricing_source IS NOT NULL
         AND length(btrim(pricing_source)) > 0)),
    CHECK (pricing_status <> 'verified' OR
        pricing_source ~ '^https://[^[:space:]]+$'),
    CHECK (pricing_status <> 'mock' OR
        (tokens_input = 0 AND tokens_output = 0 AND costo_usd = 0
         AND input_rate_per_million = 0 AND output_rate_per_million = 0
         AND pricing_source = 'mock' AND modelo = 'mock-no-api')),
    CHECK (pricing_status <> 'unverified' OR costo_usd IS NULL),
    CHECK (costo_usd IS NULL OR abs(costo_usd -
        ((tokens_input * input_rate_per_million +
          tokens_output * output_rate_per_million) / 1000000)) <= 0.000000000001)
);

CREATE INDEX IF NOT EXISTS cost_logs_case_idx ON public.cost_logs(id_caso);

-- Decisión autenticada vinculada al hash. La firma NO se calcula aquí:
-- la emite el adaptador backend sólo tras validar identidad/rol del abogado.
-- Canon HMAC-SHA256: JSON {case_id,approved_sha256,approver,approved_at,
-- evidence_reference}, claves ordenadas, sin espacios, UTF-8, ensure_ascii=False.
CREATE TABLE IF NOT EXISTS public.human_approvals (
    approval_id uuid PRIMARY KEY,
    id_caso uuid NOT NULL REFERENCES public.cases(id_caso) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('APPROVED', 'REJECTED')),
    approver text NOT NULL CHECK (length(btrim(approver)) > 0),
    approved_at timestamptz NOT NULL,
    approved_version text NOT NULL DEFAULT 'V2' CHECK (approved_version = 'V2'),
    approved_sha256 text NOT NULL CHECK (approved_sha256 ~ '^[0-9a-f]{64}$'),
    evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) > 0),
    attestation_algorithm text NOT NULL DEFAULT 'HMAC-SHA256'
        CHECK (attestation_algorithm = 'HMAC-SHA256'),
    attestation_signature text NOT NULL CHECK (attestation_signature ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (id_caso, approved_version, approved_sha256)
        REFERENCES public.contract_versions(id_caso, version, sha256) ON DELETE RESTRICT
);

-- RLS sin policies: anon/authenticated no tienen acceso. Los secretos/backend
-- privilegiados jamás se sirven en docs/. Diseñar policies antes de dar acceso.
ALTER TABLE public.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.human_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cases, public.contract_versions, public.agent_logs,
    public.cost_logs, public.human_approvals FROM PUBLIC;

-- Defensa adicional para instalaciones Supabase con grants predeterminados.
DO $permissions$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON public.cases, public.contract_versions, public.agent_logs,
            public.cost_logs, public.human_approvals FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON public.cases, public.contract_versions, public.agent_logs,
            public.cost_logs, public.human_approvals FROM authenticated;
    END IF;
END
$permissions$;

COMMENT ON TABLE public.cases IS
    'Expedientes privados. case_json se valida con validate_case_json.py antes de exportar.';
COMMENT ON TABLE public.cost_logs IS
    'USD por intervención; tarifa pendiente queda NULL, mock cuesta cero sin tokens.';
COMMENT ON TABLE public.human_approvals IS
    'Evidencia autenticada del abogado ligada a V2; no se genera en seed_mock.';
COMMIT;
