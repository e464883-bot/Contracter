# Contracter

Panel y sistema de auditoría contractual con trece roles, controles de consenso,
registro de costos y aprobación humana obligatoria. La demostración usa datos
ficticios y no consume tokens. El estado de las instalaciones reales se detalla
en [integration/ESTADO.md](integration/ESTADO.md).

## Abrir el panel

En Windows, abre **INICIAR_CONTRACTER.cmd**. Usa Node.js 24 o superior, ya
instalado en este equipo, y abre `http://127.0.0.1:8780`. El servidor queda en
una ventana de terminal. Cierra esa ventana para detenerlo.
También puedes ejecutar desde esta carpeta:

```powershell
node backend/server.mjs
```

Desde **Abrir Word, PDF o JSON**, puedes leer un Word `.docx` o un PDF con
texto, revisar lo extraído y descargar un `.txt` para adjuntarlo en el chat
privado de Telegram. El navegador hace la extracción localmente. Un PDF
escaneado requiere reconocimiento de texto antes de importarlo. Un JSON de
Contracter abre un expediente ya preparado. Los botones de la portada llevan
al bot y a la vista previa de Glenn.
Si instalas una copia para otro equipo, apunta las ligas de `docs/index.html`
al bot y al agente de voz de esa instalación.

Cuando Telegram confirme que guardó una propuesta V2, usa `/expediente` para
obtener el ID. En el panel conectado, entra a **Conectar un expediente** y
consulta ese ID. En **Versiones y cambios** encontrarás el texto propuesto y la
**Bitácora de Jarvis**. Una auditoría retenida queda a la espera de que se
resuelva el motivo indicado por el bot.

No se necesita instalar Supabase, Python ni paquetes npm para abrir el panel.
El modo predeterminado `mock` guarda una fixture SQLite local en `backend/data/`.
Esta copia contiene un caso ficticio, trece salidas de muestra, trece eventos de
costo de muestra y siete referencias de catálogo. Ejecutar el workflow completo
genera veinticinco intervenciones; esos resultados no se confunden con la seed.
La API mock permite leer esa misma fixture pública sin token. Los expedientes
live, la búsqueda normativa y la voz requieren autenticación privada.

## Servicios reales

- Los workflows 01 y 02 están importados en n8n Cloud y se probaron en modo MOCK.
- El workflow 03 responde comandos de Telegram y restringe tanto chat como usuario.
  Sus comandos no ejecutan dictámenes ni aceptan contratos o aprobaciones.
- Supabase es un servicio alojado. El proyecto Contracter se creó en Free con
  cotización de $0 mensuales al crear el proyecto, sin contratar un plan de pago.
  Conserva el Código de Comercio como primer candidato del corpus jurídico,
  pendiente de revisión.
- Glenn tiene una rama de demostración en ElevenLabs con un expediente de ejemplo
  y referencias documentales en español. La plataforma conserva por separado la
  versión principal y su borrador.
- GPT-6 Luna es el modelo base. La credencial de OpenAI está guardada en n8n.
  La prueba autenticada se detuvo por saldo agotado.
- Los borradores 05 y 06 contienen el flujo V2 y su canal de Telegram. La
  prueba integral en n8n usó respuestas y persistencia simuladas. No hay
  expedientes publicados en GitHub Pages.

La [prueba de aceptación empresarial](integration/PRUEBA_DE_ACEPTACION.md)
incluye el contrato de evaluación y los resultados que se deben observar en
la ejecución conectada.

## Configurar el gateway privado

El archivo `.env.example` es una plantilla. Copia los valores a variables del
proceso o a un `.env` privado y usa `node --env-file=.env backend/server.mjs`.
El inicio rápido ignora `.env` y siempre abre la demostración.

Para `CONTRACTER_MODE=live` se requieren `SUPABASE_URL`,
`CONTRACTER_DASHBOARD_TOKEN` de al menos 32 caracteres y una credencial de
lectura. Usa `CONTRACTER_STORE_READ_TOKEN` con alcance `dashboard` cuando
`contracter-store` esté desplegado. El adaptador directo admite
`SUPABASE_SECRET_KEY` o `SUPABASE_SERVICE_ROLE_KEY`. Si faltan los valores
requeridos, el gateway detiene el inicio. Guarda las credenciales en el
entorno privado del servidor.

La interfaz consulta `/api/health` y `/api/cases/{uuid}` al pulsar **Consultar
backend**. El token de acceso queda sólo en memoria de la pestaña. Los casos
privados se entregan mediante la API autenticada, nunca desde `docs/data/`.
`/api/legal/search` invoca búsqueda de texto completo en fuentes revisadas;
sin documentos revisados devuelve cero resultados. La fecha de consulta no
acredita vigencia jurídica.

### Demostración de voz y referencias oficiales

En ElevenLabs, abre **Contracter · Glenn**, selecciona la rama
`contracter-demostracion-voz` y entra a **Preview**. Prueba con una pregunta
como «¿Qué plazo de pago propone la V2 del expediente de muestra?».

Para abrir la conversación desde el panel local, conserva `CONTRACTER_MODE=mock`
y configura en el `.env` privado `CONTRACTER_DASHBOARD_TOKEN`,
`ELEVENLABS_ENABLED=true`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` y
`ELEVENLABS_AGENT_BRANCH_ID` con el identificador de la rama anterior. Arranca
con `node --env-file=.env backend/server.mjs`. Abre `http://127.0.0.1:8780`,
consulta el backend con el token del gateway y pulsa **Conectar voz**. El
servidor solicita una sesión de un solo uso. La API key queda en el servidor y
el micrófono se activa después de conceder permiso en el navegador. El contexto
se limita a un resumen del caso de demostración o de la evaluación configurada.
Las conversaciones pueden consumir créditos de ElevenLabs.

