#!/bin/bash
# ВОЛНА ПО ТИПАЖАМ (06.08, приказ: 22 девочки из скриншотов + 6 = 28 постов тренда).
# TYPAGE=1: от референса берём цвет и длину волос, макияж и вайб, ЛИЦО генерим новое.
# Чужое узнаваемое лицо в наш аккаунт не идёт: жалоба на подмену личности = терминальный бан.
cd "/Users/qq/Desktop/neironka-poster"
export DB_PUBLIC_URL="$(cat /tmp/dburl.txt)"
export TYPAGE=1
# Ждём, пока агент дочистит скриншоты от интерфейса и разложит по номерам.
for i in $(seq 1 90); do
  N=$(ls refs/typage/модель*.jpg 2>/dev/null | grep -v '_' | wc -l | tr -d ' ')
  [ "${N:-0}" -ge 1 ] && break
  sleep 20
done
LIST=$(ls refs/typage/модель*.jpg 2>/dev/null | grep -v '_')
echo "типажей найдено: $(echo "$LIST" | wc -l | tr -d ' ')"
for F in $LIST; do
  NAME=$(basename "$F" .jpg)
  echo "=== $NAME (типаж, лицо новое)"
  cp "$F" "refs/${NAME}.jpg"
  node makepost.cjs "$NAME" hearts-trend 2>&1 | grep -vE "^\[|params" | tail -3
done
echo "ВОЛНА ПО ТИПАЖАМ ЗАВЕРШЕНА"
