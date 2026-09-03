# Testa a autenticacao com a Efi (endpoint de homologacao) usando o certificado .p12
# Roda com: powershell -ExecutionPolicy Bypass -File testar-efi.ps1

$envPath = Join-Path $PSScriptRoot ".env"
Get-Content $envPath | ForEach-Object {
    if ($_ -match '^\s*([^#=]+)=(.*)$') {
        [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim())
    }
}

$certPath = Join-Path $PSScriptRoot ($env:EFI_CERT_PATH -replace '^\./', '')

Write-Host "Testando autenticacao na Efi (homologacao)..."
Write-Host "Certificado: $certPath"

Write-Host "--- Tentativa 1: JSON ---"
curl.exe -sS -w "`nHTTP_STATUS:%{http_code}`n" `
  -X POST "https://pix-h.api.efipay.com.br/oauth/token" `
  --cert-type P12 `
  --cert "${certPath}:" `
  -u "$($env:EFI_CLIENT_ID):$($env:EFI_CLIENT_SECRET)" `
  -H "Content-Type: application/json" `
  -d '{"grant_type": "client_credentials"}' 2>&1

Write-Host "`n--- Tentativa 2: form-urlencoded ---"
curl.exe -sS -w "`nHTTP_STATUS:%{http_code}`n" `
  -X POST "https://pix-h.api.efipay.com.br/oauth/token" `
  --cert-type P12 `
  --cert "${certPath}:" `
  -u "$($env:EFI_CLIENT_ID):$($env:EFI_CLIENT_SECRET)" `
  -H "Content-Type: application/x-www-form-urlencoded" `
  -d "grant_type=client_credentials" 2>&1
