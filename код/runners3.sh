#!/bin/bash
# ТРИ РАННЕРА ПАРАЛЛЕЛЬНО (06.08, приказ: «сделай чтобы 2-3 акка одновременно делали»).
# Можно безопасно: раннер берёт задачу атомарно (UPDATE ... FOR UPDATE SKIP LOCKED), поэтому
# три процесса делят очередь без пересечений. Каждый работает со СВОИМ акком и своим профилем
# GoLogin, двойных сессий на одном акке не возникает.
# Больше трёх не ставим: упрёмся в слоты GoLogin и в память маку.
cd "/Users/qq/Desktop/neironka-poster"
for N in 1 2 3; do
  LOG=/tmp/localrunner_$N.log
  if ! pgrep -f "RUNNER_ID=$N node localrunner.cjs" >/dev/null; then
    RUNNER_ID=$N nohup node localrunner.cjs >> "$LOG" 2>&1 &
    echo "поднят раннер $N (лог $LOG)"
    sleep 4
  fi
done
