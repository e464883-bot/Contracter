-- CONTRACTER: caso ficticio, sin aprobación ni consumo real.
-- Ejecutar después de schema.sql. Idempotente; no toca expedientes live.
-- El payload es una copia exacta de docs/data/sample_case.json.
-- No se inserta ninguna fila en human_approvals: el abogado NO ha firmado.
BEGIN;
DO $seed$
DECLARE
    task_payload jsonb := $contracter_mock$
{
  "schema_version": "1.0.0",
  "case_id": "11111111-1111-4111-8111-111111111111",
  "mode": "mock",
  "title": "Contrato de suministro · demostración ficticia",
  "created_at": "2026-11-04T12:00:00-06:00",
  "jurisdiction": {
    "country": "México (supuesto de demostración)",
    "region": "Por confirmar",
    "legal_basis_status": "not_verified",
    "sources": []
  },
  "context": {
    "our_party": "Empresa Aurora (ficticia)",
    "counterparty": "Proveedor Delta (ficticio)",
    "our_role": "Cliente",
    "objectives": [
      "Aclarar pagos, entrega y cambios de precio en un caso simulado."
    ],
    "confirmed": true
  },
  "security": {
    "agent": "Afton",
    "status": "CLEAN",
    "sanitized_text": "1. PARTES: Empresa Aurora (cliente ficticio) y Proveedor Delta (contraparte ficticia).\n2. PAGO: El cliente pagará pronto según lo que decida el proveedor.\n3. ENTREGA: El proveedor entregará cuando sea posible.\n4. CAMBIOS: El proveedor podrá cambiar el precio sin aviso.",
    "findings": [],
    "limitations": [
      "Resultado simulado, no una prueba de ausencia de inyección.",
      "El texto plano no permite reconstruir formatos ocultos ni metadatos del archivo original."
    ]
  },
  "versions": {
    "v1": {
      "text": "1. PARTES: Empresa Aurora (cliente ficticio) y Proveedor Delta (contraparte ficticia).\n2. PAGO: El cliente pagará pronto según lo que decida el proveedor.\n3. ENTREGA: El proveedor entregará cuando sea posible.\n4. CAMBIOS: El proveedor podrá cambiar el precio sin aviso.",
      "sha256": "ee630d4f8541371911962e1e2f2afd213975f127e39d88d316ca7e21522e1ff5"
    },
    "v2": {
      "text": "1. PARTES: Empresa Aurora (cliente ficticio) y Proveedor Delta (contraparte ficticia).\n2. PAGO: El cliente pagará dentro de 30 días naturales de recibir la factura aceptada, por transferencia.\n3. ENTREGA: El proveedor entregará el 15 de diciembre de 2026; cualquier cambio requiere aceptación escrita de ambas partes.\n4. CAMBIOS: Todo ajuste de precio requiere una propuesta escrita y aceptación expresa de ambas partes antes de aplicarse.",
      "sha256": "47724da8c994b415d58c666a14a4adf0c5a950c8836b056e1ac35d1b0a6ae429"
    }
  },
  "audits": [
    {
      "agent": "Morty",
      "reviewed_version": "V2",
      "reviewed_sha256": "47724da8c994b415d58c666a14a4adf0c5a950c8836b056e1ac35d1b0a6ae429",
      "status": "ENTENDIDO",
      "findings": [
        {
          "id": "F-01",
          "clause": "2",
          "severity": "high",
          "observation": "El plazo de pago es ambiguo. Revisión simulada; no es un dictamen jurídico.",
          "recommendation": "Precisar plazo, factura y medio de pago.",
          "resolved": true,
          "source_ids": []
        }
      ]
    },
    {
      "agent": "Harvey",
      "reviewed_version": "V2",
      "reviewed_sha256": "47724da8c994b415d58c666a14a4adf0c5a950c8836b056e1ac35d1b0a6ae429",
      "status": "ENTENDIDO",
      "findings": [
        {
          "id": "F-02",
          "clause": "3",
          "severity": "high",
          "observation": "La entrega no tiene fecha exigible en el texto. Revisión simulada; no es un dictamen jurídico.",
          "recommendation": "Fijar fecha y procedimiento para cambios.",
          "resolved": true,
          "source_ids": []
        }
      ]
    },
    {
      "agent": "Murdock",
      "reviewed_version": "V2",
      "reviewed_sha256": "47724da8c994b415d58c666a14a4adf0c5a950c8836b056e1ac35d1b0a6ae429",
      "status": "ENTENDIDO",
      "findings": [
        {
          "id": "F-03",
          "clause": "4",
          "severity": "high",
          "observation": "El precio puede cambiar unilateralmente. Revisión simulada; no es un dictamen jurídico.",
          "recommendation": "Exigir aceptación escrita bilateral.",
          "resolved": true,
          "source_ids": []
        }
      ]
    },
    {
      "agent": "Lupin",
      "reviewed_version": "V2",
      "reviewed_sha256": "47724da8c994b415d58c666a14a4adf0c5a950c8836b056e1ac35d1b0a6ae429",
      "status": "ENTENDIDO",
      "findings": [
        {
          "id": "F-04",
          "clause": "4",
          "severity": "medium",
          "observation": "No hay mecanismo de aceptación de cambios. Revisión simulada; no es un dictamen jurídico.",
          "recommendation": "Vincular el ajuste con aceptación expresa previa.",
          "resolved": true,
          "source_ids": []
        }
      ]
    }
  ],
  "house": {
    "agent": "House",
    "status": "CLEAN",
    "checks": [
      {
        "agent": "Morty",
        "output_schema_valid": true,
        "anomaly_detected": false,
        "quarantine_required": false,
        "diagnostic": "Fixture estructural válido; sin evaluación jurídica.",
        "retry_count": 0
      },
      {
        "agent": "Harvey",
        "output_schema_valid": true,
        "anomaly_detected": false,
        "quarantine_required": false,
        "diagnostic": "Fixture estructural válido; sin evaluación jurídica.",
        "retry_count": 0
      },
      {
        "agent": "Murdock",
        "output_schema_valid": true,
        "anomaly_detected": false,
        "quarantine_required": false,
        "diagnostic": "Fixture estructural válido; sin evaluación jurídica.",
        "retry_count": 0
      },
      {
        "agent": "Lupin",
        "output_schema_valid": true,
        "anomaly_detected": false,
        "quarantine_required": false,
        "diagnostic": "Fixture estructural válido; sin evaluación jurídica.",
        "retry_count": 0
      }
    ],
    "contract_access": false,
    "limitations": [
      "La proyección de metadatos reduce exposición; no garantiza inmunidad ni detección de alucinaciones."
    ]
  },
  "changelog": [
    {
      "id": "C-01",
      "line_v1": 2,
      "line_v2": 2,
      "before": "2. PAGO: El cliente pagará pronto según lo que decida el proveedor.",
      "after": "2. PAGO: El cliente pagará dentro de 30 días naturales de recibir la factura aceptada, por transferencia.",
      "reason": "Se sustituyó una expresión indeterminada por un plazo explícito.",
      "operational_impact": "Ejemplo de redacción para probar la tubería; requiere revisión profesional antes de cualquier uso.",
      "addresses_finding_ids": [
        "F-01"
      ]
    },
    {
      "id": "C-02",
      "line_v1": 3,
      "line_v2": 3,
      "before": "3. ENTREGA: El proveedor entregará cuando sea posible.",
      "after": "3. ENTREGA: El proveedor entregará el 15 de diciembre de 2026; cualquier cambio requiere aceptación escrita de ambas partes.",
      "reason": "Se especificó una fecha y un procedimiento bilateral.",
      "operational_impact": "Ejemplo de redacción para probar la tubería; requiere revisión profesional antes de cualquier uso.",
      "addresses_finding_ids": [
        "F-02"
      ]
    },
    {
      "id": "C-03",
      "line_v1": 4,
      "line_v2": 4,
      "before": "4. CAMBIOS: El proveedor podrá cambiar el precio sin aviso.",
      "after": "4. CAMBIOS: Todo ajuste de precio requiere una propuesta escrita y aceptación expresa de ambas partes antes de aplicarse.",
      "reason": "Se eliminó la facultad unilateral de variar el precio.",
      "operational_impact": "Ejemplo de redacción para probar la tubería; requiere revisión profesional antes de cualquier uso.",
      "addresses_finding_ids": [
        "F-03",
        "F-04"
      ]
    }
  ],
  "fury": {
    "agent": "Fury",
    "status": "CONSENSUS",
    "released": false,
    "reviewed_sha256": "47724da8c994b415d58c666a14a4adf0c5a950c8836b056e1ac35d1b0a6ae429",
    "auditors_required": [
      "Morty",
      "Harvey",
      "Murdock",
      "Lupin"
    ],
    "rounds": 1,
    "max_rounds": 3
  },
  "human_approval": {
    "required": true,
    "status": "PENDING",
    "approver": null,
    "approved_at": null,
    "approved_sha256": null,
    "evidence_reference": null,
    "attestation": {
      "algorithm": "HMAC-SHA256",
      "signature": null
    }
  },
  "reports": {
    "watson": {
      "summary": "Tres cláusulas se aclararon en una simulación V1 → V2. Los cuatro auditores dieron conformidad al texto de ejemplo; la aprobación del abogado sigue pendiente.",
      "key_risks": [
        "Jurisdicción y fuentes legales sin verificar.",
        "No existe todavía firma ni aprobación humana.",
        "Los controles de seguridad son heurísticos y simulados."
      ],
      "recommendations": [
        "Confirmar contexto y jurisdicción con Jane.",
        "Conectar RAG con fuentes oficiales y revisión de Murdock.",
        "Obtener aprobación autenticada del abogado sobre el hash exacto de V2 antes de publicar."
      ]
    },
    "glenn": {
      "explanation": "En este ejemplo ya se dice cuándo pagar, cuándo entregar y cómo cambiar el precio. Eso vuelve más claro el trato. Pero un acuerdo claro también puede tener problemas legales: el abogado todavía debe revisarlo. Aquí nadie ha firmado ni consultado leyes reales."
    }
  },
  "costs": {
    "currency": "USD",
    "pricing_status": "mock",
    "total_usd": 0,
    "events": [
      {
        "event_id": "d0f680d1-92da-542f-ad35-959948aadbc0",
        "agent": "Fury",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      },
      {
        "event_id": "70cf7642-7d29-5282-aa46-9a6fd8c23099",
        "agent": "Afton",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      },
      {
        "event_id": "9e71b026-ba8d-5f88-a58e-4805422761b2",
        "agent": "House",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      },
      {
        "event_id": "43b6f02a-105b-54a3-9828-fa6f4864f390",
        "agent": "Jane",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      },
      {
        "event_id": "14061d26-d6fc-59aa-82f0-9f924eb52732",
        "agent": "Sherlock",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      },
      {
        "event_id": "9bfa90da-20e3-59f5-bfe1-97247a23068f",
        "agent": "Morty",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      },
      {
        "event_id": "38e698ee-40cb-5a53-a249-c3f88c709ace",
        "agent": "Harvey",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      },
      {
        "event_id": "697fca17-f524-5ec1-aa7e-1579e128ab6f",
        "agent": "Murdock",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      },
      {
        "event_id": "592033f4-461f-5e16-a038-2c7ac1870a94",
        "agent": "Lupin",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      },
      {
        "event_id": "2d24282d-738c-5c12-abe3-7cba46fe0b9d",
        "agent": "Hamilton",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      },
      {
        "event_id": "0e3dbf4d-801f-5dc2-8eb6-0f6708581473",
        "agent": "Jarvis",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      },
      {
        "event_id": "84a94eaf-8526-541f-a5db-cb4dbffc7480",
        "agent": "Watson",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      },
      {
        "event_id": "e5713623-8cf9-5ddf-aca8-6eefce8ed15d",
        "agent": "Glenn",
        "tokens_input": 0,
        "tokens_output": 0,
        "model": "mock-no-api",
        "latency_ms": 0,
        "cost_usd": 0,
        "input_rate_per_million": 0,
        "output_rate_per_million": 0,
        "pricing_source": "mock"
      }
    ]
  },
  "publication": {
    "target": "preview",
    "contains_sensitive_data": false,
    "redacted_for_public": true
  },
  "integrations": {
    "elevenlabs": {
      "enabled": false,
      "agent_id": "TODO_INSERT_KEY_HERE"
    }
  }
}
$contracter_mock$::jsonb;
    task_case_id uuid := (task_payload->>'case_id')::uuid;
