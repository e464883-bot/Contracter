# Modelo base: GPT-6 Luna

El dueño eligió OpenAI y pidió un modelo reciente, capaz y de costo muy bajo.
Se prepara `gpt-6-luna` como base. La selección no cambia el modo MOCK ni
autoriza pruebas de pago, recargas o escalamiento automático a otro modelo.

La documentación oficial consultada el 4 de noviembre de 2026 lo describe como
el más económico de la familia GPT-6 para tareas enfocadas y confirma Responses
API, function calling y Structured Outputs. Esas capacidades no demuestran por
sí solas calidad jurídica; aún debe evaluarse con contratos representativos y
fuentes oficiales revisadas.

Precios de referencia en USD por millón de tokens, procesamiento Standard y
contexto corto, sin herramientas ni suplementos:

| Modelo | Entrada | Salida | Entrada en caché |
| --- | ---: | ---: | ---: |
| gpt-6-luna | $0.10 | $0.50 | $0.01 |

No se asume caché gratuita ni se presupuesta una tarifa fija por contrato. Cada
intervención registra el uso real; el razonamiento y las reejecuciones pueden
aumentar los tokens facturados. Trece roles no equivalen necesariamente a trece
solicitudes porque el consenso puede exigir rondas adicionales. No se activan
búsqueda web, herramientas de pago ni modos Fast/Ultrafast en esta selección.

El dueño guardó la clave en la credencial nativa `OpenAI account` de n8n. La
[prueba autenticada](https://example.invalid/workflow/a9Vn7Nbmh5vyPRWg)
recibió `429 credit_balance_exhausted` y el último saldo observado fue USD 0.00.
La primera respuesta de GPT-6 Luna y su evaluación jurídica siguen pendientes.
El [panel de facturación de OpenAI](https://platform.openai.com/settings/organization/billing/overview)
permite al dueño revisar y gestionar el saldo.

Fuentes:
- [Modelo GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Precios oficiales](https://developers.openai.com/api/docs/pricing)
- [Guía de la familia GPT-6](https://developers.openai.com/api/docs/guides/latest-model)
