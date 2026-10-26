# Configure-WhatsAppMCP.ps1 - Ventana de configuracion de WhatsAppMCP.
# Compatible con PowerShell 5.1. Solo caracteres ASCII.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File C:\ruta\a\neto-whatsappmcp\Configure-WhatsAppMCP.ps1
#
# Lee y escribe el archivo .env que esta junto a este script. Prueba la conexion con
# Evolution API y, opcionalmente, reinicia el contenedor con "docker compose up -d".
#
# -SelfTest ejecuta las funciones de lectura, validacion y escritura contra un .env de
# prueba (carpeta -SelfTestDir) y sale sin abrir la ventana. No toca el .env real.

[CmdletBinding()]
param(
    [switch]$SelfTest,
    [string]$SelfTestDir
)

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:EnvPath = Join-Path $ProjectDir '.env'

# Campo de la ventana -> variable del .env
$script:FieldMap = [ordered]@{
    Url      = 'EVOLUTION_BASE_URL'
    ApiKey   = 'EVOLUTION_API_KEY'
    Instance = 'EVOLUTION_INSTANCE'
    Me       = 'WHATSAPP_ME'
    Team     = 'WHATSAPP_TEAM'
    Timeout  = 'EVOLUTION_TIMEOUT_MS'
    Port     = 'MCP_PORT'
}

# ---------------------------------------------------------------------------
# Logica (sin UI)
# ---------------------------------------------------------------------------

function New-DefaultSettings {
    return @{
        Url      = 'http://localhost:8080'
        ApiKey   = ''
        Instance = 'WhatsAppService'
        Me       = ''
        Team     = ''
        Timeout  = '30000'
        Port     = '8787'
        Extra    = (New-Object System.Collections.Specialized.OrderedDictionary)
    }
}

