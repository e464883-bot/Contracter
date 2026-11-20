# Contracter · La visión completa

Este documento describe el diseño previsto de Contracter, un ecosistema de agentes para revisar contratos empresariales. Está pensado para un video explicativo en español dirigido a un profesor y a personas que conocen los procesos de una empresa pero carecen de experiencia programando.

## El problema

Una pyme recibe un contrato de suministro. Puede leer el precio y la cantidad, pero quedan preguntas. ¿Cuándo empieza a contar el plazo de pago? ¿Quién decide cuándo se acepta una entrega? ¿Qué pasa si la contraparte cancela cuando la producción ya está terminada? Un resumen general puede esconder la diferencia entre una cláusula clara, una ambigüedad negociable y un riesgo que requiere intervención jurídica.

Contracter está diseñado para convertir ese contrato en un expediente de análisis. El expediente reúne la versión recibida, los hallazgos, una propuesta de cambios, las fuentes, la decisión humana y el costo registrado de las llamadas. La empresa puede revisar cómo se llegó a cada propuesta.

## Del contrato al expediente

El usuario envía el contrato e indica a qué parte representa, qué quiere proteger y en qué jurisdicción se analiza. El diseño contempla entrada por Telegram o web, con un ID por expediente y preguntas de seguimiento. n8n coordina las acciones y Supabase guarda la evidencia, las versiones, los estados y el uso del modelo por agente, con tokens, latencia, modelo y costo. El panel muestra los cambios cláusula por cláusula. ElevenLabs está previsto como canal de voz para explicar un expediente autorizado.

## Qué aportan los trece agentes

| Agente | Responsabilidad en el diseño |
| --- | --- |
| Fury | Ordena las etapas, coordina iteraciones y decide si el caso sigue, se retiene o pasa a revisión. |
| Afton | Examina el documento como entrada no confiable. Puede detenerlo antes del análisis. |
| House | Supervisa la conducta de los agentes. Si detecta una anomalía, abre un interrogatorio aislado, emite un veredicto y puede reintentar la intervención afectada. |
| Jane | Pide aclaraciones sobre las partes, el objetivo y los hechos que faltan para evaluar el documento. |
| Sherlock | Examina el contexto y, cuando haya una integración apropiada, contrasta información pública de la contraparte. |
| Morty | Lee como persona sin formación jurídica y señala redacciones confusas. En rondas sucesivas puede reconsiderar una alarma con explicaciones respaldadas. |
| Harvey | Evalúa las consecuencias comerciales, los costos, las condiciones y las opciones de negociación. |
| Murdock | Contrasta cuestiones jurídicas con fuentes primarias pertinentes. Cuando falta sustento, deja pendiente la conclusión. |
| Lupin | Busca interpretaciones adversas, vacíos y escenarios que las cláusulas dejan abiertos. |
| Hamilton | Redacta una propuesta de corrección con los hechos confirmados. |
| Jarvis | Registra las diferencias entre el contrato original y la propuesta. |
| Watson | Expone hallazgos, decisiones, fuentes y límites en un reporte para el usuario. |
| Glenn | Explica el expediente con lenguaje sencillo y una historia. El diseño contempla explicación por voz. |

## Cómo se controla una reescritura

La versión recibida se denomina V1 y la propuesta V2. Los revisores evalúan la V2 concreta que escribió Hamilton. Jarvis explica los cambios y Fury conserva los desacuerdos materiales cuando siguen abiertos. La revisión jurídica requiere una fuente identificada, una cita exacta y una comprobación de versión, vigencia y pertinencia. El alcance proyectado incluye leyes federales, estatales y municipales de México, además de tratados aplicables.

El recorrido rápido para dudas puntuales reúne la lectura comercial de Harvey, el contraste jurídico de Murdock y las interpretaciones adversas de Lupin. House supervisa sus salidas y Watson compone la respuesta en Telegram.

El resultado formal sigue un paso de revisión humana asociado a esa versión exacta. El diseño propone registrar la decisión del abogado responsable desde Telegram. Los expedientes se consultan en acceso privado. Para material autorizado y anonimizado, la publicación prevista enlaza n8n con un commit en GitHub, una validación con GitHub Actions y el despliegue del panel en GitHub Pages.

## Secuencia para el video

1. Abre con el contrato de suministro y una fecha de pago ambigua.
2. Dibuja Telegram → n8n → agentes → Supabase → panel y reportes.
3. Muestra tres intervenciones. Jane pregunta cuándo se acepta la entrega, Harvey ve el riesgo de financiar costos y Lupin detecta dos lecturas posibles. Afton y House son controles en etapas distintas.
4. Presenta V1 y V2 lado a lado y muestra qué aporta un revisor humano antes de dar por concluido el expediente.

**Indicación para NotebookLM.** Presenta las capacidades en futuro o como diseño previsto. Usa un ejemplo inventado y distingue el reporte ejecutivo, el análisis experto, las cláusulas para abogado y la explicación en forma de historia.
