<#
  LearnHub Cloudflare 隧道守护脚本

  为什么需要它：
    cloudflared 在本机会在连上几分钟后自行退出（日志末尾是 DNS resolver 超时，
    且连通性预检报 region2 不可达）。这里做两件事：
      1) 把 cloudflared 的输出重定向到文件，便于事后定位（管道 + Tee 会让进程异常退出，
         这条坑旧项目的 serve-app.ps1 也踩过）
      2) 退出后自动重启，保证公网访问不长时间中断

  日志：tools\logs\tunnel-YYYYMMDD.{out,err}.log
        以及守护自身的 tools\logs\tunnel-supervisor.log（追加，不截断）
#>
$ErrorActionPreference = 'Continue'

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$cloudflared = if ($env:CLOUDFLARED) { $env:CLOUDFLARED } else { Join-Path $env:USERPROFILE '.cloudflared\cloudflared.exe' }
$config = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
$tunnelName = 'learnhub'
$supervisorLog = Join-Path $LogDir 'tunnel-supervisor.log'

function Write-Log([string]$msg) {
  Add-Content -Path $supervisorLog -Value ("[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] " + $msg) -Encoding UTF8
}

if (-not (Test-Path $cloudflared)) { Write-Log "FATAL: 找不到 cloudflared：$cloudflared"; exit 1 }
if (-not (Test-Path $config)) { Write-Log "FATAL: 找不到隧道配置：$config"; exit 1 }

Write-Log "supervisor 启动"
Write-Log ("cloudflared = " + $cloudflared)
Write-Log ("config      = " + $config)

$attempt = 0
$backoff = 5

while ($true) {
  $attempt = $attempt + 1
  $stamp = Get-Date -Format 'yyyyMMdd'
  $out = Join-Path $LogDir ("tunnel-" + $stamp + ".out.log")
  $err = Join-Path $LogDir ("tunnel-" + $stamp + ".err.log")

  Write-Log ("--- 启动隧道（第 " + $attempt + " 次）---")

  $p = Start-Process -FilePath $cloudflared `
    -ArgumentList @('tunnel', '--no-autoupdate', '--config', $config, 'run', $tunnelName) `
    -WorkingDirectory (Join-Path $env:USERPROFILE '.cloudflared') `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err `
    -NoNewWindow -PassThru

  if (-not $p) {
    Write-Log "Start-Process 没有返回进程，10 秒后重试"
    Start-Sleep -Seconds 10
    continue
  }

  Write-Log ("隧道 pid = " + $p.Id + "，等待退出")
  $p.WaitForExit()
  $code = $p.ExitCode
  Write-Log ("隧道退出（exit=" + $code + "），" + $backoff + " 秒后重启")

  Start-Sleep -Seconds $backoff
  # 连续快速失败时逐步退避，最多 60 秒，避免疯狂重启打满日志
  if ($backoff -lt 60) { $backoff = $backoff + 5 }
}
