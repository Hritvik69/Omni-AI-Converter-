# Start OmniConvert AI locally without Docker (requires Postgres, Redis, MinIO on localhost).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "Checking dependencies on localhost..."
$ports = @{5432 = "Postgres"; 6379 = "Redis"; 9000 = "MinIO"}
foreach ($entry in $ports.GetEnumerator()) {
  $open = Test-NetConnection -ComputerName localhost -Port $entry.Key -WarningAction SilentlyContinue |
    Select-Object -ExpandProperty TcpTestSucceeded
  if (-not $open) {
    Write-Warning "$($entry.Value) is not reachable on port $($entry.Key). Install Docker Desktop and run 'docker compose up -d postgres redis minio create-bucket', or install each service manually."
  }
}

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing npm dependencies..."
  npm install
}

Write-Host "Syncing database schema..."
npx prisma db push

Write-Host "Starting API, worker, and web (each in a new window)..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$Root'; npm run dev -w @omniconvert/api"
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$Root'; npm run dev -w @omniconvert/worker"
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$Root'; npm run dev -w @omniconvert/web"

Write-Host "Done. Open http://localhost:3000 when the web server is ready."
