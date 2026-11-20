# Evaluación de Contracter con una compraventa empresarial

Una empresa compradora recibe un contrato con fechas de entrega imprecisas y un plazo de pago ambiguo. La evaluación consiste en comprobar si Contracter detecta esos puntos, explica sus consecuencias y propone una versión que la empresa pueda enviar a revisión humana. El caso es ficticio y reproduce un problema empresarial.

## Contrato de evaluación

Usa `/evaluar` para elegir proveedor en el chat privado autorizado, una vez publicado el nuevo flujo. Para Gemini usa `/evaluar gemini consulta` si quieres probar la conexión con una consulta operativa corta, o `/evaluar gemini` para la auditoría con la muestra incorporada. Para evaluar un contrato ficticio de tu elección con OpenAI, usa el siguiente formulario. El comando confirma el posible uso de créditos de la API de OpenAI y marca el expediente como ficticio. Para probar una aprobación efectiva se necesita un expediente autorizado y un abogado verificado. [Guía de proveedores](PROVEEDORES.md)

```text
/evaluar confirmar
Empresa: Compradora de muestra
Contraparte: Proveedora de muestra
Rol: comprador
Objetivo: precisar las fechas de entrega, documentar la recepción parcial y acordar cuándo empieza el plazo de pago.
Región: Federal
Confirmo: sí
---
CONTRATO DE COMPRAVENTA MERCANTIL DE EVALUACIÓN

1. Objeto. La Proveedora de muestra vende a la Compradora de muestra 120 cajas de material de empaque por un precio total de $24,000 MXN, más los impuestos aplicables.

2. Entrega. La Proveedora entregará los productos durante el próximo mes en el almacén de la Compradora. Puede dividir la entrega según su disponibilidad. La Compradora recibirá los productos cuando lleguen y la Proveedora dará por cumplida su obligación de entrega.

3. Pago. La Compradora pagará en un plazo de 30 días. El plazo comenzará en cuanto la operación esté procesada. El precio se pagará mediante transferencia bancaria.

4. Recepción. Las partes conservarán los comprobantes de entrega. En caso de diferencias de cantidad, la Compradora las comunicará a la Proveedora para su revisión.
```

Si Jane pide precisión, reenviar el mensaje con la siguiente línea antes del separador `---`.

```text
Aclaración: Las partes acuerdan 60 cajas en cada una de dos fechas escritas en la orden de compra. Cada recepción parcial debe documentar la cantidad recibida. El pago empieza a contar desde la recepción conforme de las 120 cajas y de la factura correspondiente.
```

## Resultados que debe poder comprobar el maestro

| Paso | Evidencia esperada |
| --- | --- |
| Entrada | Telegram acepta el contrato en un chat autorizado y n8n registra una ejecución identificable. |
| Auditoría | Los 13 roles intervienen según el flujo. El informe identifica ambigüedades en la entrega y el pago y explica su efecto práctico. La bitácora registra el resultado del consenso y cualquier aislamiento aplicado. |
| Fuentes | Las citas textuales coinciden con fragmentos revisados del documento oficial y muestran su referencia. Para preparar el cotejo, las páginas 50 y 51 del PDF reúnen los artículos de compraventa mercantil, sujetos a revisión de vigencia y pertinencia. [Código de Comercio oficial](https://www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf#page=50) |
| Reescritura | La V2 concreta la entrega y el inicio del plazo de pago con los datos aportados, y conserva las cantidades y el precio. Jarvis identifica cada cambio. |
| Expediente | Supabase conserva las dos versiones y el panel privado permite consultar el expediente, los cambios, las fuentes y el uso real del modelo. |
| Revisión | Se observa el estado de espera de revisión y la protección contra aprobaciones de casos ficticios. En un expediente autorizado, la decisión humana se vincula a la V2 exacta. |
| Voz | ElevenLabs explica el resultado de un expediente de evaluación autorizado mediante una sesión habilitada para ese contexto. |

## Condiciones para ejecutar la prueba conectada

1. Conectar Gemini Free y completar la consulta breve en n8n, o confirmar el saldo de OpenAI y completar una prueba de su credencial si se elige esa ruta.
2. Registrar la revisión jurídica del Código de Comercio y de los fragmentos necesarios para el caso. Comprobar que la observación oficial esté dentro de la ventana de actualización y que la búsqueda devuelva las referencias revisadas.
3. Verificar el acceso privado del evaluador, el tratamiento del caso ficticio, la ruta Telegram–n8n–Supabase–panel y el alcance de la revisión humana. Ejecutar y guardar la evidencia de la prueba.
4. Comprobar la sesión de voz con un expediente de evaluación y el acceso autorizado al agente de ElevenLabs.

En una evaluación en la computadora del propietario, configurar el panel con
`CONTRACTER_MODE=live`, el acceso privado a Supabase y
`CONTRACTER_DASHBOARD_EVALUATION_CASE_ID` con el identificador devuelto por el
bot. Este panel sólo entrega ese expediente si Supabase lo marca como
ficticio, sigue pendiente de aprobación y Fury conserva el bloqueo. Si la
evaluación se hace a distancia, se requiere una instancia privada accesible
al maestro. El servidor local escucha en `127.0.0.1`.

Para generar el material del revisor, ejecutar desde el proyecto
`python legal_sources/sync_pilot.py --export-review-pages 50 51`. La salida
identifica tres fragmentos candidatos y enlaza a las páginas archivadas. Una
observación fuera de la ventana de 48 horas requiere repetir la captura antes
de ejecutar la prueba conectada.

Esta prueba comprueba un proceso empresarial delimitado. La cobertura de México y tratados, junto con la actualización automática, tienen su propio avance en la [arquitectura jurídica](LEGAL_SOURCE_ARCHITECTURE.md) y en el [estado de Contracter](ESTADO.md).