En el panel, abre **Fuentes y actualización** para ver tres referencias oficiales
cotejadas con páginas o localizadores. El cotejo identifica las publicaciones y
la versión observada. La aplicación jurídica al expediente sigue su revisión
propia antes de usar esas fuentes en una auditoría formal.

## Telegram V2 con expediente activo

El flujo conversacional empieza con el chat vacío. Envía un `.txt` UTF-8 y
responde «Confirmar» cuando lo pida. También puedes adjuntarlo con el
pie «Contrato» o pegar el texto después de una línea «Contrato:».
Esta ruta mantiene su alcance de evaluación y no permite aprobación formal.

Advertencia. Contracter está trabajando con Gemini Free. Puede cometer errores.

- Pregunta en español normal. Cada respuesta conserva la referencia del expediente
  y hasta tres turnos recientes para interpretar las preguntas de seguimiento.
- Escribe «Audita el contrato» o `/auditar` para recorrer la cadena completa.
  Si pide contexto, puedes responder «Soy comprador y quiero aclarar el pago».
  La prueba comienza con ámbito federal. Puedes indicar la región y la clave
  estatal en dos líneas como `Región: Jalisco` y `Entidad: 14`.
- Usa `/expediente` para ver el ID y estado del caso activo o `/revisar` para ver
  su estado de revisión. Puedes hacer otro envío o usar `/reset` para limpiar
  el caso y sus turnos. Los registros de auditoría ya guardados se conservan.

Los flujos internos son `integration/n8n/gemini_v2.json` y
`integration/n8n/telegram_v2.json`. Para habilitarlos, aplica
`database/telegram_session.sql` y despliega `contracter-store` con sus operaciones
de sesión. Importa cada JSON en un lienzo vacío de n8n. Asocia las credenciales
existentes de Gemini Free y datos de auditoría al motor, y las de Telegram y
lectura de Telegram al router. Configura el ID del motor en **Ejecutar motor V2**
y el chat y usuario autorizados en **Identificar chat autorizado**. Usa los
mismos permisos en el único disparador de Telegram. Publica el motor y router,
y actualiza el subflujo invocado por el disparador existente.

El costo del modelo corresponde a la cuota de Gemini Free. El menú, recibir
un archivo y restablecer el expediente no llaman al modelo. Las consultas
usan la cadena abreviada y una auditoría completa requiere más llamadas.
La aprobación formal requiere un expediente autorizado y fuentes revisadas.

El [respaldo local de Telegram V2](integration/RESPALDO-SIN-N8N.md) usa Node.js
para atender el mismo chat y conservar su expediente en Supabase si dejas de
usar n8n Cloud.

## Telegram V1 por comandos

Cuando se habilite `integration/n8n/live_telegram.json`, el chat privado
autorizado podrá enviar un solo archivo `.txt` guardado como UTF-8. Escribe
el comando y estos datos en el pie del adjunto.

```text
/auditar confirmar
Empresa: nuestra parte
Contraparte: la otra parte
Rol: comprador
Objetivo: precisar el plazo de entrega
Región: Federal
Confirmo: sí
```

Para una consulta puntual usa `/consulta confirmar` y agrega `Pregunta:` seguida
de tu pregunta. Si aplica un estado o municipio, indica la región y agrega
`Entidad:` con la clave de dos dígitos y, en su caso, `Municipio:` con la
clave de tres dígitos. El adjunto admite hasta 36 000 bytes, 12 000 unidades
de texto UTF-16 y 1500 líneas. También puedes pegar un contrato corto en
el mismo mensaje, debajo de una línea que contenga sólo `---`.

Si Contracter pide información adicional, reenvía el contrato y agrega una
línea `Aclaración:` de hasta 500 caracteres al formulario o al pie del adjunto.

Al importar el flujo, configura el chat y el usuario autorizado en el
disparador y en **Validar entrada Telegram**. Selecciona las credenciales
nativas y el identificador del workflow de auditoría. Verifica que n8n no
guarde los datos de ejecución manual ni de producción. Telegram admite
un solo disparador activo por bot.

## Validación reproducible

```powershell
python scripts/validate_case_json.py --preview --self-test --check-workflows --exercise-workflows
node --test backend/server.test.mjs
node --test backend/telegram-ingress.test.mjs
node --test backend/telegram-conversation.test.mjs backend/live-workflow.integration.test.mjs
```

El primer comando valida el caso, 22 rechazos de guardrails y trece
escenarios de workflow sin proveedores. El segundo prueba el gateway y sus
adaptadores con respuestas simuladas, sin llamadas reales de voz o LLM.
El tercero verifica la entrada por texto y adjunto, incluidos los nodos Code
exportados de n8n con una descarga simulada.
`database/verify_installation.sql` comprueba filtros y controles del corpus
dentro de una transacción que revierte sus fixtures.

El CI valida en push y pull request. GitHub Pages exige un despliegue manual,
datos `live`, consenso, diagnóstico limpio, aprobación HMAC y el entorno
protegido `legal-approval`. No publiques contratos privados en un sitio público.

El catálogo de fuentes oficiales cubre el plan de trabajo federal, las 32
entidades, municipios y tratados aplicables a México. No representa cobertura
normativa completa ni actualización automática ya operativa. Véase
[la arquitectura legal](integration/LEGAL_SOURCE_ARCHITECTURE.md).
