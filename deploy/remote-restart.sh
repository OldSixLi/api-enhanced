#!/usr/bin/env bash
# api-enhanced 仅重启 + 自检（由本地 deploy.bat 通过 `ssh "bash -s" < 本文件` 调起）
# 适用：只想重启服务、不动代码的场景
set -e
set -o pipefail
export PATH=/usr/local/node22/bin:/usr/bin:/bin

echo "==> 重启服务"
systemctl restart api-enhanced
sleep 3

if ! systemctl is-active --quiet api-enhanced; then
  echo "!! 服务未启动，最近日志："
  tail -30 /var/log/api-enhanced.log 2>/dev/null || true
  exit 1
fi
echo "systemd: active"

code=000
i=0
for i in $(seq 1 15); do
  code=$(curl -s -o /tmp/ae-health.json -w '%{http_code}' --max-time 6 http://127.0.0.1:9999/ma/anon/status || true)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "健康检查 HTTP=$code（第 $i 次探测）"
if [ "$code" != "200" ]; then
  echo "!! 健康检查失败，最近日志："
  tail -30 /var/log/api-enhanced.log 2>/dev/null || true
  exit 1
fi
cat /tmp/ae-health.json; echo
echo "REMOTE_RESTART_OK"