# Lee un .env y devuelve los campos conocidos mas las claves desconocidas en Extra.
# Si el archivo no existe devuelve los valores por defecto.
function Read-EnvFile {
    param([string]$Path)
    $s = New-DefaultSettings
    if (-not (Test-Path -LiteralPath $Path)) { return $s }
    foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        $t = $line.Trim()
        if ($t.Length -eq 0 -or $t.StartsWith('#')) { continue }
        $idx = $t.IndexOf('=')
        if ($idx -lt 1) { continue }
        $key = $t.Substring(0, $idx).Trim()
        $val = $t.Substring($idx + 1).Trim()
        if ($val.Length -ge 2 -and (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        $field = $null
        foreach ($f in $script:FieldMap.Keys) {
            if ($script:FieldMap[$f] -eq $key) { $field = $f; break }
        }
        if ($field) {
            # Un valor vacio no pisa un default no vacio (URL, instancia, timeout, puerto)
            if ($val.Length -gt 0 -or $s[$field].Length -eq 0) { $s[$field] = $val }
        } else {
            $s.Extra[$key] = $val
        }
    }
    return $s
}

function Test-WaTarget {
    param([string]$Value)
    return (($Value -match '^\d+$') -or ($Value -match '^\d+@s\.whatsapp\.net$') -or ($Value -match '^\d+(-\d+)?@g\.us$'))
}

# Devuelve la lista de errores de validacion (vacia si todo es correcto).
function Test-Settings {
    param([hashtable]$Settings)
    $errors = New-Object System.Collections.ArrayList

    $uri = $null
    $url = [string]$Settings.Url
    if (-not [Uri]::TryCreate($url.Trim(), [UriKind]::Absolute, [ref]$uri) -or ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https')) {
        [void]$errors.Add('La URL de Evolution debe empezar con http:// o https:// (ej. http://localhost:8080).')
    }
    if ([string]::IsNullOrWhiteSpace([string]$Settings.ApiKey)) { [void]$errors.Add('La API key es obligatoria.') }
    if ([string]::IsNullOrWhiteSpace([string]$Settings.Instance)) { [void]$errors.Add('La instancia es obligatoria.') }

    $port = 0
    $portText = ([string]$Settings.Port).Trim()
    if (-not ($portText -match '^\d{1,5}$') -or -not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        [void]$errors.Add('El puerto del MCP debe ser un entero entre 1 y 65535.')
    }
    $timeout = 0
    $timeoutText = ([string]$Settings.Timeout).Trim()
    if (-not ($timeoutText -match '^\d{1,9}$') -or -not [int]::TryParse($timeoutText, [ref]$timeout) -or $timeout -lt 1 -or $timeout -gt 600000) {
        [void]$errors.Add('El timeout debe ser un entero entre 1 y 600000 (milisegundos).')
    }

    $me = ([string]$Settings.Me).Trim()
    if ($me.Length -gt 0 -and -not (Test-WaTarget $me)) {
        [void]$errors.Add('Mi numero debe ser solo digitos con codigo de pais o un JID (@s.whatsapp.net / @g.us).')
    }
    foreach ($item in ([string]$Settings.Team).Split(',')) {
        $x = $item.Trim()
        if ($x.Length -gt 0 -and -not (Test-WaTarget $x)) {
            [void]$errors.Add('Equipo: cada elemento debe ser solo digitos o un JID (@s.whatsapp.net / @g.us).')
            break
        }
    }

    $all = @($Settings.Url, $Settings.ApiKey, $Settings.Instance, $Settings.Me, $Settings.Team, $Settings.Timeout, $Settings.Port)
    foreach ($k in $Settings.Extra.Keys) { $all += $Settings.Extra[$k]; $all += $k }
    foreach ($v in $all) {
        if (([string]$v) -match '[\r\n]') {
            [void]$errors.Add('Ningun campo puede contener saltos de linea.')
            break
        }
    }
    return $errors.ToArray()
}

# Escribe el .env (UTF-8 sin BOM, saltos LF). Si ya existe, lo respalda como .env.bak.
# Devuelve la ruta completa escrita.
function Write-EnvFile {
    param([string]$Path, [hashtable]$Settings)
    $full = [System.IO.Path]::GetFullPath($Path)
    if (Test-Path -LiteralPath $full) {
        Copy-Item -LiteralPath $full -Destination ($full + '.bak') -Force
    }
    $team = (@(([string]$Settings.Team).Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })) -join ','

    $L = New-Object System.Collections.ArrayList
    [void]$L.Add('# WhatsAppMCP - configuracion generada por Configure-WhatsAppMCP.ps1')
    [void]$L.Add('# Archivo local, NO se versiona. Puedes editarlo a mano; la ventana lo vuelve a leer al abrirse.')
    [void]$L.Add('')
    [void]$L.Add('# URL de Evolution API tal como se ve desde tu maquina (el host), ej. http://localhost:8080.')
    [void]$L.Add('# Dentro de Docker, localhost y 127.0.0.1 se traducen solos a host.docker.internal.')
    [void]$L.Add('# Una Evolution remota (https://evo.midominio.com) se usa sin traduccion.')
    [void]$L.Add('EVOLUTION_BASE_URL=' + ([string]$Settings.Url).Trim())
    [void]$L.Add('')
    [void]$L.Add('# API key de Evolution. Es un secreto: no la compartas ni la subas a ningun repositorio.')
    [void]$L.Add('EVOLUTION_API_KEY=' + ([string]$Settings.ApiKey).Trim())
    [void]$L.Add('')
    [void]$L.Add('# Nombre de la instancia de WhatsApp en Evolution.')
    [void]$L.Add('EVOLUTION_INSTANCE=' + ([string]$Settings.Instance).Trim())
    [void]$L.Add('')
    [void]$L.Add('# Tu numero: solo digitos con codigo de pais (ej. 5219831234567) o JID. Alias "me".')
    [void]$L.Add('WHATSAPP_ME=' + ([string]$Settings.Me).Trim())
    [void]$L.Add('')
    [void]$L.Add('# Equipo: numeros o JID de grupo (@g.us) separados por coma. Alias "team".')
    [void]$L.Add('WHATSAPP_TEAM=' + $team)
    [void]$L.Add('')
    [void]$L.Add('# Timeout, en milisegundos, de las llamadas a Evolution.')
    [void]$L.Add('EVOLUTION_TIMEOUT_MS=' + ([string]$Settings.Timeout).Trim())
    [void]$L.Add('')
    [void]$L.Add('# Puerto del MCP en modo HTTP: ahi se conecta Claude Code (http://127.0.0.1:<puerto>/mcp).')
    [void]$L.Add('# No es el puerto de Evolution (normalmente 8080); son servicios distintos.')
    [void]$L.Add('MCP_PORT=' + ([string]$Settings.Port).Trim())
    if ($Settings.Extra.Count -gt 0) {
        [void]$L.Add('')
        [void]$L.Add('# Otras variables (conservadas tal cual).')
        foreach ($k in $Settings.Extra.Keys) { [void]$L.Add($k + '=' + $Settings.Extra[$k]) }
    }
    $text = ($L -join "`n") + "`n"
    [System.IO.File]::WriteAllText($full, $text, (New-Object System.Text.UTF8Encoding($false)))
    return $full
}

