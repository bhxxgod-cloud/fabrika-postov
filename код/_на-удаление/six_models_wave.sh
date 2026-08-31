#!/bin/bash
# ВТОРАЯ ЧАСТЬ СЧЁТА (06.08): 22 поста по кадрам владельца + ЭТИ 6 по нашим моделям = 28.
# Ждём, пока освободится конвейер после волны по девочкам, и идём своими моделями.
cd "/Users/qq/Desktop/neironka-poster"
export DB_PUBLIC_URL="$(cat /tmp/dburl.txt)"
for i in $(seq 1 240); do
  pgrep -f devochki_wave.sh >/dev/null || break
  sleep 30
done
for P in Дарья Карина Полина Мия Тати Анечка; do
  echo "=== НАША МОДЕЛЬ: $P"
  node makepost.cjs "$P" hearts-trend 2>&1 | grep -vE "^\[|params" | tail -3
done
echo "ШЕСТЁРКА НАШИХ МОДЕЛЕЙ ГОТОВА"
