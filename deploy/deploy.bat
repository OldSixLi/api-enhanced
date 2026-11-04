@echo off
:: 设置编码为 UTF-8，防止命令提示符中文乱码
chcp 65001 > nul
title 🚀 api-enhanced 后端自动化部署工具 - 智能交互版

:: =================【用户配置区域】=================
set SERVER_USER=root
set SERVER_IP=47.95.232.239
set LOCAL_PROJECT_DIR=D:\app\api-enhanced
set COMPRESS_FILE=api-enhanced-src.tar.gz
set REMOTE_UPLOAD_DIR=/tmp
set SERVICE_NAME=api-enhanced
set API_PORT=9999
:: 压缩包生成在项目父目录（D:\app）下：一是不在打包源内避免自包含，二是 bsdtar -f 不接受带盘符路径
set COMPRESS_FILE=api-enhanced-src.tar.gz
:: ==================================================

set SSH_CMD=ssh -o StrictHostKeyChecking=no %SERVER_USER%@%SERVER_IP%
set SCP_CMD=scp -o StrictHostKeyChecking=no

:MENU
cls
echo ==================================================
echo     🛠️  api-enhanced 后端自动化部署工具 v1.0
echo ==================================================
echo.
echo   [1] 🔄 完整流程 (unit同步-打包-上传-部署-自检) [默认]
echo   [2] 📦 仅打包并上传 (跳过服务器操作)
echo   [3] 🚀 仅服务器部署与自检 (需已完成上传)
echo   [4] ⚡ 仅重启服务并自检 (不动代码)
echo   [5] ❌ 退出脚本
echo.
echo ==================================================
:: 清空历史变量，防止上一次输入残留
set CHOICE=
set /p CHOICE=👉 请输入步骤编号 (1-5) [直接回车默认运行 1]: 

:: 直接回车默认运行完整流程
if "%CHOICE%"=="" set CHOICE=1

if "%CHOICE%"=="1" goto STEP_UNIT
if "%CHOICE%"=="2" goto STEP_TAR
if "%CHOICE%"=="3" goto STEP_DEPLOY
if "%CHOICE%"=="4" goto STEP_RESTART
if "%CHOICE%"=="5" goto REAL_END
echo ⚠️  输入错误，请输入 1-5 之间的数字！ && timeout /t 2 > nul && goto MENU

:: --------------------------------------------------
:: 步骤 0: 同步 systemd unit（幂等，包含内存护栏与 NODE_OPTIONS）
:: --------------------------------------------------
:STEP_UNIT
echo.
echo --------------------------------------------------
echo 🔧 [同步] 正在上传 systemd unit 并 daemon-reload...
echo --------------------------------------------------
%SCP_CMD% "%LOCAL_PROJECT_DIR%\deploy\api-enhanced.service" %SERVER_USER%@%SERVER_IP%:/etc/systemd/system/%SERVICE_NAME%.service
if %errorlevel% neq 0 (
    echo ❌ [错误] unit 文件上传失败！
    goto ERROR_END
)
%SSH_CMD% "systemctl daemon-reload"
if %errorlevel% neq 0 (
    echo ❌ [错误] daemon-reload 失败！
    goto ERROR_END
)
echo  ✅ systemd unit 已同步（含内存护栏 256M / 堆上限 128M）

:: --------------------------------------------------
:: 步骤 1: 本地打包源码
:: --------------------------------------------------
:STEP_TAR
echo.
echo --------------------------------------------------
echo 📦 [打包] 压缩源码（排除 node_modules / 数据库 / 密钥 / deploy）...
echo --------------------------------------------------
:: 必须先 cd 到项目父目录：bsdtar 的 -f 参数里出现 "D:" 会被当成 远程主机:文件 而报错，
:: 所以输出文件只能用相对路径（参照的原脚本也是这么绕开这个坑的）
cd /d "%LOCAL_PROJECT_DIR%\\.."
if exist %COMPRESS_FILE% del /q %COMPRESS_FILE%
tar -czf %COMPRESS_FILE% --exclude=node_modules --exclude=.git --exclude=.tmp --exclude="data/*.db" --exclude="data/*.db-shm" --exclude="data/*.db-wal" --exclude=data/anon-identities.json --exclude=deploy -C "%LOCAL_PROJECT_DIR%" .
if %errorlevel% neq 0 (
    echo ❌ [错误] 源码压缩失败！
    goto ERROR_END
)
echo  ✅ 压缩包生成成功：%CD%\\%COMPRESS_FILE%

:: --------------------------------------------------
:: 步骤 2: 上传到服务器
:: --------------------------------------------------
:STEP_UPLOAD
echo.
echo --------------------------------------------------
echo 📤 [上传] 正在上传到 %REMOTE_UPLOAD_DIR%/ ...
echo --------------------------------------------------
%SCP_CMD% %COMPRESS_FILE% %SERVER_USER%@%SERVER_IP%:%REMOTE_UPLOAD_DIR%/%COMPRESS_FILE%
if %errorlevel% neq 0 (
    echo ❌ [错误] 文件上传失败，请检查网络或服务器连接！
    goto ERROR_END
)
echo  ✅ 上传完成

:: --------------------------------------------------
:: 步骤 3: 服务器端部署（保留数据-替换代码-装依赖-重启-自检）
:: 逻辑在 deploy\remote-deploy.sh，经 stdin 传入远端 bash，避免 cmd 转义地狱
:: --------------------------------------------------
:STEP_DEPLOY
echo.
echo --------------------------------------------------
echo ⚡ [部署] 服务器端：保留数据-替换代码-装依赖-重启-自检...
echo --------------------------------------------------
%SSH_CMD% "bash -s" < "%LOCAL_PROJECT_DIR%\deploy\remote-deploy.sh"
if %errorlevel% neq 0 (
    echo ❌ [错误] 服务器端部署失败，请检查上方日志！
    goto ERROR_END
)
goto SUCCESS_END

:: --------------------------------------------------
:: 仅重启服务并自检
:: --------------------------------------------------
:STEP_RESTART
echo.
echo --------------------------------------------------
echo ⚡ [重启] 重启服务并自检...
echo --------------------------------------------------
%SSH_CMD% "bash -s" < "%LOCAL_PROJECT_DIR%\deploy\remote-restart.sh"
if %errorlevel% neq 0 (
    echo ❌ [错误] 重启或自检失败，请检查上方日志！
    goto ERROR_END
)
goto SUCCESS_END

:: ================= 部署成功清理 =================
:SUCCESS_END
if exist %COMPRESS_FILE% del /q %COMPRESS_FILE%
echo.
echo ==================================================
echo ✨ 🎉 恭喜！api-enhanced 已成功部署至 %SERVER_USER%@%SERVER_IP%
echo.
echo    后端直连（仅服务器本地）: http://127.0.0.1:%API_PORT%
echo    外部访问: http://%SERVER_IP%:8080/netapi/ma/...
echo    （8080 需 basic auth: music / ma1136）
echo ==================================================
goto HOLD_WINDOW

:ERROR_END
echo.
echo ⚠️  部署流程因错误中断，请检查上方日志。
echo.
echo [R] 返回主菜单 或 [Q] 退出脚本
set /p ERR_CHOICE=👉 请选择操作: 
if /i "%ERR_CHOICE%"=="R" goto MENU
goto HOLD_WINDOW

:HOLD_WINDOW
rem 统一终点拦截器，确保执行完绝不自动关闭窗口
echo.
echo ==================================================
echo 📌 提示：部署流程已结束。
echo ==================================================
pause
exit

:REAL_END
echo.
echo 👋 感谢使用，再见！
timeout /t 2 > nul
exit
