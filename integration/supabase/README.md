# Almacenamiento privado de Contracter

`contracter-store` recibe peticiones de servicios de confianza. n8n usa una
credencial nativa Header Auth con un token propio por función. La clave
privilegiada del proyecto queda dentro del entorno de Supabase Edge Functions.

## Instalación

1. Instala `database/schema.sql` y `database/legal_corpus.sql` si el proyecto
   todavía carece de esas tablas. Aplica `database/live_runtime.sql` y ejecuta
   `database/verify_live_runtime.sql` sobre un proyecto con `seed_mock.sql`.
   La verificación termina con `ROLLBACK`. Usa una sesión SQL administrativa
   y comprueba tanto la salida como el estado final de la transacción.
2. Despliega `functions/contracter-store/index.ts` con `verify_jwt=false`.
   La función comprueba cada token antes de ejecutar la operación autorizada.
   `runtime_tokens` empieza vacío. Usa `integration` como directorio del
   proyecto si el despliegue se hace con Supabase CLI.
3. Para cada integración genera un valor aleatorio distinto de 32 bytes y
   represéntalo como 64 caracteres hexadecimales minúsculos. Guarda el valor
   únicamente en la credencial del servicio que lo usa. Registra en SQL su
   SHA-256, calculado sobre los 64 caracteres UTF-8, con vencimiento explícito.
4. Para habilitar decisiones, configura una llave aleatoria independiente en
   el secreto `CONTRACTER_APPROVAL_HMAC_KEY` de la función. Registra el chat y
   el usuario de Telegram del abogado responsable en `approval_principals`
   después de verificar su identidad y autorización fuera del contrato.

```sql
-- Sustituye parámetros en una sesión administrativa privada. La tabla recibe
-- el hash del token, nunca el token en texto. Registra sólo scopes que se usan.
INSERT INTO contracter_private.runtime_tokens (scope, token_sha256, expires_at)
VALUES ('audit', '<SHA-256 de 64 caracteres hex>', now() + interval '30 days');

INSERT INTO contracter_private.approval_principals (chat_id, telegram_user_id)
VALUES (<chat privado verificado>, <usuario abogado verificado>);
```

Para revocar un token o un abogado, cambia `active` a `false`. Al rotar un token
crea primero el nuevo digest, cambia la credencial n8n y desactiva el digest
anterior. La función revalida el rol del abogado cuando se pulsa el botón.

## Operaciones

Envía JSON por `POST` a `/functions/v1/contracter-store` con `Authorization:
Bearer <token del scope>`. Los identificadores de Telegram se pueden enviar
como cadenas decimales, lo que evita convertirlos en números de punto flotante.

| Scope | Operación | Campos principales |
| --- | --- | --- |
| `audit` | `claim_run` | `run_id`, `synthetic`, `owner_chat_id` |
| `audit` | `persist` | Los mismos campos, `status`, `reason` opcional, `case`, `agent_logs`, `usage_events` |
| `audit` | `legal_search` | `p_query`, `p_country_code: "MX"`, `p_entity_code`, `p_municipality_code`, `p_as_of`, `p_limit` |
| `approval` | `issue_approval` | `case_id`, `chat_id`, `approver_id` |
| `approval` | `redeem_approval` | `callback_query` original del Telegram Trigger |
| `telegram` | `get_case` | `audience: "telegram"`, `case_id`, `owner_chat_id` del evento autenticado |
| `dashboard` | `get_case` | `audience: "dashboard"`, `case_id`, desde gateway autenticado |

Para Telegram deriva `run_id` de un identificador estable de la actualización
original. Sólo `accepted: true` permite iniciar una llamada facturable. Un
duplicado puede devolver `CLAIMED`, `STALE` o el estado final. `STALE` indica que
transcurrieron 30 minutos sin cierre. Revisa la ejecución y su consumo antes de
iniciar una solicitud nueva. Un fallo al persistir se puede reintentar con el
mismo contenido. `RUN_BUSY` indica que otra transacción lo está guardando.

El expediente y V1/V2 se crean juntos únicamente en `AWAITING_HUMAN`. Los estados
`HELD`, `QA` y `CONTEXT_REQUIRED` usan `case: null`, conservan sus intervenciones y
permiten costos desconocidos. Cada evento de uso se vincula al `event_id` y agente
de su intervención. Los casos con `synthetic: true` quedan fuera de aprobación.

Al emitir una aprobación, usa `approve_data` y `reject_data` como datos de los
dos botones de Telegram. Vencen en 15 minutos. Un nuevo par invalida el anterior.
El workflow de callbacks toma chat y actor de su Telegram Trigger autenticado.
Evita exponer ese workflow mediante un webhook genérico que acepte objetos
con identidades elegidas por el remitente. Un callback válido registra una
decisión y el hash de V2 en la misma transacción. La atestación HMAC acredita
integridad de la decisión dentro de Contracter. La identidad profesional y el
alcance de la autorización dependen de la verificación administrativa previa.

La lectura jurídica filtra documentos y localizadores revisados mediante
`legal_search_fts`. GitHub Pages sigue siendo un proceso separado. La API de
expedientes, incluidos los aprobados, conserva los contratos como datos privados.

## Comprobación local

```powershell
node --experimental-strip-types --test integration/supabase/contracter-store.test.mjs
```

El comando usa adaptadores simulados y cubre las fronteras HTTP, los scopes, el
formato de firma y los errores. La verificación SQL cubre transacciones reales
cuando se ejecuta sobre PostgreSQL con el esquema instalado.
