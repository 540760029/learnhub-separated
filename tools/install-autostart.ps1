<#
  注册 / 移除 LearnHub 的三个开机自启计划任务：

    LearnHub-Backend    后端 node      → 127.0.0.1:8899
    LearnHub-Frontend   前端 node      → 127.0.0.1:5173
    LearnHub-Tunnel     cloudflared    → https://learn.lxf.life

  用法（普通用户权限即可，不需要管理员）：
    powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1
    powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Uninstall

  为什么用计划任务而不是会话里跑后台进程：
    1) 脱离终端会话，关掉终端 / 断开远程桌面不影响服务
    2) 进程意外退出时由任务计划程序自动拉起（每分钟重试）
    3) 登录即启动，无需手动开三个窗口

  注意：任务在「当前用户登录时」触发（LogonType Interactive），
        所以机器重启后需要有人登录一次，服务才会起来。
        若要求「未登录也运行」，需改用 -LogonType ServiceAccount（需要管理员且要存密码）。
#>
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$taskNames = @('LearnHub-Backend', 'LearnHub-Frontend', 'LearnHub-Tunnel')

if ($Uninstall) {
  foreach ($t in $taskNames) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $t -Confirm:$false
      Write-Host "已移除任务 $t"
    } else {
      Write-Host "任务 $t 不存在，跳过"
    }
  }
  return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$cloudflared = if ($env:CLOUDFLARED) { $env:CLOUDFLARED } else { Join-Path $env:USERPROFILE '.cloudflared\cloudflared.exe' }
$tunnelConfig = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
$tunnelName = 'learnhub'
$backendDir = Join-Path $root 'backend'
$frontendDir = Join-Path $root 'frontend'
$backendEnv = Join-Path $backendDir '.env'
$tunnelSupervisor = Join-Path $root 'tools\serve-tunnel.ps1'
$windowsPowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

foreach ($p in @($node, $windowsPowerShell, $cloudflared, $tunnelConfig, $backendEnv, $tunnelSupervisor)) {
  if (-not $p -or -not (Test-Path $p)) { throw "找不到需要的文件：$p" }
}

# 失败后每分钟重试；单次运行不限时长（服务是常驻进程）
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

function Register-LearnhubTask {
  # 注意：参数不能叫 $Args —— 那是 PowerShell 的自动变量，会被当成数组传进来
  param($Name, $Exe, $ArgLine, $WorkDir, $Description)
  $action = New-ScheduledTaskAction -Execute $Exe -Argument $ArgLine -WorkingDirectory $WorkDir
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Description $Description -Force | Out-Null
  Write-Host "已注册 $Name"
}

# 后端：直接调 node 并显式加载 .env（等价于 npm start，省掉 npm 这层壳）
Register-LearnhubTask -Name 'LearnHub-Backend' -Exe $node `
  -ArgLine "--env-file-if-exists=`"$backendEnv`" server.js" `
  -WorkDir $backendDir `
  -Description 'LearnHub 后端 API（Node + MySQL，8899）'

Register-LearnhubTask -Name 'LearnHub-Frontend' -Exe $node `
  -ArgLine 'server.js' `
  -WorkDir $frontendDir `
  -Description 'LearnHub 前端静态服务（5173）'

# 隧道：走守护脚本，而不是直接跑 cloudflared。
# 因为 cloudflared 在本机会自行退出（DNS resolver 超时 / 连通性预检报 region2 不可达），
# 由 serve-tunnel.ps1 负责落盘日志 + 退出后自动重启并退避。
Register-LearnhubTask -Name 'LearnHub-Tunnel' -Exe $windowsPowerShell `
  -ArgLine "-NoProfile -ExecutionPolicy Bypass -File `"$tunnelSupervisor`"" `
  -WorkDir $root `
  -Description 'LearnHub Cloudflare 隧道（learn.lxf.life，带守护与日志）'

Write-Host ''
Write-Host '三个任务已注册。立即启动：'
Write-Host "  Start-ScheduledTask -TaskName $($taskNames -join ', ')  # 或逐个启动"
Write-Host '查看状态：Get-ScheduledTask -TaskName LearnHub-* | Select TaskName,State'
