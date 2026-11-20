# Piloto de fuentes jurídicas

El actualizador descarga el Código de Comercio de la Cámara de Diputados y coteja los datos de reforma de su primera página contra la ficha legislativa. También registra la fila de México en dos fichas de tratados de la Colección de Tratados de las Naciones Unidas. Cada fuente tiene una URL fija y se conserva con SHA-256. [PDF](https://www.diputados.gob.mx/LeyesBiblio/pdf/CCom.pdf) · [Ficha de reformas](https://www.diputados.gob.mx/LeyesBiblio/ref/ccom.htm) · [Compraventa internacional](https://treaties.un.org/pages/ViewDetails.aspx?chapter=10&clang=_en&mtdsg_no=X-10&src=TREATY) · [Laudos arbitrales extranjeros](https://treaties.un.org/pages/ViewDetails.aspx?chapter=22&clang=_en&mtdsg_no=XXII-1&src=TREATY)

## Ejecutar y revisar

Desde la carpeta `contracter`, con Python y `pypdf` disponibles:

```powershell
python legal_sources/sync_pilot.py
python legal_sources/sync_pilot.py --replay
```

El primer comando hace una revisión nueva de las cuatro URLs públicas. Usa los validadores HTTP cuando la fuente los proporciona y verifica la huella de las capturas. El segundo vuelve a extraer el texto y los metadatos desde la última captura completa. Conserva las fechas originales de observación.

El directorio local `.pilot_data/` guarda los originales por huella en `raw/`. Cada `runs/<id>/` guarda su manifiesto, el candidato del Código y el inventario de tratados cuando están disponibles. Un intento parcial conserva la evidencia y los errores del intento. `latest.json` sigue apuntando a la última captura completa. El directorio de capturas está excluido de Git y de la raíz web.

El fragmentador conserva referencias a página y bloque. El PDF y la ficha deben coincidir en la reforma observada y en la actualización de cantidades que declaran. Los fragmentos se preparan con revisión pendiente y vigencia desconocida. Las fechas observadas de reforma, publicación, descarga y vigencia tienen significados distintos.

## Cobertura del piloto

| Ámbito | Resultado que entrega el actualizador |
| --- | --- |
| Federal | Candidato del Código de Comercio con texto por página y dos fuentes de contraste. |
| Estatal | Registro de las 32 entidades en `catalog.json`. La ingestión por entidad sigue pendiente. |
| Municipal y demarcaciones | Inventario pendiente de fuentes y unidades. |
| Tratados | Dos fichas del depositario de la ONU con evidencia de la acción registrada para México. La aplicabilidad, el texto completo, las reservas y la vigencia para México requieren revisión separada. |
| Acuerdos interinstitucionales | Inventario separado pendiente. |

La consulta directa a la SRE devolvió una página de protección con HTTP 200 durante la prueba del piloto. El parser rechazó esa respuesta. El listado sigue registrado como fuente informativa y requiere un acceso automatizado autorizado antes de incorporarlo al actualizador. [Buscador de la SRE](https://cja.sre.gob.mx/tratadosmexico/buscador)

El 8 de noviembre de 2026 se completaron dos capturas y una reproducción sin red con `pypdf 6.21.4`. El Código conservó 291 páginas de texto, 437 fragmentos y la misma huella binaria. Las dos observaciones del depositario conservaron su huella de metadatos. La segunda captura obtuvo tres respuestas HTTP 304 y una HTTP 200. La verificación rechazó una copia del PDF alterada en un byte.

## Staging privado en Supabase

`database/legal_pilot_ingest.sql` prepara una fuente dedicada al Código y la función `public.legal_stage_pilot_ccom`. Requiere `legal_corpus.sql` y acceso de lectura a los metadatos de Storage. La cuenta que hace staging debe conservar el PDF exacto en el bucket privado `contracter-legal-private` y comprobar que el SHA-256 de los bytes archivados coincide con el manifiesto. La función verifica la ruta `contracter-legal-private/raw/<sha256>.pdf`, la presencia del objeto exacto y que el bucket sea privado. [Esquema de Storage](https://supabase.com/docs/guides/storage/schema/design)

La llamada privada a `POST /rest/v1/rpc/legal_stage_pilot_ccom` recibe `p_bundle` con el contenido de `ccom_candidate.json` y `p_original_storage_path` con la referencia del PDF archivado. El identificador de la ejecución y la huella hacen repetible el staging. La función guarda una versión candidata, comprueba las huellas de sus fragmentos y conserva la revisión pendiente. Cuando detecta un cambio en una fuente piloto aprobada, la vuelve a poner en revisión para retener la búsqueda de versiones anteriores hasta resolver el cambio.

### Carga puntual con la cuenta autorizada del proyecto

1. Generar `stage_ccom.sql` con `python legal_sources/sync_pilot.py --export-stage-sql`. El comando repite la extracción, compara el candidato con la captura guardada y devuelve las rutas locales del PDF y del SQL.
2. En Storage del proyecto autorizado, crear o seleccionar el bucket privado `contracter-legal-private`. Abrir la carpeta `raw` y subir el PDF cuyo nombre coincide con el SHA-256. Descargar el objeto desde esa misma sesión y comprobar que su SHA-256 coincide con la salida del exportador. [Storage desde el Dashboard](https://supabase.com/docs/guides/storage/quickstart)
3. Aplicar `database/legal_pilot_ingest.sql` en SQL Editor si la migración aún está pendiente. Ejecutar la consulta de `stage_ccom.sql` desde la misma cuenta con acceso ya autorizado. La respuesta esperada para la primera carga es `candidate_staged` y para repetirla, `already_staged`. Esta ruta usa la sesión del Dashboard. [SQL Editor](https://supabase.com/docs/guides/database/overview)

La prueba en PostgreSQL 17.5 usó una base desechable y metadatos simulados de Storage. Cargó el candidato oficial, mantuvo una versión y 437 fragmentos tras repetir la consulta y devolvió cero resultados jurídicos mientras la revisión estaba pendiente. También rechazó una ruta ausente, un bucket público, un rol sin permisos de lectura en Storage y un fragmento alterado.

El 13 de noviembre de 2026 se descargó el PDF del bucket privado de Contracter y se comprobó que su SHA-256 coincidía con el manifiesto. Supabase devolvió `candidate_staged`. La consulta posterior confirmó 437 fragmentos indexados, cero referencias verificadas, vigencia sin confirmar y revisión pendiente. La búsqueda de auditoría devolvió cero resultados de este candidato.

El Código sólo entra en `legal_search_fts` para consultas jurídicas tras revisar la fuente, la versión, las fechas de efectos y sus referencias. El inventario de tratados permanece como evidencia descriptiva y se guarda separado del corpus de búsqueda jurídica.

## Preparar la revisión jurídica

Desde `contracter`, indica los números de página del PDF que correspondan al caso que se evaluará.

```powershell
python legal_sources/sync_pilot.py --export-review-pages 1 2
```

Abre el HTML que devuelve el comando. La página 1 sirve para cotejar la identificación del documento. Selecciona además las páginas que contengan los artículos pertinentes. El HTML incluye el texto extraído, enlaces a esas páginas del PDF archivado, la ficha de reformas y las huellas del documento y los fragmentos. Conserva juntos los directorios `runs/` y `raw/` para abrir el PDF archivado desde el HTML. La exportación es local y conserva el estado pendiente.

El responsable jurídico debe confirmar la fuente, las fechas de efectos de la versión y su evidencia oficial. Para cada fragmento que vaya a citarse, debe cotejar el texto y registrar su localizador exacto, número y huella. La búsqueda puede limitarse a los fragmentos cotejados. La revisión del corpus y la aprobación de una versión de contrato son decisiones distintas.

El piloto exige una observación exitosa de la fuente dentro de las últimas 48 horas para devolver resultados aprobados. Si venció, ejecuta una captura nueva y vuelve a archivar y registrar el candidato según el procedimiento anterior. Una reproducción local conserva la fecha anterior. Si cambia el PDF o la ficha de reformas, el registro devuelve la fuente a revisión.

## Programación

La captura se puede invocar desde un programador con el mismo comando de uso manual. Devuelve un objeto JSON por la salida estándar con el resultado y la hora de registro. Interpreta el código de salida junto con el campo `status`.

| Código | Resultado | Acción del programador |
| --- | --- | --- |
| `0` | `complete` | Guardar el resultado y considerar el candidato para revisión. |
| `2` | `partial` o `failed` | Registrar los errores del manifiesto de esta ejecución. Conservar la última captura completa. |
| `1` | `failed`, con `run_id` nulo | Registrar el fallo operativo, por ejemplo, un directorio ocupado o una captura local dañada. |

El bloqueo por directorio permite una captura a la vez y el proceso libera el bloqueo al salir. `latest.json` sólo avanza cuando terminan las cuatro fuentes. El resultado `complete` mantiene al Código como candidato con revisión pendiente.

Para ejecutar la captura desde n8n Cloud se necesita un worker privado con Python y almacenamiento de originales. La frecuencia, el worker y el disparador de n8n quedan pendientes de instalación.
