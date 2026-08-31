#!/bin/bash
# ВОЛНА «ДЕВОЧКИ ПО НОМЕРАМ» (06.08, приказ: посты по кадрам владельца, называть номерами).
# 22 УНИКАЛЬНЫХ кадра (дедуп по перцептивному хэшу: из 27 файлов 5 оказались повторами).
# COVER_REF=1: слайд 1 это кадр владельца как есть, домашний кадр не генерим.
# Одна обложка = один пост: правило «заставка используется один раз» держится само.
cd "/Users/qq/Desktop/neironka-poster"
export DB_PUBLIC_URL="$(cat /tmp/dburl.txt)"
export COVER_REF=1
i=0
while read -r F; do
  [ -f "$F" ] || continue
  i=$((i+1))
  NAME=$(printf "девочка%02d" $i)
  cp "$F" "refs/${NAME}.jpg"
  echo "=== $NAME ← $F"
  node makepost.cjs "$NAME" hearts-trend 2>&1 | grep -vE "^\[|params" | tail -3
done < /tmp/uniq_covers.txt
echo "ВОЛНА ПО ДЕВОЧКАМ ЗАВЕРШЕНА: $i постов"