# GET {url}/instance/connectionState/{instancia}. Devuelve @{ Ok; State; Message }.
# Nunca incluye la API key en el mensaje.
function Test-EvolutionConnection {
    param([string]$Url, [string]$Instance, [string]$ApiKey, [int]$TimeoutSec = 10)
    $result = @{ Ok = $false; State = ''; Message = '' }
    $uri = $Url.Trim().TrimEnd('/') + '/instance/connectionState/' + [Uri]::EscapeDataString($Instance.Trim())
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec -Headers @{ apikey = $ApiKey } -Uri $uri -ErrorAction Stop
        $state = ''
        try { $state = [string](($resp.Content | ConvertFrom-Json).instance.state) } catch { }
        if ($state) {
            $result.Ok = $true
            $result.State = $state
            $result.Message = 'Estado: ' + $state
        } else {
            $result.Message = 'Respuesta inesperada: Evolution no devolvio el estado de la instancia.'
        }
    } catch {
        $ex = $_.Exception
        $code = 0
        if ($ex -and $ex.Response) { try { $code = [int]$ex.Response.StatusCode } catch { } }
        if ($code -eq 401 -or $code -eq 403) { $result.Message = 'API key rechazada (HTTP ' + $code + ').' }
        elseif ($code -eq 404) { $result.Message = 'URL o instancia no encontrada (HTTP 404).' }
        elseif ($code -gt 0) { $result.Message = 'Evolution respondio con error HTTP ' + $code + '.' }
        else { $result.Message = 'No se pudo conectar a la URL.' }
    }
    return $result
}

# Ejecuta docker con los argumentos dados y devuelve @{ ExitCode; Output }.
function Invoke-Docker {
    param([string]$Arguments, [string]$WorkDir)
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) { return @{ ExitCode = -1; Output = 'Docker no esta instalado o no esta en el PATH.' } }
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath $docker.Source -ArgumentList $Arguments -WorkingDirectory $WorkDir -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        $o = (Get-Content -LiteralPath $outFile -Raw -Encoding UTF8)
        $e = (Get-Content -LiteralPath $errFile -Raw -Encoding UTF8)
        $text = ("$o$e").Trim()
        return @{ ExitCode = $p.ExitCode; Output = $text }
    } catch {
        return @{ ExitCode = -1; Output = 'No se pudo ejecutar docker: ' + $_.Exception.Message }
    } finally {
        Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# Ventana
# ---------------------------------------------------------------------------

function Add-FormLabel {
    param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H = 20, [bool]$Help = $false)
    $l = New-Object System.Windows.Forms.Label
    $l.AutoSize = $false
    $l.Text = $Text
    $l.Location = New-Object System.Drawing.Point($X, $Y)
    $l.Size = New-Object System.Drawing.Size($W, $H)
    if ($Help) { $l.ForeColor = [System.Drawing.Color]::DimGray }
    $Parent.Controls.Add($l)
    return $l
}

function Add-FormTextBox {
    param($Parent, [int]$X, [int]$Y, [int]$W, [string]$Text)
    $t = New-Object System.Windows.Forms.TextBox
    $t.Location = New-Object System.Drawing.Point($X, $Y)
    $t.Size = New-Object System.Drawing.Size($W, 22)
    $t.Text = $Text
    $Parent.Controls.Add($t)
    return $t
}

function Add-FormButton {
    param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$W)
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Text
    $b.Location = New-Object System.Drawing.Point($X, $Y)
    $b.Size = New-Object System.Drawing.Size($W, 28)
    $Parent.Controls.Add($b)
    return $b
}

function Set-Status {
    param([string]$Text, [string]$Kind = 'info')
    $c = [System.Drawing.Color]::Black
    if ($Kind -eq 'ok') { $c = [System.Drawing.Color]::DarkGreen }
    elseif ($Kind -eq 'error') { $c = [System.Drawing.Color]::Firebrick }
    $script:ui.Status.ForeColor = $c
    $script:ui.Status.Text = $Text
    [System.Windows.Forms.Application]::DoEvents()
}

