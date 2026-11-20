# Arquitectura del Sistema Multiagente: CONTRACTER

## 1. Visión General del Proyecto
**Contracter** es una mesa de guerra legal automatizada diseñada para auditar, corregir, blindar y traducir contratos comerciales mediante un ecosistema de 13 agentes especializados. El sistema opera bajo un bucle de consenso estricto, cuenta con defensa activa contra *Prompt Injection* en dos capas (perimetral y conductual), control de versiones (V1 a V2), registro riguroso de costos en base de datos, canal de mando en Telegram y un portal ejecutivo con voz en GitHub Pages.

---

## 2. El Escuadrón de Agentes (13 Roles con Identidad)

### A. Comando y Seguridad (Guardrails Activos)
1. **Fury (Orquestador):** Coordinador general de mano dura. Administra el orden de ejecución y mantiene retenido el documento redactado hasta que todos los agentes de auditoría confirmen explícitamente `"ENTENDIDO / CONFORME"`.
2. **Afton (Guardia de Seguridad / Securiter):** Guardrail perimetral de entrada. Recibe los documentos crudos y mensajes de usuario, elimina formatos ocultos (texto blanco, metadatos) y bloquea intentos directos o indirectos de *Prompt Injection* antes de que lleguen a Fury.
3. **House (Médico / Medic):** Auditor conductual interno. **Jamás lee el contrato** (lo que lo hace 100% inmune a inyecciones dentro del documento). Monitorea únicamente las respuestas y signos vitales de los demás agentes. Si detecta un comportamiento atípico (ej. Lupin aprobando todo sin quejas o Murdock rompiendo su estructura), declara al agente como **Infectado**, aísla su respuesta en cuarentena, lo interroga sin el documento enfrente para diagnosticar el fallo y purga su memoria obligando a repetir el paso.

### B. Inteligencia y Contexto
4. **Jane (Interrogador):** Especialista en lectura del cliente. Antes de analizar el papel, pregunta al usuario: *¿Quiénes somos? ¿Qué rol jugamos en el trato? ¿Con quién negociamos y qué buscamos ganar o proteger?*
5. **Sherlock (Investigador Web):** Recibe el contexto de Jane y rastrea en la web a todas las partes e involucrados en el contrato (historial público, reputación, antecedentes comerciales) para alimentar a los auditores.

### C. Auditoría Cuádruple (Los Sombreros de Revisión)
6. **Morty (Lector Inexperto):** Lee el contrato como un ciudadano común sin conocimiento legal y entra en pánico ante cualquier párrafo confuso, ambiguo o que suene a que la empresa va a perder algo. Si Morty no lo entiende o se alarma, la cláusula está mal redactada.
7. **Harvey (Consultor):** Primer filtro estratégico y corporativo. Va directo a los puntos de fricción comercial, plazos, pagos y condiciones de negociación antes de entrar a la ley dura.
8. **Murdock (Abogado):** Segundo filtro y experto en cumplimiento normativo. Cruza cada cláusula contra una base de conocimiento de leyes vigentes (RAG) para garantizar legalidad estricta y cero alucinaciones jurídicas.
9. **Lupin (Buscador de Huecos):** Mentalidad de infiltrado. No busca qué es ilegal, sino qué vacíos legales, trampas de doble filo o letras chiquitas permiten que la contraparte saque ventaja sin romper técnicamente la ley.

### D. Reconstrucción, Síntesis y Comunicación
10. **Hamilton (Redactor):** Toma todos los dictámenes del bucle de auditoría y redacta la versión corregida y blindada del contrato (pasando de `V1` a `V2`).
11. **Jarvis (Control de Cambios):** Sistema de precisión que trabaja junto a Hamilton. Genera un archivo técnico exacto registrando qué línea se modificó entre versiones, por qué se cambió y qué implicación operativa tiene.
12. **Watson (Reportero):** Comunicador ejecutivo. Consolida los archivos individuales de cada agente en un único reporte ágil y estructurado para evitar que el usuario tenga que leer diez chats separados.
13. **Glenn Radars (Narrador):** Profesor práctico para no abogados. Cierra el manual técnico y le explica al dueño del negocio en lenguaje directo, irreverente y cristalino cómo este contrato afecta a su empresa en la vida real y qué se está jugando al firmar.

---

