@echo off
setlocal
where.exe node >nul 2>&1
if errorlevel 1 goto node_required
node -e "process.exit(Number(process.versions.node.split('.')[0]) < 24 ? 1 : 0)"
if errorlevel 1 goto node_required

rem El inicio rapido usa la muestra local y descarta la configuracion privada heredada.
set "CONTRACTER_MODE=mock"
set "CONTRACTER_PORT=8780"
set "CONTRACTER_SQLITE_PATH=%~dp0backend\data\mock.sqlite"
set "CONTRACTER_LEGAL_RAG_ENABLED=false"
set "CONTRACTER_OPERATOR_ENABLED=false"
set "ELEVENLABS_ENABLED=false"
for %%V in (
    CONTRACTER_DASHBOARD_TOKEN CONTRACTER_DASHBOARD_EVALUATION_CASE_ID
    CONTRACTER_ALLOWED_ORIGINS CONTRACTER_STORE_READ_TOKEN
    SUPABASE_URL SUPABASE_SECRET_KEY SUPABASE_SERVICE_ROLE_KEY
    LLM_API_KEY LLM_BASE_URL LLM_MODEL TELEGRAM_BOT_TOKEN N8N_BASE_URL
    ELEVENLABS_API_KEY ELEVENLABS_AGENT_ID ELEVENLABS_AGENT_BRANCH_ID
) do set "%%V="

echo Contracter DEMO: http://127.0.0.1:8780
echo Cierra esta ventana para detener el servidor.
node "%~dp0backend\server.mjs"
if not errorlevel 1 exit /b 0
echo No se pudo iniciar Contracter.
pause
exit /b 1

:node_required
echo Contracter necesita Node.js 24 o superior.
pause
exit /b 1
