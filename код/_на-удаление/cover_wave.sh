#!/bin/bash
# ВОЛНА «ОБЛОЖКА ИЗ ТВОЕГО КАДРА» (06.08, приказ: 22 девочки + 6, примеры для владельца).
# COVER_REF=1: слайд 1 это его фото как есть (4:5), домашний кадр НЕ генерим.
# Из этого же кадра генерим ч/б арт с сердцами, локскрин собираем вёрсткой из нашего арта.
cd "/Users/qq/Desktop/neironka-poster"
export DB_PUBLIC_URL="$(cat /tmp/dburl.txt)"
export COVER_REF=1
for i in $(seq 1 120); do
  N=$(ls refs/typage/модель*.jpg 2>/dev/null | grep -v '_' | wc -l | tr -d ' ')
  [ "${N:-0}" -ge 1 ] && break
  sleep 20
done
LIST=$(ls refs/typage/модель*.jpg 2>/dev/null | grep -v '_')
echo "кадров найдено: $(echo "$LIST" | wc -l | tr -d ' ')"
for F in $LIST; do
  NAME=$(basename "$F" .jpg)
  echo "=== $NAME"
  cp "$F" "refs/${NAME}.jpg"
  node makepost.cjs "$NAME" hearts-trend 2>&1 | grep -vE "^\[|params" | tail -3
done
echo "ВОЛНА ПО ТВОИМ КАДРАМ ЗАВЕРШЕНА"
