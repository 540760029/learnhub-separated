<#
  LearnHub 一键启动：后端(8899) + 前端(5173) + Cloudflare 隧道

  用法（在仓库根目录执行）：
    powershell -ExecutionPolicy Bypass -File tools\start-all.ps1

  停止：关掉弹出的三个窗口即可。

  前置条件：
    1) backend\.env 已配好 LEARNHUB_DB_URL 与 LEARNHUB_SECRET
    2) 隧道配置已就位：%USERPROFILE%\.cloudflared\config.yml
       （模板见 tools\cloudflared.config.example.yml）
    3) cloudflared.exe 可用。默认找 %USERPROFILE%\.cloudflared\cloudflared.exe，
       也可用环境变量 CLOUDFLARED 指定路径。
#>
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$cloudflared = if ($env:CLOUDFLARED) { $env:CLOUDFLARED } else { Join-Path $env:USERPROFILE '.cloudflared\cloudflared.exe' }
$tunnelConfig = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
$tunnelName = 'learnhub'

function Assert-Path($p, $what) {
  if (-not (Test-Path $p)) { throw "找不到$what：$p" }
}

Assert-Path (Join-Path $root 'backend\server.js') '后端入口'
Assert-Path (Join-Path $root 'frontend\server.js') '前端入口'
Assert-Path (Join-Path $root 'backend\.env') '后端 .env（请先从 .env.example 复制）'
Assert-Path $cloudflared 'cloudflared.exe（可用环境变量 CLOUDFLARED 指定）'
Assert-Path $tunnelConfig '隧道配置'

Write-Host '[1/3] 后端  -> http://127.0.0.1:8899'
Start-Process cmd.exe -ArgumentList '/k', 'title LearnHub 后端 && npm start' `
  -WorkingDirectory (Join-Path $root 'backend')

Write-Host '[2/3] 前端  -> http://127.0.0.1:5173'
Start-Process cmd.exe -ArgumentList '/k', 'title LearnHub 前端 && npm start' `
  -WorkingDirectory (Join-Path $root 'frontend')

# 等本机两个服务起来，隧道一连上就有回源目标了
Start-Sleep -Seconds 3

Write-Host '[3/3] 隧道  -> https://learn.lxf.life'
Start-Process $cloudflared -ArgumentList 'tunnel', '--no-autoupdate', '--config', $tunnelConfig, 'run', $tunnelName

Write-Host ''
Write-Host '三个进程已启动。关闭对应窗口即可停止。'
Write-Host '验证分流是否生效（离线试跑，无需上线）：'
Write-Host "  & '$cloudflared' tunnel --config `"$tunnelConfig`" ingress rule https://learn.lxf.life/api/courses"
