#!/bin/bash
# Сбор статистики циклом, а не кроном (06.08): крон на этом маке не имеет Full Disk Access,
# поэтому любые задачи с путём в ~/Desktop падают с EPERM и stats.cjs не выполнился ни разу.
cd "/Users/qq/Desktop/neironka-poster"
while true; do
  echo "=== $(date '+%F %T') сбор статистики"
  node stats.cjs 2>&1 | tail -4
  sleep 21600
done
