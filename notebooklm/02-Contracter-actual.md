# Contracter · Qué funciona hoy

Estado comprobado al 19 de noviembre de 2026. Este documento sirve como fuente para un video de demostración en español sobre la implementación disponible y las pruebas observadas.

## Recorrido operativo en Telegram

El flujo V2 publicado recibe un contrato pegado bajo el encabezado `Contrato:` o admite un archivo de texto UTF-8. El bot abre un expediente con ID y pregunta a qué parte representa el usuario y qué quiere revisar. Un chat trabaja con un expediente activo. La persona puede preguntar en español natural. El sistema utiliza el texto del contrato y conserva hasta tres intercambios recientes para interpretar seguimientos. `/reset` limpia el expediente activo y su contexto. La ruta por texto pegado y el restablecimiento se comprobaron en Telegram. El adjunto se verificó localmente.

n8n enlaza Telegram con el motor y la consulta a Gemini Free. Supabase conserva la sesión privada, el registro de intervenciones y las métricas disponibles. El bot muestra el aviso de que trabaja con Gemini Free y puede cometer errores.

## Consultas y reportes

Los comandos publicados son `/reporte ejecutivo`, `/reporte experto`, `/reporte abogado` o `/clausulas`, y `/storytelling`. Producen explicaciones preliminares basadas en el contrato. Los reportes ejecutivo y de cláusulas se comprobaron en Telegram. El experto y storytelling pasaron pruebas locales. La explicación de storytelling es texto en esta etapa.

## Cuatro casos de evaluación

| Caso | Qué pasó |
| --- | --- |
| Compra clara | El reporte ejecutivo identificó $27,840 MXN, la fecha de entrega y el plazo para reportar faltantes. Omitió precisar el día exacto a partir del cual se cuenta el plazo de pago. |
| Suministro adverso | House retuvo la respuesta a una pregunta amplia. En una pregunta acotada, Contracter detectó ingresos de $80,000 o $72,000 frente a $95,000 de costos. El cálculo de referencia da pérdidas de $15,000 y $23,000. El reporte observado no expresó ambas diferencias. |
| Servicio ambiguo | Después de un ajuste y una nueva prueba, el reporte identificó cláusulas sobre vigencia, aceptación por silencio, renovación y cierre. Conservó el aviso de verificación jurídica pendiente. |
| Control de Afton | Un marcador inerte de evaluación activó la retención en Telegram. La bitácora registró un evento y cero llamadas al modelo para ese caso. |

En otra prueba conversacional, Contracter respondió que cada caja costaba $180 y calculó un total de $3,600 al recibir una pregunta de seguimiento. La prueba registró USD 0 de costo del modelo. Esa cifra corresponde a esa ejecución.

## Hasta dónde llega la auditoría

El intento de auditoría completa quedó retenido en la etapa de fuentes. El Código de Comercio estaba cargado con 437 fragmentos y seguía pendiente de revisión. Había cero fuentes aprobadas en el último conteo verificado. Los cambios de ampliación y consulta documental se pausaron antes de comprobarlos en producción. Las pruebas locales con modelos simulados ejercitan la cadena completa de agentes. Sigue pendiente una ejecución real que guarde una V2 con citas verificadas y registre la decisión humana sobre esa versión.

La investigación web de la contraparte, el acceso al panel privado y la voz ligada al expediente tienen trabajo de integración o de aceptación pendiente. Los PDF de contratos requieren una vía de lectura adicional.

**Indicación para NotebookLM.** Presenta el video como demostración fechada. Enseña cómo se abre el caso, cómo se pregunta y qué devolvieron las pruebas. Conserva las cifras y menciona las omisiones observadas. Usa español claro y marca las capacidades pendientes antes de cerrar.