BEGIN
    IF EXISTS (SELECT 1 FROM public.cases WHERE id_caso = task_case_id AND mode <> 'mock') THEN
        RAISE EXCEPTION 'El UUID de demostración pertenece a un caso live; seed cancelado';
    END IF;
    INSERT INTO public.cases (id_caso, schema_version, titulo, mode, status,
                             case_json, created_at, updated_at)
    VALUES (task_case_id, task_payload->>'schema_version', task_payload->>'title',
            'mock', 'AWAITING_HUMAN', task_payload,
            (task_payload->>'created_at')::timestamptz,
            (task_payload->>'created_at')::timestamptz)
    ON CONFLICT (id_caso) DO UPDATE SET
        schema_version = EXCLUDED.schema_version, titulo = EXCLUDED.titulo,
        status = EXCLUDED.status, case_json = EXCLUDED.case_json,
        updated_at = EXCLUDED.updated_at;

    INSERT INTO public.contract_versions (id_caso, version, texto, sha256, created_at)
    SELECT task_case_id, upper(task_v.key), task_v.value->>'text',
           task_v.value->>'sha256', (task_payload->>'created_at')::timestamptz
    FROM jsonb_each(task_payload->'versions') AS task_v
    ON CONFLICT (id_caso, version) DO UPDATE SET
        texto = EXCLUDED.texto, sha256 = EXCLUDED.sha256;

    INSERT INTO public.agent_logs (event_id, id_caso, agente, mode, etapa, ronda,
                                   estado, output_json, quarantined, created_at)
    SELECT (task_e->>'event_id')::uuid, task_case_id, task_e->>'agent', 'mock',
           'mock-pipeline', 1, 'SIMULATED',
           CASE task_e->>'agent'
             WHEN 'Afton' THEN task_payload->'security'
             WHEN 'Fury' THEN task_payload->'fury'
             WHEN 'House' THEN task_payload->'house'
             WHEN 'Jane' THEN task_payload->'context'
             WHEN 'Sherlock' THEN jsonb_build_object('status','NOT_CONNECTED',
                  'sources', '[]'::jsonb, 'notice','Sin investigación web real; fixture mock')
             WHEN 'Hamilton' THEN task_payload#>'{versions,v2}'
             WHEN 'Jarvis' THEN jsonb_build_object('changelog',task_payload->'changelog')
             WHEN 'Watson' THEN task_payload#>'{reports,watson}'
             WHEN 'Glenn' THEN task_payload#>'{reports,glenn}'
             ELSE (SELECT task_a FROM jsonb_array_elements(task_payload->'audits') AS task_a
                   WHERE task_a->>'agent' = task_e->>'agent')
           END,
           false, (task_payload->>'created_at')::timestamptz
    FROM jsonb_array_elements(task_payload#>'{costs,events}') AS task_e
    ON CONFLICT (event_id) DO UPDATE SET
        estado = EXCLUDED.estado, output_json = EXCLUDED.output_json,
        quarantined = EXCLUDED.quarantined;

    INSERT INTO public.cost_logs (event_id, id_caso, agente, tokens_input,
        tokens_output, modelo, latencia_ms, currency, pricing_status,
        input_rate_per_million, output_rate_per_million, pricing_source,
        costo_usd, created_at)
    SELECT (task_e->>'event_id')::uuid, task_case_id, task_e->>'agent',
        (task_e->>'tokens_input')::bigint, (task_e->>'tokens_output')::bigint,
        task_e->>'model', (task_e->>'latency_ms')::bigint, 'USD', 'mock',
        (task_e->>'input_rate_per_million')::numeric,
        (task_e->>'output_rate_per_million')::numeric,
        task_e->>'pricing_source', (task_e->>'cost_usd')::numeric,
        (task_payload->>'created_at')::timestamptz
    FROM jsonb_array_elements(task_payload#>'{costs,events}') AS task_e
    ON CONFLICT (event_id) DO UPDATE SET
        tokens_input = EXCLUDED.tokens_input, tokens_output = EXCLUDED.tokens_output,
        modelo = EXCLUDED.modelo, latencia_ms = EXCLUDED.latencia_ms,
        currency = EXCLUDED.currency, pricing_status = EXCLUDED.pricing_status,
        input_rate_per_million = EXCLUDED.input_rate_per_million,
        output_rate_per_million = EXCLUDED.output_rate_per_million,
        pricing_source = EXCLUDED.pricing_source, costo_usd = EXCLUDED.costo_usd;
END
$seed$;
COMMIT;

-- Verificación tras ejecutar: 1 expediente, 2 versiones, 13 intervenciones,
-- 13 costos mock con suma 0 y 0 aprobaciones para este UUID.
SELECT c.id_caso, c.mode, c.status,
    (SELECT count(*) FROM public.contract_versions v WHERE v.id_caso=c.id_caso) AS versiones,
    (SELECT count(*) FROM public.agent_logs l WHERE l.id_caso=c.id_caso) AS intervenciones,
    (SELECT count(*) FROM public.cost_logs l WHERE l.id_caso=c.id_caso) AS eventos_costo,
    (SELECT sum(costo_usd) FROM public.cost_logs l WHERE l.id_caso=c.id_caso) AS costo_mock_usd,
    (SELECT count(*) FROM public.human_approvals h WHERE h.id_caso=c.id_caso) AS aprobaciones
FROM public.cases c WHERE c.id_caso='11111111-1111-4111-8111-111111111111';
