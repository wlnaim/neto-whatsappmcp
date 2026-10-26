# hook-notify.ps1 - Puente entre los hooks de Claude Code y el CLI de WhatsAppMCP.
# Compatible con PowerShell 5.1. Solo caracteres ASCII.
#
# Lee el JSON del hook por stdin, carga las variables del .env de la carpeta del proyecto (padre de examples)
# y se lo pasa por stdin a: node dist\cli.js hook
#
# Alternativa con Docker (sin Node en el host). OJO: el ENTRYPOINT de la imagen es el
# servidor MCP, por eso hay que reemplazarlo con --entrypoint:
#   docker run -i --rm --env-file C:\ruta\a\neto-whatsappmcp\.env `
#     --entrypoint node whatsapp-mcp dist/cli.js hook
#
# Siempre termina con exit 0 para no bloquear a Claude Code.

$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $PSScriptRoot
$EnvFile    = Join-Path $ProjectDir '.env'
$CliPath    = Join-Path $ProjectDir 'dist\cli.js'
$TimeoutMs  = 30000

try {
    try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
    $payload = [Console]::In.ReadToEnd()

    if (-not (Test-Path -LiteralPath $CliPath)) { exit 0 }

    if (Test-Path -LiteralPath $EnvFile) {
        foreach ($line in (Get-Content -LiteralPath $EnvFile -Encoding UTF8)) {
            $t = $line.Trim()
            if ($t.Length -eq 0 -or $t.StartsWith('#')) { continue }
            $idx = $t.IndexOf('=')
            if ($idx -lt 1) { continue }
            $key = $t.Substring(0, $idx).Trim()
            $val = $t.Substring($idx + 1).Trim()
            if ($val.Length -ge 2 -and (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) {
                $val = $val.Substring(1, $val.Length - 2)
            }
            Set-Item -LiteralPath ("Env:" + $key) -Value $val
        }
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'node'
    $psi.Arguments = '"' + $CliPath + '" hook'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = [System.Diagnostics.Process]::Start($psi)
    # PowerShell 5.1 no tiene StandardInputEncoding: se escribe UTF-8 sin BOM sobre el stream base
    $writer = New-Object System.IO.StreamWriter($proc.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding($false)))
    $writer.Write($payload)
    $writer.Flush()
    $writer.Close()
    $null = $proc.StandardOutput.ReadToEndAsync()
    $null = $proc.StandardError.ReadToEndAsync()

    if (-not $proc.WaitForExit($TimeoutMs)) {
        try { $proc.Kill() } catch { }
    }
} catch {
    # Un aviso fallido nunca debe bloquear a Claude Code
}

exit 0
