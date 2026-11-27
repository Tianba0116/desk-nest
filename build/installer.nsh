; 卸载时询问是否同时删除数据（R19.AC-6、D-09）。默认保留；覆盖安装升级时不询问、不删除。
!macro customUnInstall
  ${ifNot} ${isUpdated}
    SetShellVarContext current
    MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除你的数据？$\r$\n$\r$\n包括笔记、待办、事项、记忆、提醒、聊天记录和设置。$\r$\n数据位置：$APPDATA\desk-nest$\r$\n$\r$\n选择“否”会保留数据，重新安装后可以继续使用。" /SD IDNO IDYES deskNestDeleteData IDNO deskNestKeepData
    deskNestDeleteData:
      RMDir /r "$APPDATA\desk-nest"
    deskNestKeepData:
  ${endIf}
!macroend