function Get-FormSettings {
    $s = New-DefaultSettings
    $s.Url = $script:ui.Url.Text.Trim()
    $s.ApiKey = $script:ui.ApiKey.Text.Trim()
    $s.Instance = $script:ui.Instance.Text.Trim()
    $s.Me = $script:ui.Me.Text.Trim()
    $s.Team = $script:ui.Team.Text.Trim()
    $s.Timeout = $script:ui.Timeout.Text.Trim()
    $s.Port = $script:ui.Port.Text.Trim()
    $s.Extra = $script:LoadedExtra
    return $s
}

function Invoke-ConnectionTest {
    $s = Get-FormSettings
    $uri = $null
    if (-not [Uri]::TryCreate($s.Url, [UriKind]::Absolute, [ref]$uri) -or ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https')) {
        Set-Status 'La URL de Evolution debe empezar con http:// o https://' 'error'
        return
    }
    if ([string]::IsNullOrWhiteSpace($s.Instance)) {
        Set-Status 'La instancia es obligatoria.' 'error'
        return
    }
    Set-Status 'Probando conexion...' 'info'
    $script:ui.Form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
    try {
        $r = Test-EvolutionConnection -Url $s.Url -Instance $s.Instance -ApiKey $s.ApiKey
    } finally {
        $script:ui.Form.Cursor = [System.Windows.Forms.Cursors]::Default
    }
    if ($r.Ok) { Set-Status $r.Message 'ok' } else { Set-Status $r.Message 'error' }
}

# Valida y guarda. Devuelve $true si escribio el .env.
function Invoke-Save {
    $s = Get-FormSettings
    $errs = @(Test-Settings -Settings $s)
    if ($errs.Count -gt 0) {
        Set-Status ($errs -join [Environment]::NewLine) 'error'
        return $false
    }
    try {
        $full = Write-EnvFile -Path $script:EnvPath -Settings $s
    } catch {
        Set-Status ('No se pudo guardar: ' + $_.Exception.Message) 'error'
        return $false
    }
    Set-Status ('Guardado en ' + $full) 'ok'
    return $true
}

function Invoke-SaveAndRestart {
    if (-not (Invoke-Save)) { return }
    $saved = $script:ui.Status.Text
    $script:ui.Log.Text = ''
    $script:ui.Form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
    try {
        Set-Status ($saved + [Environment]::NewLine + 'Ejecutando docker compose up -d ...') 'ok'
        $up = Invoke-Docker -Arguments 'compose up -d' -WorkDir $ProjectDir
        $log = '> docker compose up -d' + [Environment]::NewLine + $up.Output
        if ($up.ExitCode -ne 0) {
            $script:ui.Log.Text = $log
            if ($up.ExitCode -eq -1) {
                Set-Status ($saved + [Environment]::NewLine + 'No se pudo reiniciar: ' + $up.Output) 'error'
            } else {
                Set-Status ($saved + [Environment]::NewLine + 'docker compose termino con codigo ' + $up.ExitCode + '. Revisa la salida.') 'error'
            }
            return
        }
        $ps = Invoke-Docker -Arguments 'ps --filter name=whatsapp_mcp --format "{{.Names}} {{.Status}} {{.Ports}}"' -WorkDir $ProjectDir
        $log = $log + [Environment]::NewLine + [Environment]::NewLine + '> docker ps --filter name=whatsapp_mcp' + [Environment]::NewLine + $ps.Output
        $script:ui.Log.Text = ($log -replace "`r?`n", "`r`n")
        Set-Status ($saved + [Environment]::NewLine + 'Contenedor actualizado.') 'ok'
    } finally {
        $script:ui.Form.Cursor = [System.Windows.Forms.Cursors]::Default
    }
}

