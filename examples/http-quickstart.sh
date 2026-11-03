#!/usr/bin/env bash
# 用 curl 走一遍本机 HTTP 服务（假模型，不花钱）。在仓库根目录跑：bash examples/http-quickstart.sh
set -euo pipefail
DATA=$(mktemp -d)
LLM_PROVIDER=mock node --disable-warning=ExperimentalWarning bin/uyi-memory.mjs serve --port 4350 --data "$DATA" &
PID=$!; trap 'kill $PID; rm -rf "$DATA"' EXIT
sleep 1
U=http://127.0.0.1:4350/v1
J='Content-Type: application/json'
curl -s $U/health; echo
SPACE=$(curl -s -H "$J" -d "{\"name\":\"我的房间\",\"userName\":\"小林\",\"scene\":$(cat examples/room.scene.json)}" $U/spaces | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
echo "space: $SPACE"
curl -s -H "$J" -d '{}' $U/spaces/$SPACE/session/open > /dev/null
REPLY=$(curl -s -H "$J" -d '{"character":"rin","text":"这个红杯子是我奶奶留下的，帮我好好收着"}' $U/spaces/$SPACE/chat)
echo "$REPLY" | node -pe 'const r=JSON.parse(require("fs").readFileSync(0)); `玲：${r.say}  (turn ${r.turnId})`'
TURN=$(echo "$REPLY" | node -pe 'JSON.parse(require("fs").readFileSync(0)).turnId')
curl -s -X POST $U/turns/$TURN/delivered > /dev/null
curl -s -H "$J" -d '{}' $U/spaces/$SPACE/session/close > /dev/null
sleep 1
curl -s $U/spaces/$SPACE/characters/rin/memory | node -pe 'JSON.parse(require("fs").readFileSync(0)).facts.map(f => `记得：${f.object}`).join("\n")'
