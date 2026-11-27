; AutoCredit 从 Electron 版迁移到 Tauri 版时的安装前钩子。
; 目标：静默卸载旧版 Electron 应用，但保留 %APPDATA%\AutoCredit 下的配置、日志与密钥。
!macro NSIS_HOOK_PREINSTALL
  ; 结束可能仍在运行的旧版进程（含 Electron 子进程）
  nsExec::ExecToLog 'taskkill /IM AutoCredit.exe /F /T'

  ; 清除旧版 Electron 写入的开机自启项，新版启动后会按设置重新写入
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AutoCredit"

  ; 通过 electron-builder 的卸载信息静默卸载旧版
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\9a306f92-57d0-53be-904f-2e00aea31131" "QuietUninstallString"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\9a306f92-57d0-53be-904f-2e00aea31131" "QuietUninstallString"
  ${EndIf}
  ${If} $0 != ""
    DetailPrint "正在卸载旧版 Electron 应用..."
    ExecWait '$0'
  ${EndIf}
!macroend
