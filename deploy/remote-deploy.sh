#!/usr/bin/env bash
# api-enhanced 服务器端完整部署（由本地 deploy.bat 通过 `ssh "bash -s" < 本文件` 调起）
# 职责：保留运行时数据 → 替换代码 → 恢复数据 → 装依赖 → 重启 → 自检
# 注意：REMOTE_DIR / API_PORT 与 deploy.bat 配置区保持一致
set -e
set -o pipefail
export PATH=/usr/local/node22/bin:/usr/bin:/bin

cd /app/api-enhanced

echo "==> 保留运行时数据（SQLite 缓存 / 匿名身份池 / 临时凭证）"
mkdir -p /tmp/ae-keep
cp -f data/comment-count.db*  /tmp/ae-keep/ 2>/dev/null || true
cp -f data/anon-identities.json /tmp/ae-keep/ 2>/dev/null || true
cp -rf .tmp /tmp/ae-keep/ 2>/dev/null || true

echo "==> 清空旧代码（保留 node_modules 与 data）"
find . -maxdepth 1 -mindepth 1 ! -name node_modules ! -name data -exec rm -rf {} +

echo "==> 解压新代码"
tar -xzf /tmp/api-enhanced-src.tar.gz
rm -f /tmp/api-enhanced-src.tar.gz

echo "==> 恢复运行时数据"
mkdir -p data .tmp
cp -f /tmp/ae-keep/comment-count.db*  data/ 2>/dev/null || true
cp -f /tmp/ae-keep/anon-identities.json data/ 2>/dev/null || true
cp -rf /tmp/ae-keep/.tmp/. .tmp/ 2>/dev/null || true
rm -rf /tmp/ae-keep

echo "==> 安装依赖（npmmirror，跳过 dev 与脚本）"
printf 'registry=https://registry.npmmirror.com/\n' > .npmrc
npm install --omit=dev --ignore-scripts --no-audit --no-fund 2>&1 | tail -3

echo "==> 重启服务"
systemctl restart api-enhanced
sleep 3

# ---------- 自检 ----------
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

mem=$(systemctl show api-enhanced -p MemoryCurrent 2>/dev/null | cut -d= -f2)
lim=$(systemctl show api-enhanced -p MemoryLimit    2>/dev/null | cut -d= -f2)
awk -v m="${mem:-0}" -v l="${lim:-0}" 'BEGIN{printf "内存 %.1f MB / 硬顶 %.0f MB\n", m/1048576, l/1048576}'
echo "REMOTE_DEPLOY_OK"
