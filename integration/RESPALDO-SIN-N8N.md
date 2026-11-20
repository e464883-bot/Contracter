# Ejecutar Contracter sin n8n Cloud

Este respaldo ejecuta Telegram V2 desde una computadora con Node.js 24 e Internet.
Puedes descargarlo [del repositorio](https://github.com/e464883-bot/Contracter).
GitHub guarda el código y puede publicar el panel estático. La computadora
ejecuta el bot y debe seguir encendida. El respaldo conserva Supabase como
almacén de expedientes y Gemini Free como proveedor para evaluaciones.

## Preparar el archivo privado

Abre PowerShell en la raíz del proyecto, donde están `backend` e `integration`.
Haz una copia de la plantilla y ábrela en el Bloc de notas.

```powershell
Copy-Item .env.standby.example .env.standby
notepad .env.standby
```

Si ya existe `.env.standby`, abre ese archivo directamente. Llena los campos con
los valores del bot, del chat privado, del usuario autorizado y de la clave de
Gemini. Para conservar tus expedientes, usa la URL de `contracter-store` del
mismo proyecto de Supabase y dos tokens vigentes de Contracter, uno con alcance
`telegram` y el otro con alcance `audit`. El valor de cada token se pega sin
el prefijo `Bearer`. Mantén `.env.standby` en tu equipo.

## Probar y cambiar de servidor

1. Ejecuta `node --test backend/telegram-standby.test.mjs` para probar el flujo
   con servicios simulados, sin consumir cuota del modelo.
2. Ejecuta `node --env-file=.env.standby backend/telegram-standby.mjs --check`
   para consultar el estado del webhook en Telegram. Si n8n sigue atendiendo el
   bot, el respaldo quedará apagado. Para probar la conexión antes del cambio,
   puedes usar otro bot con su propio chat y credenciales fuera de producción.
3. Cuando decidas cambiar, despublica en n8n el disparador activo de Telegram y
   ejecuta de nuevo `--check`. Telegram requiere que el bot quede sin webhook
   antes de empezar a consultar mensajes pendientes. Si todavía aparece activo,
   revisa la configuración del disparador antes de seguir.
4. Para arrancar, ejecuta
   `node --env-file=.env.standby backend/telegram-standby.mjs --run`.
   En el chat autorizado, prueba `/estado`, envía un contrato de prueba en `.txt`
   y haz una pregunta. Puedes auditar el expediente con `/auditar`, consultar
   los reportes y restablecer el chat con `/reset`. Verifica esta secuencia antes
   de cancelar n8n Cloud.
5. Para volver a n8n, detén el proceso local con `Ctrl+C` y vuelve a publicar
   el disparador de Telegram.

Advertencia. Contracter está trabajando con Gemini Free. Puede cometer errores.
Las cuotas de Gemini y Supabase siguen aplicando. La disponibilidad de fuentes
depende de la versión instalada de `contracter-store`. La aprobación formal de
un contrato requiere fuentes revisadas y revisión humana.

## Conservar la V1

Los flujos de prueba de auditoría y consulta se pueden importar en n8n desde
[`n8n_workflows/`](../n8n_workflows/). El export de Telegram por comandos está en
[`integration/n8n/live_telegram.json`](n8n/live_telegram.json). Si quieres volver
a editar los flujos visualmente fuera de n8n Cloud, esos JSON se pueden importar
en una [instalación propia de n8n](https://docs.n8n.io/deploy/host-n8n/).
