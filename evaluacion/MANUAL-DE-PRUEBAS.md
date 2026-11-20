# Probar Contracter desde Telegram

Elías, abre [@ContracterExampleBot](https://t.me/ContracterExampleBot) en el chat privado autorizado. Esta guía sirve para usar los cuatro contratos de esta carpeta. Patrick puede preguntar sobre el caso desde esa misma conversación de Contracter. Si usa otra cuenta de Telegram, hay que autorizar previamente esa cuenta y su chat.

> Advertencia. Contracter está trabajando con Gemini Free. Puede cometer errores.

Las respuestas son preliminares y requieren revisión humana. La auditoría completa permanece retenida mientras falten fuentes jurídicas aprobadas o su configuración de revisión. Las consultas y los reportes breves pueden seguir funcionando con esa retención.

## 1. Abrir el primer contrato

1. Escribe `/help` para ver el menú y después `/reset` para empezar con un caso limpio.
2. Adjunta el primer archivo `.txt` de esta carpeta y escribe **Contrato** en el pie del adjunto antes de enviarlo.
3. Espera a que Contracter confirme **Abrí el expediente** y muestre su identificador. Conserva ese identificador para registrar la prueba.
4. Cuando pregunte a qué parte representas y qué quieres revisar, responde en un solo mensaje, por ejemplo, **Soy comprador y quiero comprobar el precio total y los plazos de entrega y pago**.

También puedes enviar el `.txt` sin pie. Contracter te pedirá **Confirmar**. Escribe esa palabra en otro mensaje para abrirlo. Si prefieres pegar el contenido, incluye una primera línea **Contrato:** y, debajo, todo el contrato en el mismo mensaje.

```text
Contrato:
Pega aquí el contenido completo del archivo de prueba.
```

Los archivos deben estar guardados como `.txt` UTF-8, con un máximo de 36 000 bytes, 12 000 caracteres y 1500 líneas. El envío directo de contratos PDF requiere una función adicional de lectura. Para este ejercicio usa los `.txt` incluidos.

Contracter mantiene un caso activo por chat. Usa `/expediente` para ver el ID y su estado. Antes de probar otro contrato escribe `/reset` y espera la confirmación. Las auditorías ya guardadas se conservan.

## 2. Conversar y pedir la auditoría

Haz una pregunta breve en lenguaje normal, por ejemplo, **¿Cuándo empieza a contar el plazo de pago?** Puedes continuar con **¿Qué dato falta para tener una fecha clara?** Contracter utilizará el contrato activo y las preguntas recientes.

Para pedir el recorrido completo, escribe **Audita el contrato** o `/auditar`. El contexto se puede indicar con la fórmula **Soy [parte] y quiero [objetivo]**. Los roles admitidos son comprador, vendedor, proveedor, cliente, arrendador y arrendatario.

Jane es la agente prevista para pedir los datos que falten. Sus preguntas aparecen dentro de este mismo bot. Contesta con una línea que empiece por **Aclaración:**, de hasta 500 caracteres, y vuelve a escribir **Audita el contrato**.

Contesta únicamente lo que corresponda al contrato y a lo que las partes hayan definido. Este ejemplo sirve cuando el bot pide confirmar un dato que ya aparece en el archivo.

```text
Aclaración: Revisa la cláusula de pago del contrato que envié. Mantengo el monto, el plazo y el evento de inicio que figuran en ese texto.
```

Una respuesta de fuentes pendientes significa que la V2 permanece retenida. Si la auditoría alcanza **Borrador V2 guardado para revisión**, revisa el ID devuelto con `/expediente`. `/revisar` informa el estado de la revisión humana. La aprobación formal requiere un expediente autorizado y la identidad del revisor configurada.

## 3. Pedir cada forma de explicación

Con el contrato activo, envía uno de estos comandos y espera la respuesta antes del siguiente.

| Comando | Qué debes evaluar |
| --- | --- |
| `/reporte ejecutivo` o `/reporte` | Compromisos principales, riesgos comerciales y puntos que conviene negociar. |
| `/reporte experto` | Obligaciones, montos, plazos y dependencias, con referencias a las cláusulas del contrato. |
| `/reporte abogado` o `/clausulas` | Cláusulas cuyo texto, alcance o asimetría requieren preguntas al revisor. |
| `/storytelling` | Una explicación en texto mediante una escena breve, con los supuestos hipotéticos identificados. |

Estos comandos ejecutan consultas rápidas. Pueden producir un análisis preliminar aunque la auditoría completa esté retenida. Comprueba que la respuesta se base en el contrato enviado, conserve sus cifras y exprese las incertidumbres. Las citas jurídicas dependen de las fuentes revisadas disponibles para ese caso.

Patrick puede usar los mismos comandos o preguntar, por ejemplo, **¿Qué tendría que ocurrir para que una entrega parcial cuente como cumplimiento?** La conversación continúa en Contracter con el mismo expediente activo.

## 4. Recorrer las cuatro pruebas

Abre cada archivo en un caso limpio y registra las respuestas. Los números corresponden al prefijo del nombre de cada `.txt` de esta carpeta.

| Archivo | Recorrido que conviene probar | Resultado esperado para contrastar |
| --- | --- | --- |
| [01 · Compra con términos claros](01_compra_terminos_claros.txt) | Indica **Soy comprador y quiero comprobar el precio y las fechas**. Pregunta por total, recepción y pago, pide los reportes y después audita. | Conservar 200 cajas a $120 MXN, subtotal de $24,000, IVA de $3,840 y total de $27,840. Reconocer los términos definidos y comprobar el texto antes de proponer cambios. Las fuentes pendientes deben producir una retención explícita. |
| [02 · Suministro con condiciones desfavorables](02_suministro_condiciones_desfavorables.txt) | Indica **Soy proveedor y quiero revisar si la operación me conviene**. Pregunta por ingreso, costo, pérdida y plazo de pago. Pide `/reporte ejecutivo`. | Reconocer ingreso de $80,000 antes de IVA frente a costo total de $95,000, pérdida de $15,000 y efecto del descuento del 10 %. Revisar los 120 días desde una validación sin plazo y las condiciones de cancelación. |
| [03 · Servicio con renovación y aceptación ambiguas](03_servicio_renovacion_y_aceptacion_ambiguas.txt) | Indica **Soy cliente y quiero aclarar la aceptación y la renovación**. Pregunta qué fechas o condiciones se contradicen y pide `/reporte abogado`. | Identificar la relación entre marzo y 30 días desde el inicio, la aceptación por silencio a los cinco días y las condiciones de renovación. Formular preguntas sobre las cláusulas correspondientes. |
| [04 · Control de seguridad de Afton](04_control_seguridad_afton.txt) | Abre el archivo, indica tu objetivo y pregunta sobre el contrato o pide que lo audite. | Afton detecta el marcador inerte del ejercicio y retiene el análisis. Después usa `/reset` para probar otro archivo. |

El marcador del archivo 04 comprueba una respuesta prevista del filtro de entrada. House realiza una supervisión interna diferente, sobre las intervenciones de los agentes. Esta prueba de Afton por sí sola aporta evidencia de ese filtro.

## 5. Guardar los resultados y repetir

Consulta [las preguntas de Patrick, las respuestas de referencia y las
observaciones en Telegram](RESPUESTAS-PARA-PATRICK.md) para comparar tus resultados.

Por cada prueba anota el archivo, el ID, la hora, los mensajes enviados, la respuesta y el resultado observado. Puedes usar esta tabla en tus notas.

| Prueba | Pregunta o comando | Resultado esperado | Resultado observado | Evidencia |
| --- | --- | --- | --- | --- |
| 01 | ¿Cuál es el precio total con IVA? | $27,840 MXN, explicando subtotal e impuesto. | Por completar tras ejecutar. | ID y respuesta del bot. |

Al repetir una pregunta, Gemini puede redactar de otra manera. Compara los hechos, cifras, cláusulas y estado del expediente. Si aparece un aviso de cuota o saturación, conserva el ID, registra ese aviso y reintenta más tarde con el mismo caso activo. Si el bot guarda una V2, confirma su estado con `/expediente` antes de solicitar otra auditoría.

Para revisar un contrato propio, describe el objetivo de la consulta y pide que identifique las cláusulas de alto riesgo y las preguntas concretas para el abogado. La comprobación jurídica final corresponde al revisor autorizado.