function New-ConfigForm {
    $cur = Read-EnvFile -Path $script:EnvPath
    $script:LoadedExtra = $cur.Extra
    $script:ui = @{}

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'WhatsAppMCP - Configuracion'
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.ClientSize = New-Object System.Drawing.Size(560, 640)
    $script:ui.Form = $form

    $lx = 15; $tx = 190; $tw = 355

    [void](Add-FormLabel $form 'URL de Evolution API:' $lx 18 170)
    $script:ui.Url = Add-FormTextBox $form $tx 15 $tw $cur.Url

    [void](Add-FormLabel $form 'API key:' $lx 53 170)
    $script:ui.ApiKey = Add-FormTextBox $form $tx 50 275 $cur.ApiKey
    $script:ui.ApiKey.UseSystemPasswordChar = $true
    $chk = New-Object System.Windows.Forms.CheckBox
    $chk.Text = 'Mostrar'
    $chk.Location = New-Object System.Drawing.Point(475, 50)
    $chk.Size = New-Object System.Drawing.Size(75, 22)
    $chk.Add_CheckedChanged({ $script:ui.ApiKey.UseSystemPasswordChar = (-not $script:ui.ShowKey.Checked) })
    $form.Controls.Add($chk)
    $script:ui.ShowKey = $chk

    [void](Add-FormLabel $form 'Instancia:' $lx 88 170)
    $script:ui.Instance = Add-FormTextBox $form $tx 85 $tw $cur.Instance

    [void](Add-FormLabel $form 'Mi numero (WHATSAPP_ME):' $lx 123 170)
    $script:ui.Me = Add-FormTextBox $form $tx 120 $tw $cur.Me
    [void](Add-FormLabel $form 'Solo digitos con codigo de pais, ej. 5219831234567' $tx 144 $tw 18 $true)

    [void](Add-FormLabel $form 'Equipo (WHATSAPP_TEAM):' $lx 173 170)
    $script:ui.Team = Add-FormTextBox $form $tx 170 $tw $cur.Team
    [void](Add-FormLabel $form 'Numeros o JID de grupo (@g.us) separados por coma' $tx 194 $tw 18 $true)

    [void](Add-FormLabel $form 'Timeout (ms):' $lx 223 170)
    $script:ui.Timeout = Add-FormTextBox $form $tx 220 120 $cur.Timeout

    [void](Add-FormLabel $form 'Puerto del MCP (HTTP):' $lx 258 170)
    $script:ui.Port = Add-FormTextBox $form $tx 255 120 $cur.Port
    [void](Add-FormLabel $form 'Donde se conecta Claude Code: http://127.0.0.1:<puerto>/mcp' $tx 279 $tw 18 $true)

    $bTest = Add-FormButton $form 'Probar conexion' 15 315 115
    $bSave = Add-FormButton $form 'Guardar' 140 315 85
    $bRestart = Add-FormButton $form 'Guardar y reiniciar contenedor' 235 315 205
    $bClose = Add-FormButton $form 'Cerrar' 450 315 95
    $bTest.Add_Click({ Invoke-ConnectionTest })
    $bSave.Add_Click({ [void](Invoke-Save) })
    $bRestart.Add_Click({ Invoke-SaveAndRestart })
    $bClose.Add_Click({ $script:ui.Form.Close() })

    $st = Add-FormLabel $form '' 15 355 530 110
    $script:ui.Status = $st

    $log = New-Object System.Windows.Forms.TextBox
    $log.Multiline = $true
    $log.ReadOnly = $true
    $log.ScrollBars = 'Both'
    $log.WordWrap = $false
    $log.Font = New-Object System.Drawing.Font('Consolas', 9)
    $log.Location = New-Object System.Drawing.Point(15, 470)
    $log.Size = New-Object System.Drawing.Size(530, 120)
    $form.Controls.Add($log)
    $script:ui.Log = $log

    [void](Add-FormLabel $form '8080 = Evolution API; 8787 = puerto del MCP para Claude Code. Son servicios distintos.' 15 600 530 20 $true)
    return $form
}

# ---------------------------------------------------------------------------
# Autoprueba (sin abrir la ventana)
# ---------------------------------------------------------------------------

$script:Fail = 0
function Assert-Check {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    if ($Condition) { Write-Output ('PASS  ' + $Name) }
    else { $script:Fail++; Write-Output ('FAIL  ' + $Name + $(if ($Detail) { '  -> ' + $Detail } else { '' })) }
}

