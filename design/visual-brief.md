# Contracter · encargo visual y decisiones

## Propósito

- Audiencia: dueño o directivo de la empresa y abogado responsable.
- Tarea: revisar la propuesta V2, sus cambios, fuentes y controles antes de una decisión profesional.
- Pregunta principal: ¿qué impide liberar esta propuesta y dónde está la evidencia?
- Resultado exitoso: el lector distingue el estado declarado, la evidencia disponible y lo que todavía falta, sin confundir una simulación con un dictamen.
- Modo: hybrid. Una lectura inicial señala la retención; la exploración permite revisar líneas, referencias y eventos.
- Formato: webapp operativa estática, HTML/CSS/JavaScript nativos sin librerías externas.
- Medio: escritorio y móvil; referencias de QA 1264×714 y 390×844.
- Frecuencia: bajo demanda. No existe autoactualización del navegador; la carga del backend ocurre por acción explícita.

## Datos e integridad

- El demo es un expediente ficticio. No se modifica para aparentar actividad real.
- Grano del caso: un UUID y un par V1/V2. Grano de costo: una intervención/event_id. Grano de auditoría: una salida por auditor y hash. Grano legal: una referencia/source.id.
- Fuentes: JSON de demostración o archivo local; opcionalmente GET /cases/{uuid} del backend configurado. El estado de infraestructura procede exclusivamente de GET /health.
- Periodo: corte declarado en created_at; fuentes con fecha retrieved_at; servicios con checked_at. Las fechas se presentan en America/Mexico_City.
- Medidas: cuatro auditores únicos como denominador del consenso; número de cambios; USD/tokens/ms por intervención y suma del expediente.
- Filtros: un expediente completo, sin filtros analíticos. La selección de origen no mezcla casos.
- Faltantes: costos numéricos desconocidos se rechazan, no se sustituyen con cero. Ausencia de fuentes o sincronización muestra «Sin configurar» o «Sin registro».
- Duplicados: los identificadores de fuentes y eventos se rechazan si se repiten. El consenso requiere auditores únicos y la huella declarada de V2.
- Límites: los estados del JSON son declarados. El frontend no verifica una firma HMAC, identidad del abogado, vigencia normativa, integridad criptográfica ni conectividad a proveedores. El validador y el backend deben realizar esas comprobaciones.
- Fechas de consulta: retrieved_at no es fecha de reforma, entrada en vigor ni prueba de que una norma sea aplicable. Un umbral operativo de 24 horas sólo invita a revisar la consulta; es configurable y no determina vigencia.

## Wireframe y secuencia

1. Propósito y acciones: cargar demo, archivo local o lectura backend.
2. Aviso persistente de simulación/estado declarado, identidad, fuente/corte/alcance y motivo de retención.
3. Cuatro KPI: conformidad de cuatro auditores, cambios, diagnóstico declarado y costo.
4. Secuencia de controles: entrada → consenso → House → abogado.
5. Columna principal: V1/V2 y bitácora → Watson → fuentes jurídicas → cuatro auditorías → costo por intervención.
6. Columna secundaria: Glenn, contexto Jane, controles y estados de servicios.
7. Guía de uso y límites del sistema.

En móvil la lectura contractual se apila a ancho completo; los campos del backend y las fuentes también se apilan. Las tablas extensas tienen desplazamiento propio y nombre accesible.

## Representaciones elegidas

| Vista | Pregunta | Representación | Transformación | Alternativa descartada y motivo |
|---|---|---|---|---|
| Conformidad | ¿Cuántos revisores únicos dieron ENTENDIDO a esta huella de V2? | KPI numérico n/4 | Cuenta cada uno de Morty, Harvey, Murdock y Lupin sólo si existe una salida única, estado y hash coinciden | Dona: añade área/ángulo sin ayudar a comprobar cuatro estados discretos |
| Versiones | ¿Qué texto cambió y por qué? | Dos columnas de líneas numeradas + bitácora | Marcas según números declarados; línea 0 representa ausencia en inserción/eliminación | Línea de tendencia: no existe una serie temporal cuantitativa |
| Fuentes | ¿Qué referencias y fechas respaldan este caso? | Tabla título/id, dominio, consulta | URL HTTP(S) sin credenciales; fechas locales; sin rellenar títulos ni vigencias | Mapa: jurisdicción no requiere comparar regiones |
| Costos | ¿Qué eventos integran el total declarado? | Tabla por intervención con suma | Suma eventos USD, tokens y latencia; alerta si el total difiere | Barras del demo: todos los valores son cero y no hay diferencias que comparar |
| Auditores | ¿Qué perspectiva y observaciones aportó cada auditor? | Cuatro tarjetas comparables | Orden fijo por función; cuenta observaciones y resueltas | Pie de riesgo: las categorías no son partes mutuamente excluyentes de un total |
| Servicios | ¿Qué configuración reportó el backend y cuándo? | Lista de estados con texto y fecha | configured/unconfigured/error/unknown, sin traducir configuración a ejecución comprobada | Medidores de salud: inventarían un porcentaje sin denominador |

## Seguridad de la lectura web

PUBLIC_CONFIG contiene sólo URL base pública, lista exacta de orígenes y umbral de consulta. La base está vacía por defecto. El token opcional se guarda sólo en una variable de sesión y se borra del input; no hay localStorage ni sessionStorage. Al cambiar de origen no se reutiliza. El botón de borrado cancela consultas pendientes.

Se prefiere un proxy del mismo origen, por ejemplo /api. Para un backend de otro dominio, el operador debe añadir su origen exacto tanto a allowedApiOrigins como a connect-src del HTML y configurar CORS en el servidor. No se permiten comodines, credenciales en URLs, redirecciones de fetch ni HTTP fuera de localhost. Las respuestas se acotan a 2 MB y 15 segundos. No se aprueba ni publica un caso desde esta interfaz.

## Diseño y accesibilidad

- Jerarquía: motivo de retención antes del detalle; fuente y corte visibles junto al caso.
- Color: verde azulado para conformidad declarada, ámbar para pendiente y rojo para rechazo/error. Todo estado tiene texto e icono; el color no es el único canal.
- Controles: etiquetas asociadas, foco visible, tamaño de entrada mínimo 44 px, tabs con teclado y aviso live para cargas/errores.
- Recuperación: demo y selector local siempre disponibles; errores de backend conservan el expediente anterior; borrar token no borra el contenido ya mostrado.
- Datos sensibles: los secretos de proveedores y el contenido privado no se incrustan en la configuración pública. Publicar un frontend estático no protege por sí mismo los expedientes.

## Verificación

El resultado reproducible del validador visual se conserva en QA.md. Las revisiones visuales sólo se marcan realizadas cuando el render final exacto ha sido inspeccionado; no se presume una conexión real desde una captura ni desde una consola abierta.
