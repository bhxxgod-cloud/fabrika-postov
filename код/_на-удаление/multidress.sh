#!/bin/bash
# Оформление мультиаккаунтов: ава БЕЗ ЛИЦА + нейтральный ник.
# По одному с паузами: плотное оформление читается IG как перехват (урок 02-03.08).
cd "/Users/qq/Desktop/neironka-poster"
export DB_PUBLIC_URL="$(cat /tmp/dburl.txt)" LOCAL=1 SKIP_NAME=1 SKIP_BIO=1 DRESS_NICK=1 DRESS_NICK_FORCE=1
AVAS=(mood/2603251250553157.jpg city/arhitektura_image_10310221602265855458.jpg nature/1004211855338375.jpg mood/boke_0310211756021242.jpg)
i=0
for pair in "kade76559:glow.vibe.ru" "luka85199:look.daily.vibe" "andres8452090:beauty.mood.now" "cesar732146:style.vibe.daily"; do
  slug="${pair%%:*}"; nick="${pair##*:}"
  ava="/Users/qq/Desktop/avatars/${AVAS[$((i % 4))]}"
  echo "=== $slug → @$nick"
  DRESS_NICK_WANT="$nick" AVATAR_PATH="$ava" node dressup.cjs "$slug" 2>&1 | grep -E "НИК сменён|ава загружена|ИТОГ|⚠ ник|❌" | tail -4
  i=$((i+1))
  sleep 180
done