function Invoke-SelfTestRun {
    param([string]$Dir)
    if (-not $Dir) { $Dir = Join-Path ([System.IO.Path]::GetTempPath()) 'WhatsAppMCP-cfg-test' }
    [void](New-Item -ItemType Directory -Force -Path $Dir)
    $realEnv = Join-Path $ProjectDir '.env'
    $realSettings = Read-EnvFile -Path $realEnv   # solo lectura
    Write-Output ('Carpeta de prueba: ' + $Dir)

    # --- Read-EnvFile ---
    $src = Join-Path $Dir 'in.env'
    $sample = @(
        '# comentario',
        'EVOLUTION_BASE_URL="http://localhost:9090"',
        "EVOLUTION_API_KEY='abc123'",
        '',
        'EVOLUTION_INSTANCE=Inst1',
        'WHATSAPP_ME=5219831234567',
        'WHATSAPP_TEAM=111,222@s.whatsapp.net',
        'EVOLUTION_TIMEOUT_MS=15000',
        'MCP_PORT=9999',
        'MCP_HOST=0.0.0.0',
        'CUSTOM_VAR=hola'
    ) -join "`n"
    [System.IO.File]::WriteAllText($src, $sample + "`n", (New-Object System.Text.UTF8Encoding($false)))
    $r = Read-EnvFile -Path $src
    Assert-Check 'Read-EnvFile: URL sin comillas' ($r.Url -eq 'http://localhost:9090') $r.Url
    Assert-Check 'Read-EnvFile: key sin comillas simples' ($r.ApiKey -eq 'abc123')
    Assert-Check 'Read-EnvFile: instancia, me, team, timeout, puerto' (($r.Instance -eq 'Inst1') -and ($r.Me -eq '5219831234567') -and ($r.Team -eq '111,222@s.whatsapp.net') -and ($r.Timeout -eq '15000') -and ($r.Port -eq '9999'))
    Assert-Check 'Read-EnvFile: claves desconocidas en Extra' (($r.Extra.Count -eq 2) -and ($r.Extra['MCP_HOST'] -eq '0.0.0.0') -and ($r.Extra['CUSTOM_VAR'] -eq 'hola'))
    $d = Read-EnvFile -Path (Join-Path $Dir 'no-existe.env')
    Assert-Check 'Read-EnvFile: sin archivo devuelve defaults' (($d.Url -eq 'http://localhost:8080') -and ($d.Instance -eq 'WhatsAppService') -and ($d.Timeout -eq '30000') -and ($d.Port -eq '8787') -and ($d.ApiKey -eq '') -and ($d.Me -eq '') -and ($d.Team -eq ''))

    # --- Test-Settings ---
    $ok = New-DefaultSettings; $ok.ApiKey = 'k'
    Assert-Check 'Test-Settings: defaults + key son validos' (@(Test-Settings -Settings $ok).Count -eq 0)
    $cases = @(
        @{ N = 'URL sin esquema http/https (ftp)'; F = 'Url'; V = 'ftp://x' },
        @{ N = 'URL sin esquema (localhost:8080)'; F = 'Url'; V = 'localhost:8080' },
        @{ N = 'URL vacia'; F = 'Url'; V = '' },
        @{ N = 'key vacia'; F = 'ApiKey'; V = '  ' },
        @{ N = 'instancia vacia'; F = 'Instance'; V = '' },
        @{ N = 'puerto 0'; F = 'Port'; V = '0' },
        @{ N = 'puerto 70000'; F = 'Port'; V = '70000' },
        @{ N = 'puerto no numerico'; F = 'Port'; V = 'abc' },
        @{ N = 'timeout 0'; F = 'Timeout'; V = '0' },
        @{ N = 'timeout no numerico'; F = 'Timeout'; V = '30s' },
        @{ N = 'timeout 600001'; F = 'Timeout'; V = '600001' },
        @{ N = 'ME con letras'; F = 'Me'; V = 'abc' },
        @{ N = 'ME con +'; F = 'Me'; V = '+5219831234567' },
        @{ N = 'TEAM con elemento invalido'; F = 'Team'; V = '123,abc' },
        @{ N = 'salto de linea en la key'; F = 'ApiKey'; V = "k`nOTRA=1" }
    )
    foreach ($c in $cases) {
        $t = New-DefaultSettings; $t.ApiKey = 'k'; $t[$c.F] = $c.V
        Assert-Check ('Test-Settings rechaza: ' + $c.N) (@(Test-Settings -Settings $t).Count -gt 0)
    }
    $good = @(
        @{ N = 'URL https remota'; F = 'Url'; V = 'https://evo.midominio.com' },
        @{ N = 'ME con JID de usuario'; F = 'Me'; V = '5219831234567@s.whatsapp.net' },
        @{ N = 'TEAM numeros y JID de grupo'; F = 'Team'; V = '5219831234567, 120363012345678901@g.us,' },
        @{ N = 'puerto 65535'; F = 'Port'; V = '65535' },
        @{ N = 'timeout 600000'; F = 'Timeout'; V = '600000' }
    )
    foreach ($c in $good) {
        $t = New-DefaultSettings; $t.ApiKey = 'k'; $t[$c.F] = $c.V
        Assert-Check ('Test-Settings acepta: ' + $c.N) (@(Test-Settings -Settings $t).Count -eq 0)
    }

    # --- Write-EnvFile ---
    $out = Join-Path $Dir '.env'
    Remove-Item -LiteralPath $out, ($out + '.bak') -Force -ErrorAction SilentlyContinue
    $w = Read-EnvFile -Path $src
    $w.Team = '111, 222@s.whatsapp.net,'
    $path1 = Write-EnvFile -Path $out -Settings $w
    Assert-Check 'Write-EnvFile: devuelve la ruta completa' ($path1 -eq [System.IO.Path]::GetFullPath($out)) $path1
    Assert-Check 'Write-EnvFile: sin .bak en la primera escritura' (-not (Test-Path -LiteralPath ($out + '.bak')))
    $bytes = [System.IO.File]::ReadAllBytes($out)
    Assert-Check 'Write-EnvFile: sin BOM' (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF))
    $nonAscii = @($bytes | Where-Object { $_ -gt 127 }).Count
    Assert-Check 'Write-EnvFile: contenido ASCII' ($nonAscii -eq 0)
    Assert-Check 'Write-EnvFile: saltos LF sin CR' (-not (@($bytes | Where-Object { $_ -eq 13 }).Count))
    $txt = [System.IO.File]::ReadAllText($out)
    Assert-Check 'Write-EnvFile: comentario sobre traduccion en Docker' ($txt -match 'host\.docker\.internal')
    $back = Read-EnvFile -Path $out
    Assert-Check 'Write-EnvFile: ida y vuelta de los campos' (($back.Url -eq $w.Url) -and ($back.ApiKey -eq 'abc123') -and ($back.Instance -eq 'Inst1') -and ($back.Me -eq '5219831234567') -and ($back.Timeout -eq '15000') -and ($back.Port -eq '9999'))
    Assert-Check 'Write-EnvFile: TEAM normalizado' ($back.Team -eq '111,222@s.whatsapp.net') $back.Team
    Assert-Check 'Write-EnvFile: conserva claves desconocidas' (($back.Extra['MCP_HOST'] -eq '0.0.0.0') -and ($back.Extra['CUSTOM_VAR'] -eq 'hola'))
    $w.Port = '8788'
    [void](Write-EnvFile -Path $out -Settings $w)
    Assert-Check 'Write-EnvFile: segunda escritura crea .env.bak con el contenido previo' ((Test-Path -LiteralPath ($out + '.bak')) -and ((Read-EnvFile -Path ($out + '.bak')).Port -eq '9999'))
    Assert-Check 'Write-EnvFile: segunda escritura aplica el cambio' ((Read-EnvFile -Path $out).Port -eq '8788')

    # --- Test-EvolutionConnection (real, solo lectura del .env real) ---
    $realKey = [string]$realSettings.ApiKey
    if (-not (Test-Path -LiteralPath $realEnv)) {
        Write-Output 'SKIP  Test-EvolutionConnection real: no existe el .env real'
    } elseif ($realKey.Length -eq 0) {
        Assert-Check 'Test-EvolutionConnection: el .env real tiene API key' $false 'no hay EVOLUTION_API_KEY en el .env real'
    } else {
        $realUrl = [string]$realSettings.Url
        $realInstance = [string]$realSettings.Instance
        $c1 = Test-EvolutionConnection -Url $realUrl -Instance $realInstance -ApiKey $realKey
        Write-Output ('      real          -> ' + $c1.Message)
        Assert-Check 'Test-EvolutionConnection: key real devuelve open' (($c1.Ok -eq $true) -and ($c1.State -eq 'open')) $c1.Message
        $c2 = Test-EvolutionConnection -Url $realUrl -Instance $realInstance -ApiKey 'clave-incorrecta-xyz'
        Write-Output ('      key mala      -> ' + $c2.Message)
        Assert-Check 'Test-EvolutionConnection: key incorrecta -> API key rechazada' (($c2.Ok -eq $false) -and ($c2.Message -like '*API key rechazada*')) $c2.Message
        $c3 = Test-EvolutionConnection -Url $realUrl -Instance 'InstanciaQueNoExiste' -ApiKey $realKey
        Write-Output ('      instancia mala-> ' + $c3.Message)
        Assert-Check 'Test-EvolutionConnection: instancia inexistente -> no encontrada' (($c3.Ok -eq $false) -and ($c3.Message -like '*no encontrada*')) $c3.Message
        Assert-Check 'Test-EvolutionConnection: los mensajes no contienen la key' (-not (($c1.Message + $c2.Message + $c3.Message).Contains($realKey)))
    }
    $c4 = Test-EvolutionConnection -Url 'http://127.0.0.1:1' -Instance 'x' -ApiKey 'k' -TimeoutSec 3
    Write-Output ('      sin conexion  -> ' + $c4.Message)
    Assert-Check 'Test-EvolutionConnection: puerto cerrado -> No se pudo conectar' (($c4.Ok -eq $false) -and ($c4.Message -like '*No se pudo conectar*')) $c4.Message

    # --- Invoke-Docker (solo lectura; nunca levanta contenedores) ---
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Output 'SKIP  Invoke-Docker: docker no esta en el PATH'
    } else {
        $dv = Invoke-Docker -Arguments 'version --format {{.Client.Version}}' -WorkDir $ProjectDir
        Write-Output ('      docker version -> ' + $dv.Output)
        Assert-Check 'Invoke-Docker: version -> ExitCode 0 y salida no vacia' (($dv.ExitCode -eq 0) -and ($dv.Output.Length -gt 0)) ('ExitCode=' + $dv.ExitCode + ' ' + $dv.Output)
        $dc = Invoke-Docker -Arguments 'compose config --quiet' -WorkDir $ProjectDir
        Assert-Check 'Invoke-Docker: compose config --quiet (sin salida) -> ExitCode 0' ($dc.ExitCode -eq 0) ('ExitCode=' + $dc.ExitCode + ' ' + $dc.Output)
    }

    # --- Ventana (sin mostrarla): carga del .env y guardado via los mismos handlers ---
    try {
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing
        $script:EnvPath = Join-Path $Dir 'form.env'
        Remove-Item -LiteralPath $script:EnvPath, ($script:EnvPath + '.bak') -Force -ErrorAction SilentlyContinue
        Copy-Item -LiteralPath $src -Destination $script:EnvPath -Force
        $f = New-ConfigForm
        Assert-Check 'Ventana: carga valores del .env' (($script:ui.Url.Text -eq 'http://localhost:9090') -and ($script:ui.ApiKey.Text -eq 'abc123') -and ($script:ui.Port.Text -eq '9999'))
        Assert-Check 'Ventana: API key oculta por defecto' ($script:ui.ApiKey.UseSystemPasswordChar -eq $true)
        $script:ui.Port.Text = '70000'
        $saved = Invoke-Save
        Assert-Check 'Ventana: Guardar rechaza puerto invalido y no escribe' (($saved -eq $false) -and ((Read-EnvFile -Path $script:EnvPath).Port -eq '9999'))
        $script:ui.Port.Text = '8790'
        $saved = Invoke-Save
        Assert-Check 'Ventana: Guardar escribe y conserva MCP_HOST' (($saved -eq $true) -and ((Read-EnvFile -Path $script:EnvPath).Port -eq '8790') -and ((Read-EnvFile -Path $script:EnvPath).Extra['MCP_HOST'] -eq '0.0.0.0'))
        Assert-Check 'Ventana: estado "Guardado en <ruta>" sin la key' (($script:ui.Status.Text -like 'Guardado en *form.env') -and (-not $script:ui.Status.Text.Contains('abc123')))
        $f.Dispose()
        Remove-Item -LiteralPath $script:EnvPath -Force
        $f3 = New-ConfigForm
        Assert-Check 'Ventana: sin .env muestra defaults' (($script:ui.Url.Text -eq 'http://localhost:8080') -and ($script:ui.Instance.Text -eq 'WhatsAppService') -and ($script:ui.Timeout.Text -eq '30000') -and ($script:ui.Port.Text -eq '8787') -and ($script:ui.ApiKey.Text -eq ''))
        $f3.Dispose()
    } catch {
        Assert-Check 'Ventana: construccion sin errores' $false $_.Exception.Message
    }

    Write-Output ''
    if ($script:Fail -eq 0) { Write-Output 'SELFTEST OK' } else { Write-Output ('SELFTEST CON FALLAS: ' + $script:Fail) }
}

# ---------------------------------------------------------------------------
# Inicio
# ---------------------------------------------------------------------------

if ($SelfTest) {
    Invoke-SelfTestRun -Dir $SelfTestDir
    if ($script:Fail -eq 0) { exit 0 } else { exit 1 }
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$mainForm = New-ConfigForm
[void]$mainForm.ShowDialog()
