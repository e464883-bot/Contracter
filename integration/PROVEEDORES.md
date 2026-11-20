# Elegir proveedor en Contracter

El selector del [panel](../docs/index.html) prepara un comando de Telegram. El flujo de Telegram valida al dueño y al chat privado antes de abrir una ruta. Los comandos del selector usan un expediente ficticio fijo.

| Opción | Comando | Qué ejecuta |
| --- | --- | --- |
| Gemini Free, consulta breve | `/evaluar gemini consulta` | Consulta operativa sobre entrega y pago. Si faltan fuentes revisadas, la respuesta indica que la verificación jurídica está pendiente. |
| Gemini Free, auditoría completa | `/evaluar gemini` | Intenta el recorrido de auditoría. El sistema retiene la V2 si faltan fuentes jurídicas revisadas o si falla un control. |
| OpenAI directo | `/evaluar openai` | Muestra el aviso de costo. El usuario puede iniciar la evaluación con `/evaluar openai confirmar`. |
| Gateway de n8n | `/evaluar gateway` | Informa el estado del respaldo. Hay una prueba manual independiente pendiente de verificar en n8n. |

## Conectar Gemini Free en n8n

1. Abre [Proyectos en Google AI Studio](https://aistudio.google.com/projects) y confirma que el proyecto elegido muestre **Nivel gratuito**. Mantén el proyecto en ese nivel. En [Claves de API](https://aistudio.google.com/api-keys) copia la clave del mismo proyecto. [Facturación de Gemini](https://aistudio.google.com/docs/billing)
2. En [n8n](https://example.invalid/home/credentials), guarda la credencial **Contracter · Gemini Free** de tipo **Header Auth**. Escribe `x-goog-api-key` en **Name**, pega la clave en **Value** y limita **Allowed Domains** a `generativelanguage.googleapis.com`.
3. Abre el [flujo de conexión](https://example.invalid/workflow/TODO_WORKFLOW_ID) o importa [su JSON](n8n/gemini_connectivity.json). En **Gemini · prueba ficticia**, selecciona explícitamente **Contracter · Gemini Free** en **Credential**. n8n puede elegir por defecto otra credencial del mismo tipo. Ejecuta el flujo manualmente y comprueba que **Resultado de conexión** indique `connected: true` y `http_status: 200`.
4. Abre el [flujo de evaluación](https://example.invalid/workflow/TODO_WORKFLOW_ID) o importa [su JSON](n8n/gemini_audit.json). Asigna **Contracter · Gemini Free** al nodo Gemini y **Contracter · Datos auditoría** al nodo Supabase. Ejecuta **Consulta ficticia manual** y comprueba `QA_READY`, `persisted: true` y el texto de la consulta en **Resultado privado**. Un error de cuota detiene la ejecución y permite probar de nuevo al renovarse el límite. [Cuotas de Gemini](https://aistudio.google.com/docs/rate-limits)
5. Abre el [borrador de Telegram](https://example.invalid/workflow/TODO_WORKFLOW_ID) o importa [su JSON](n8n/live_telegram.json). **Ejecutar agentes Gemini** apunta al subflujo de evaluación y **Ejecutar agentes** al subflujo 05 de OpenAI. El borrador hereda los filtros de dueño del flujo anterior. Después de verificar las dependencias, registra un solo disparador para el bot y prueba `/evaluar` y `/evaluar gemini consulta` desde el chat autorizado.

La ruta de evaluación usa **Gemini 3.5 Flash-Lite**. Mantén el proyecto de Gemini en Free. Los datos que llegan al modelo provienen de la muestra incorporada y, si el buscador encuentra coincidencias, de extractos jurídicos revisados. El modo gratuito de Google tiene condiciones específicas de tratamiento del contenido. [Tarifa del modelo](https://aistudio.google.com/docs/pricing#gemini-3.5-flash-lite) · [Condiciones del servicio sin pago](https://aistudio.google.com/docs/terms#data-use-unpaid)

## Activar el respaldo de Gateway

Importa la [prueba de Gateway](n8n/openai_gateway_probe.json) y selecciona **Use Gateway credits** en su nodo OpenAI. Confirma que el modelo aparezca en el selector, revisa el saldo y ejecuta manualmente sólo cuando se decida usar esos créditos. **Comprobar compatibilidad** informa si el nodo devuelve JSON válido, confirma el esquema estricto, conserva desactivado el almacenamiento y entrega los contadores de tokens. La prueba de una llamada precede a la habilitación del respaldo en el bot. [Créditos de Gateway](https://docs.n8n.io/deploy/use-n8n-cloud/gateway-credits)
