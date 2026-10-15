#!/usr/bin/env bash
# ant-batch-visit.sh — 用「有头」Ant 指纹浏览器批量访问指定 URL（经本地 Launch API）
#
# 用法:
#   ./ant-batch-visit.sh [URL] [次数]
#   VISITS=5 KEEP=1 ./ant-batch-visit.sh https://example.com/
#
# 常用环境变量:
#   ANT_API      Launch API 地址            (默认 http://127.0.0.1:19876)
#   VISITS       访问次数 = 实例数           (默认 3)
#   DELAY        每次访问停留秒数            (默认 8)
#   PROXY_URL    代理地址(留空=直连)         (默认 flame 轮换)
#   PROXY_ID     代理在 Ant 中的 id          (默认 flame 的 id；见下方说明)
#   CORE_ID      浏览器内核 id               (留空=自动取现有 profile 的)
#   NAME_PREFIX  新建 profile 名前缀         (默认 batch)
#   KEEP         1=跑完不清理(保留实例与profile)
#
# 说明:
#   * 有头是默认行为——API 启动的实例就是桌面上的有头窗口。
#   * 同一 profile 重复启动是幂等的；本脚本为每次访问新建一个 profile。
#   * 结束时自动 stop + delete 本次创建的 profile（KEEP=1 可关闭）。
#   * PROXY_ID 可留空，但部分版本需要与 PROXY_URL 匹配的既有代理 id；
#     可在 Ant 界面「代理」页查看，或从 GET /api/profiles 里已有 profile 的 proxyId 取。
set -uo pipefail

API="${ANT_API:-http://127.0.0.1:19876}"
URL="${1:-${TARGET_URL:-https://blog.20231106.xyz/posts/2026-04-09/reasoning-models-slow-thinking-2026/}}"
VISITS="${2:-${VISITS:-3}}"
DELAY="${DELAY:-8}"
PROXY_URL="${PROXY_URL:-http://flmb0279c28-package-standard:8f7bd52e@proxy.flameproxies.com:8989}"
PROXY_ID="${PROXY_ID:-proxy-1791956972868-u27ov1}"
CORE_ID="${CORE_ID:-}"
NAME_PREFIX="${NAME_PREFIX:-batch}"
KEEP="${KEEP:-0}"
FP_BASE=(--fingerprint-brand=Chrome --fingerprint-platform=windows --lang=en-US --accept-lang=en-US,en
         --timezone=America/Los_Angeles --window-size=1920,1080 --fingerprint-hardware-concurrency=8
         --disable-non-proxied-udp --fingerprinting-canvas-image-data-noise --fingerprinting-client-rects-noise)

say(){ printf '%s\n' "$*"; }
jstr(){ printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
jnum(){ printf '%s' "$1" | grep -o "\"$2\":[0-9]*"        | head -1 | cut -d: -f2; }
jbool(){ printf '%s' "$1" | grep -o "\"$2\":[a-z]*"       | head -1 | cut -d: -f2; }

command -v curl >/dev/null 2>&1 || { say "缺少 curl"; exit 1; }
say "API   = $API"
say "URL   = $URL"
say "次数  = $VISITS   停留 = ${DELAY}s   KEEP=$KEEP"

H=$(curl -sS --max-time 8 "$API/api/health" 2>/dev/null)
[ -n "$H" ] || { say "!! 无法连接 $API —— 请确认 Ant-Browser 正在运行且已开启 API 服务"; exit 1; }
say "health: $H"

PROFILES_JSON=$(curl -sS --max-time 10 "$API/api/profiles" 2>/dev/null)
if [ -z "$CORE_ID" ]; then
  CORE_ID=$(printf '%s' "$PROFILES_JSON" | grep -o '"coreId":"[^"]*"' | head -1 | cut -d'"' -f4)
fi
[ -n "$CORE_ID" ] || { say "!! 无法自动探测 coreId（库里没有现成 profile），请用 CORE_ID=... 指定"; exit 1; }
say "coreId = $CORE_ID"
say "proxy  = ${PROXY_URL:-（直连）}  (proxyId=${PROXY_ID:-空})"

codes=(); ids=(); names=()

cleanup(){
  if [ "$KEEP" = "1" ]; then say "（KEEP=1：保留实例与 profile，不清理）"; return; fi
  say "--- 清理本次创建的实例与 profile ---"
  local i
  for i in "${!codes[@]}"; do
    curl -sS --max-time 40 -X POST "$API/api/runtime/stop" -H 'Content-Type: application/json' \
      -d "{\"code\":\"${codes[$i]}\"}" >/dev/null 2>&1
  done
  sleep 2
  for i in "${!ids[@]}"; do
    r=$(curl -sS --max-time 12 -X DELETE "$API/api/profiles/${ids[$i]}" 2>/dev/null)
    say "  delete ${names[$i]} -> ${r:-（无响应）}"
  done
}
trap cleanup EXIT

say "--- 创建并启动 $VISITS 个有头实例 ---"
for i in $(seq 1 "$VISITS"); do
  name="${NAME_PREFIX}-$i"; dir="${NAME_PREFIX}-$i"; seed=$((479973100 + i))
  fp="[\"--fingerprint=$seed\""
  for a in "${FP_BASE[@]}"; do fp="$fp,\"$a\""; done
  fp="$fp]"

  body="{\"profile\":{\"profileName\":\"$name\",\"userDataDir\":\"$dir\",\"coreId\":\"$CORE_ID\",
    \"fingerprintArgs\":$fp,\"proxyId\":\"$PROXY_ID\",\"proxyConfig\":\"$PROXY_URL\",
    \"launchArgs\":[\"--disable-sync\",\"--no-first-run\"],\"tags\":[\"$NAME_PREFIX\"],\"keywords\":[]}}"

  cr=$(curl -sS --max-time 15 -X POST "$API/api/profiles" -H 'Content-Type: application/json' -d "$body" 2>/dev/null)
  code=$(jstr "$cr" launchCode); pid=$(jstr "$cr" profileId)
  if [ -z "$code" ] || [ -z "$pid" ]; then say "  [$i] 创建失败: $cr"; continue; fi
  codes+=("$code"); ids+=("$pid"); names+=("$name")

  lr=$(curl -sS --max-time 90 -X POST "$API/api/launch" -H 'Content-Type: application/json' \
        -d "{\"code\":\"$code\",\"startUrls\":[\"$URL\"],\"skipDefaultStartUrls\":true}" 2>/dev/null)
  ok=$(jbool "$lr" ok); dp=$(jnum "$lr" debugPort)
  say "  [$i] $name  code=$code  ok=$ok  debugPort=${dp:-0}  pid=$(jnum "$lr" pid)"
  [ "$ok" = "true" ] || say "       !! 启动异常: $lr"
done

say "--- 停留 ${DELAY}s（让有头窗口完成加载 / 广告请求）---"
sleep "$DELAY"

say "--- 运行中的实例 ---"
act=$(curl -sS --max-time 10 "$API/api/runtime/active" 2>/dev/null)
say "  active=$(jbool "$act" active)  running=$(jbool "$act" running)  pid=$(jnum "$act" pid)  debugPort=$(jnum "$act" debugPort)"
say "--- 各实例状态 ---"
for i in "${!ids[@]}"; do
  st=$(curl -sS --max-time 8 "$API/api/profiles/${ids[$i]}/status" 2>/dev/null)
  say "  ${names[$i]}: running=$(jbool "$st" running) pid=$(jnum "$st" pid) debugPort=$(jnum "$st" debugPort)"
done
say "--- 完成（退出时自动清理；要保留请用 KEEP=1）---"
