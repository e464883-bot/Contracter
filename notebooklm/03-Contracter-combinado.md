# Contracter · Lo que se diseñó y lo que ya se puede demostrar

Fuente para un video explicativo en español. La implementación se describe con evidencia al 19 de noviembre de 2026.

## Un contrato, dos momentos

Una proveedora recibe un pedido de 1,000 kits. El contrato fija un precio de venta de $80,000 MXN antes de IVA y reconoce costos de $95,000. También permite reducir el precio hasta 10%. El cálculo de referencia muestra una pérdida de $15,000 antes de la reducción y de $23,000 con la reducción máxima. La pregunta empresarial es qué condiciones explican la pérdida y cuáles tendría sentido negociar.

Hoy, desde Telegram, la proveedora puede abrir un expediente, indicar su posición y pedir un análisis. En la prueba real, House retuvo una primera respuesta. Una consulta más concreta identificó ingresos y costos, aunque omitió expresar los dos importes finales de la pérdida. El ejemplo permite explicar tanto la utilidad como la necesidad de contrastar la respuesta.

## La misma historia en el recorrido completo previsto

En la arquitectura planeada, Fury conduce el expediente. Afton controla el documento y House supervisa las respuestas de los agentes, con un interrogatorio aislado cuando detecta anomalías. Jane aclara los hechos. Sherlock aporta contexto de la contraparte. Harvey mide el impacto comercial, Lupin explora interpretaciones adversas, Morty detecta lo que un lector entendería mal y Murdock verifica las cuestiones jurídicas con fuentes primarias.

Hamilton prepara una reescritura, Jarvis fundamenta cada cambio de V1 a V2 y Watson produce un reporte trazable. Glenn traduce el resultado a lenguaje sencillo y contempla una explicación de voz. La versión modificada queda ligada a las citas que se usaron, a las decisiones de los agentes y a la revisión de una persona autorizada.

## Qué mostrar en pantalla

| Escena | Qué mostrar | Estado |
| --- | --- | --- |
| Entrada | Un contrato pegado en Telegram y la pregunta sobre rol y objetivo | Verificado en vivo |
| Conversación | Una primera pregunta sobre el precio por caja y una segunda sobre el total del mismo expediente | Verificado en vivo con $180 y $3,600 MXN |
| Reporte | Lectura ejecutiva del caso limpio y cláusulas de aceptación por silencio y renovación en el caso ambiguo | Verificado en vivo |
| Control | Retención de la entrada con un marcador inerte y ejemplo de House reteniendo una respuesta | Observado en Telegram |
| V1 y V2 | Comparación de cláusulas, explicación de Jarvis, fuentes verificadas y decisión humana | Arquitectura y pruebas locales simuladas. La auditoría real se retuvo por fuentes pendientes. |
| Voz y panel | Una explicación de Glenn y el detalle privado del expediente | Integración o verificación pendientes |

## Para qué sirve la distinción

Los reportes actuales ya permiten que una persona discuta cifras, fechas, riesgos y ambigüedades con el mismo expediente abierto. La meta del proyecto es añadir una cadena verificable que lleve de esas preguntas a una propuesta de revisión respaldada, consultable y sometida a decisión humana. Conservar las pruebas y los límites de cada etapa permite enseñar qué está en funcionamiento y qué debe completarse.

**Indicación para NotebookLM.** Empieza con la pérdida del pedido y vuelve a ese caso al final. Usa las etiquetas «Verificado en vivo», «Probado localmente» y «Planeado» donde correspondan. Narra las cifras de referencia por separado de lo que devolvió el bot. Cierra explicando por qué las fuentes revisadas y la aprobación humana permiten avanzar a la V2 formal.
