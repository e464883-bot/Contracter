$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Write-Host 'Contracter necesita Node.js 24 o superior. No se instaló ninguna herramienta.'
    Read-Host 'Presiona Enter para cerrar'
    exit 1
}
$nodeMajor = (& $nodeCommand.Source -p "process.versions.node.split('.')[0]")
if ([int]$nodeMajor -lt 24) {
    Write-Host 'Se requiere Node.js 24 o superior.'
    Read-Host 'Presiona Enter para cerrar'
    exit 1
}
$env:CONTRACTER_MODE = 'mock'
$env:CONTRACTER_PORT = '8780'
$env:CONTRACTER_SQLITE_PATH = Join-Path $projectRoot 'backend\data\mock.sqlite'
# El inicio rápido es una demostración aislada de cualquier .env o clave externa.
$env:CONTRACTER_DASHBOARD_TOKEN = ''
$env:SUPABASE_URL = ''
$env:SUPABASE_SECRET_KEY = ''
$env:SUPABASE_SERVICE_ROLE_KEY = ''
$env:CONTRACTER_ALLOWED_ORIGINS = ''
$env:LLM_API_KEY = ''
$env:LLM_BASE_URL = ''
$env:LLM_MODEL = ''
$env:TELEGRAM_BOT_TOKEN = ''
$env:N8N_BASE_URL = ''
$env:ELEVENLABS_ENABLED = 'false'
$env:CONTRACTER_LEGAL_RAG_ENABLED = 'false'
Set-Location -LiteralPath $projectRoot
Write-Host 'Contracter DEMO: http://127.0.0.1:8780'
Write-Host 'Abre esa dirección en tu navegador. Cierra esta ventana para detener el servidor.'
& $nodeCommand.Source (Join-Path $projectRoot 'backend\server.mjs')
if ($LASTEXITCODE -ne 0) {
    Read-Host 'No se pudo iniciar. Presiona Enter para cerrar'
    exit 1
}