## 3. Flujos de Trabajo (Workflows en n8n)

### Flujo 1: Proceso Completo de Auditoría y Blindaje (Creación V1 → V2)
1. **Entrada y Aduana:** El usuario envía el contrato por **Telegram** o Web. **Afton (Guardia de Seguridad)** limpia el archivo a texto plano, aplica expresiones regulares y valida que no contenga instrucciones de sabotaje.
2. **Fase de Inteligencia:** **Fury (Orquestador)** activa a **Jane (Interrogador)** para confirmar el contexto con el usuario vía Telegram y lanza a **Sherlock (Investigador Web)** para perfilar a la contraparte.
3. **Bucle de Calidad y Consenso:**
   - El contrato (encapsulado en etiquetas `<documento_no_confiable>`) pasa secuencialmente por **Morty**, **Harvey**, **Murdock** y **Lupin**.
   - Cada uno guarda sus observaciones en su registro individual.
   - **House (Médico)** audita las salidas de los cuatro en tiempo real. Si detecta un agente infectado, interviene y reinicia ese nodo.
4. **Reescritura y Retención:**
   - **Hamilton (Redactor)** genera la propuesta `V2` del contrato y **Jarvis (Control de Cambios)** documenta el *diff* exacto.
   - **Fury** verifica el consenso: el documento de Hamilton **no se libera** hasta que los auditores validen que sus alertas fueron cubiertas (`estado: ENTENDIDO`).
5. **Síntesis Ágil:** **Watson (Reportero)** empaqueta el resumen ejecutivo y **Glenn Radars (Narrador)** genera la explicación en lenguaje llano.
6. **Aprobación Humana Obligatoria (Human-in-the-Loop):** n8n envía el expediente a Telegram con botones de acción para el **Abogado Responsable**. Nada se da por válido ni se publica sin su confirmación/firma digital.

### Flujo 2: Vía Rápida de Consultas Directas (Q&A)
Cuando el usuario solo sube un documento para hacer preguntas puntuales sin requerir reescritura completa:
1. **Afton** sanitiza la entrada y la pregunta.
2. **Fury** enruta la duda exclusivamente al trío táctico: **Harvey (Consultor)** + **Murdock (Abogado)** + **Lupin (Buscador de Huecos)**.
3. **House** vigila que ninguno alucine leyes ni caiga en trampas del texto.
4. **Watson** unifica las tres posturas en una sola respuesta directa en Telegram.

---

## 4. Mapeo de Requisitos Académicos y Técnicos

* **Guardrails Anti-Inyección y Anti-Alucinación:**
  - *Perimetral:* **Afton** bloquea *Prompt Injection* en la entrada.
  - *Estructural:* Delimitadores XML (`<documento_no_confiable>`) y esquemas JSON forzados en cada nodo de n8n.
  - *Conductual:* **House** audita anomalías en las respuestas sin exponerse al documento original.
  - *Grounding Legal:* **Murdock** consulta leyes reales mediante RAG antes de emitir juicio, coronado por la firma obligatoria del abogado humano en Telegram.
* **Control de Versiones (Loop de Calidad):** Registro explícito del paso de `Contrato_V1` (original con vulnerabilidades) a `Contrato_V2` (blindado por Hamilton y auditado por Jarvis tras el consenso de Fury).
* **Registro de Costos en Base de Datos (Supabase / Postgres):** Cada vez que habla uno de los 13 agentes, un nodo en n8n guarda en la tabla `cost_logs`: `id_caso`, `agente` (ej. *Lupin*, *House*), `tokens_input`, `tokens_output`, `modelo`, `latencia_ms` y `costo_usd`.
* **GitHub Actions + GitHub Pages + ElevenLabs:**
  - Al aprobarse el contrato en Telegram, n8n hace un *commit* del JSON del caso al repositorio.
  - **GitHub Actions** ejecuta un script validador que verifica que el JSON incluya el visto bueno de Fury, el diagnóstico limpio de House, la bitácora de Jarvis y el cálculo de costos antes de desplegar.
  - **GitHub Pages** muestra el panel del contrato (`V1 vs V2`), el reporte de **Watson** y un widget de voz de **ElevenLabs** con la personalidad de **Glenn Radars** para que cualquier directivo escuche o consulte por voz qué implica el contrato en lenguaje sencillo.