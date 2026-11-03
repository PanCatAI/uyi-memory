#!/bin/zsh
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci
open "http://127.0.0.1:4340" &
node --disable-warning=ExperimentalWarning server.mjs
