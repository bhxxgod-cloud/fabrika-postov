#!/bin/zsh
# ВОЛНА-2 (22.08): 150 постов с новыми локациями. 25 девочек × топ-6:
# милы (14, проход 3) + пины (11, проход 1). Фазы: 0 пересборка n02-гайда (долг);
# 1 обложки новых локаций; 2 плитки пинам; 3 сборка; 4 добор дырок; 5 манифест + итог в ТГ.
# ВАЖНО: имена переменных ТОЛЬКО ASCII — кириллица в zsh не присваивается и молча
# превращается в глоб (память: kirillica-v-bash, этим был убит дожим 21.08).
S=~/Desktop/НЕЙРОНКА/РИЛСЫ-НОВАЯ-СХЕМА/_скрипты
OUT="$HOME/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ"
LOG="$OUT/_волна2.log"
TOP="img-beauty-guide,img-nose-verdict,img-haircut-match,img-brow-map,img-makeup-colortype,img-boyfriend-match"
MILAS=(мила-d01 мила-p01 мила-p02 мила-p03 мила-p04 мила-p05 мила-p07 мила-p08 мила-p09 мила-p10 мила-n01 мила-n02 мила-n03 мила-n04)
PINS=(пин-01 пин-02 пин-03 пин-04 пин-05 пин-06 пин-07 пин-08 пин-09 пин-10 пин-11)
cd /Users/qq/Desktop/neironka-poster
echo "=== $(date) волна-2 старт" >> "$LOG"

# ФАЗА 0: долг — пересборка n02-гайда со свежим хуком
rm -f "$OUT/мила-n02/мила-n02-beauty-guide-p2".*
rm -rf "$OUT/мила-n02/_кадры/мила-n02-beauty-guide-p2"
COVER_REUSE=1 TPLS="img-beauty-guide" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" мила-n02 2 2>&1 | grep -E "^(OK|FAIL|ИТОГО)" >> "$OUT/_сборка.log"
echo "$(date +%H:%M) фаза 0: n02-гайд пересобран" >> "$LOG"

# ФАЗА 1: обложки новых локаций, 3 круга (провайдер может штормить)
ALLG="${(j:,:)MILAS},${(j:,:)PINS}"
for round in 0 1 2; do
  RETRY_SHIFT=$round GIRLS="$ALLG" node "$S/covers_newloc.cjs" >> "$LOG" 2>&1
  holes=0
  for g in $MILAS $PINS; do
    n=$(ls ~/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН/$g 2>/dev/null | grep -cE 'обложка-(москва|питер|дубай|бали)-2')
    (( holes += 8 - n ))
  done
  echo "$(date +%H:%M) фаза 1 круг $round: дырок $holes" >> "$LOG"
  [ "$holes" -le 0 ] && break
  sleep 90
done

# ФАЗА 2: плитки пинам (стрижки + нос), зовём по файлу обложки — кеш в ПЛИТКИ/по-девочке/<имя>/
for g in $PINS; do
  cover=$(ls ~/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН/$g/*.jpg 2>/dev/null | head -1)
  [ -z "$cover" ] && continue
  for vid in стрижки нос; do
    if [ ! -d ~/Desktop/НЕЙРОНКА/ПЛИТКИ/по-девочке/$g/$vid ]; then
      node /Users/qq/Desktop/neironka-poster/tilegen.cjs --go $vid "$cover" "$g-w2" >> "$LOG" 2>&1
    fi
  done
done
echo "$(date +%H:%M) фаза 2: плитки пинов готовы" >> "$LOG"

# ФАЗА 3: сборка — милы проход 3, пины проход 1
for g in $MILAS; do
  COVER_REUSE=1 TPLS="$TOP" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 3 2>&1 | grep -E "^(OK|FAIL|ИТОГО)" >> "$OUT/_сборка.log"
done
for g in $PINS; do
  COVER_REUSE=1 TPLS="$TOP" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 1 2>&1 | grep -E "^(OK|FAIL|ИТОГО)" >> "$OUT/_сборка.log"
done
echo "$(date +%H:%M) фаза 3: первый проход сборки закончен" >> "$LOG"

# ФАЗА 4: добор дырок — 2 круга
for round in 1 2; do
  miss=0
  for g in $MILAS; do
    n=$(ls "$OUT/$g" 2>/dev/null | grep -c -- "-p3\.mp4")
    if [ "$n" -lt 6 ]; then (( miss++ )); COVER_REUSE=1 TPLS="$TOP" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 3 2>&1 | grep -E "^(OK|FAIL|ИТОГО)" >> "$OUT/_сборка.log"; fi
  done
  for g in $PINS; do
    n=$(ls "$OUT/$g" 2>/dev/null | grep -c -- "-p1\.mp4")
    if [ "$n" -lt 6 ]; then (( miss++ )); COVER_REUSE=1 TPLS="$TOP" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 1 2>&1 | grep -E "^(OK|FAIL|ИТОГО)" >> "$OUT/_сборка.log"; fi
  done
  echo "$(date +%H:%M) фаза 4 круг $round: недобор у $miss девочек" >> "$LOG"
  [ "$miss" -eq 0 ] && break
  sleep 90
done

# ФАЗА 5: манифест волны-2 + итог владельцу в «клод мой»
MAN=~/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/манифест-волна2.txt
: > "$MAN"
total=0
for g in $MILAS; do for t in beauty-guide nose-verdict haircut-match brow-map makeup-colortype boyfriend-match; do
  p="$OUT/$g/$g-$t-p3.mp4"; st="ожидается"; [ -f "$p" ] && { st="готов"; (( total++ )); }
  echo "$p;$t;$st" >> "$MAN"
done; done
for g in $PINS; do for t in beauty-guide nose-verdict haircut-match brow-map makeup-colortype boyfriend-match; do
  p="$OUT/$g/$g-$t-p1.mp4"; st="ожидается"; [ -f "$p" ] && { st="готов"; (( total++ )); }
  echo "$p;$t;$st" >> "$MAN"
done; done
TOK=$(cat ~/.neironka/tgtok); CHAT=$(cat ~/.neironka/tgchat)
curl -s -X POST "https://api.telegram.org/bot$TOK/sendMessage" \
  --data-urlencode "chat_id=$CHAT" \
  --data-urlencode "text=Волна-2 готова: $total/150 постов с НОВЫМИ локациями (рисовые террасы и качели Бали, пустыня и фонтаны Дубая, Дворцовая и Севкабель, Зарядье и Патрики). 25 девочек: 14 мил (проход 3) + 11 пинов (проход 1). Манифест: манифест-волна2.txt. Пересборка n02-гайда с новым хуком тоже сделана." >/dev/null
echo "=== $(date) волна-2 финиш: $total/150" >> "$LOG"
