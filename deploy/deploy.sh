#!/usr/bin/env bash
# api-enhanced 部署脚本（在本地 Git Bash / Linux 下运行）
# 用法：bash deploy/deploy.sh
#
# 做的事：打包源码 → 上传 → 服务器解压 → 重装依赖（有变化时）→ 重启 systemd 服务
set -euo pipefail

SERVER="${SERVER:-root@47.95.232.239}"
REMOTE_DIR="/app/api-enhanced"
SSH="ssh -o StrictHostKeyChecking=no"
SCP="scp -o StrictHostKeyChecking=no"

cd "$(dirname "$0")/.."

# ---- systemd unit 同步 ----
# 内存护栏（MemoryLimit / ExecStartPre 写 cgroup 软限）和 NODE_OPTIONS 都写在 unit 里，
# 而 unit 不在源码包内，手工改过服务器就容易被下次部署遗忘。这里按内容哈希比对，有变化才更新。
echo "==> 同步 systemd unit"
UNIT_SRC="deploy/api-enhanced.service"
UNIT_DST="/etc/systemd/system/api-enhanced.service"
LOCAL_HASH=$(md5sum "$UNIT_SRC" | cut -d' ' -f1)
REMOTE_HASH=$($SSH "$SERVER" "md5sum $UNIT_DST 2>/dev/null | cut -d' ' -f1" || true)
if [ "$LOCAL_HASH" = "$REMOTE_HASH" ]; then
  echo "    无变化，跳过"
else
  $SCP "$UNIT_SRC" "$SERVER:$UNIT_DST"
  $SSH "$SERVER" 'systemctl daemon-reload'
  echo "    已更新并 daemon-reload"
fi

echo "==> 打包源码（排除 node_modules / .git / .tmp / 数据库）"
# 两个坑：① mktemp 在 Git Bash 下返回 C:\Users\... 带盘符路径，tar 会把 "C:" 当远程主机名；
#         ② 输出文件若放在项目内，tar 打包 . 时会把它自己读进去，报 "file changed as we read it"。
# 所以固定写到项目外的 /tmp（Git Bash 里同样可用）。
TMP_TAR="/tmp/.deploy-src.tar.gz"
trap 'rm -f "$TMP_TAR"' EXIT

pack_src() {
  tar -czf "$TMP_TAR" \
    --exclude=.deploy-src.tar.gz \
    --exclude=node_modules --exclude=.git --exclude=.tmp \
    --exclude="data/*.db" --exclude="data/*.db-shm" --exclude="data/*.db-wal" \
    --exclude=data/anon-identities.json --exclude=deploy \
    .
}
# Git Bash 的 tar 偶尔会因 fork 同步失败报 child_info::sync（Win32 error 0），重试一次即可
if ! pack_src; then
  echo "    tar 首次失败（Git Bash fork 偶发问题），重试一次"
  sleep 1
  pack_src
fi
echo "    $(du -h "$TMP_TAR" | cut -f1)"

echo "==> 上传"
$SCP "$TMP_TAR" "$SERVER:/tmp/api-enhanced.tar.gz"
rm -f "$TMP_TAR"

echo "==> 服务器端部署"
$SSH "$SERVER" 'bash -s' <<'REMOTE'
set -e
export PATH=/usr/local/node22/bin:/usr/bin:/bin
cd /app/api-enhanced

# 保留运行时数据：SQLite 缓存、匿名身份池、临时凭证
mkdir -p /tmp/ae-keep
cp -f data/comment-count.db*  /tmp/ae-keep/ 2>/dev/null || true
cp -f data/anon-identities.json /tmp/ae-keep/ 2>/dev/null || true
cp -rf .tmp /tmp/ae-keep/ 2>/dev/null || true

# 清空旧代码（保留 node_modules 以加速，后面 npm install 会增量处理）
find . -maxdepth 1 -mindepth 1 ! -name node_modules ! -name data -exec rm -rf {} +
tar -xzf /tmp/api-enhanced.tar.gz
rm -f /tmp/api-enhanced.tar.gz

mkdir -p data .tmp
cp -f /tmp/ae-keep/comment-count.db*  data/ 2>/dev/null || true
cp -f /tmp/ae-keep/anon-identities.json data/ 2>/dev/null || true
cp -rf /tmp/ae-keep/.tmp/. .tmp/ 2>/dev/null || true
rm -rf /tmp/ae-keep

printf 'registry=https://registry.npmmirror.com/\n' > .npmrc
npm install --omit=dev --ignore-scripts --no-audit --no-fund 2>&1 | tail -3

systemctl restart api-enhanced
sleep 3

# 4.1 进程存活
if ! systemctl is-active --quiet api-enhanced; then
  echo "!! 服务未启动，最近日志："
  tail -30 /var/log/api-enhanced.log 2>/dev/null || true
  exit 1
fi
echo "    systemd: active"

# 4.2 接口可用（轮询：Node 要加载全部路由模块 + 初始化身份池，固定 sleep 容易误判）
CODE=000
for i in $(seq 1 15); do
  CODE=$(curl -s -o /tmp/ae-health.json -w '%{http_code}' --max-time 6 http://127.0.0.1:9999/ma/anon/status || true)
  [ "$CODE" = "200" ] && break
  sleep 2
done
echo "    健康检查 HTTP=$CODE（第 $i 次探测）"
if [ "$CODE" != "200" ]; then
  echo "!! 健康检查失败，最近日志："
  tail -30 /var/log/api-enhanced.log 2>/dev/null || true
  exit 1
fi
cat /tmp/ae-health.json; echo

# 4.3 内存护栏是否还在（unit 同步会带上，这里确认值没被冲掉）
MEM=$(systemctl show api-enhanced -p MemoryCurrent 2>/dev/null | cut -d= -f2)
LIM=$(systemctl show api-enhanced -p MemoryLimit    2>/dev/null | cut -d= -f2)
echo "    内存 $(awk -v m="${MEM:-0}" 'BEGIN{printf "%.1f MB", m/1048576}') / 硬顶 $(awk -v l="${LIM:-0}" 'BEGIN{printf "%.0f MB", l/1048576}')"
REMOTE

echo "==> 完成"
