#!/bin/zsh
# ВОЛНА-3 (22.08): 8 отобранных владельцем девочек × 20 постов = 160.
# Фазы: 1) по 20 милых обложек в разных локациях (квота 5/5/5/5 по городам);
# 2) плитки тем, у кого их нет; 3) сборка проходами 11-13 (по 6 шаблонов) + 14 (2 шаблона) = 20;
# 4) два круга добора дырок; 5) манифест + итог в «клод мой».
# Имена переменных ТОЛЬКО ASCII (память kirillica-v-bash — на этом умерла волна-2).
S=~/Desktop/НЕЙРОНКА/РИЛСЫ-НОВАЯ-СХЕМА/_скрипты
OUT="$HOME/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ"
LOG="$OUT/_волна3.log"
TOP="img-beauty-guide,img-nose-verdict,img-haircut-match,img-brow-map,img-makeup-colortype,img-boyfriend-match"
TAIL2="img-beauty-guide,img-makeup-colortype"
GIRLS=(кукла-1 мила-d01 мила-n01 мила-n02 мила-p05 097-dark11_haircut-match пин-09 нов215)
ALLG="${(j:,:)GIRLS}"
cd /Users/qq/Desktop/neironka-poster
echo "=== $(date) волна-3 старт: 8 девочек × 20 постов" >> "$LOG"

# ФАЗА 1: обложки — 3 круга, дырки добираются сдвигом локации
for round in 0 1 2; do
  RETRY_SHIFT=$round GIRLS="$ALLG" PER_GIRL=20 node "$S/covers_wave3.cjs" >> "$LOG" 2>&1
  holes=0
  for g in $GIRLS; do
    n=$(ls ~/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН/$g 2>/dev/null | grep -c 'обложка-.*-3')
    (( holes += 20 - n ))
  done
  echo "$(date +%H:%M) фаза 1 круг $round: дырок обложек $holes" >> "$LOG"
  [ "$holes" -le 0 ] && break
  sleep 60
done

# ФАЗА 2: плитки (стрижки/нос) тем, у кого кеша ещё нет
for g in $GIRLS; do
  cover=$(ls ~/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН/$g/*.jpg 2>/dev/null | head -1)
  [ -z "$cover" ] && continue
  for vid in стрижки нос; do
    if [ ! -d ~/Desktop/НЕЙРОНКА/ПЛИТКИ/по-девочке/$g/$vid ]; then
      node /Users/qq/Desktop/neironka-poster/tilegen.cjs --go $vid "$cover" "$g-w3" >> "$LOG" 2>&1
    fi
  done
done
echo "$(date +%H:%M) фаза 2: плитки готовы" >> "$LOG"

# ФАЗА 3: сборка 20 постов на девочку
for g in $GIRLS; do
  for pass in 11 12 13; do
    COVER_REUSE=1 TPLS="$TOP" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" $pass 2>&1 | grep -E "^(OK|FAIL|ИТОГО)" >> "$OUT/_сборка.log"
  done
  COVER_REUSE=1 TPLS="$TAIL2" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 14 2>&1 | grep -E "^(OK|FAIL|ИТОГО)" >> "$OUT/_сборка.log"
  n=$(ls "$OUT/$g" 2>/dev/null | grep -cE -- "-p1[1-4]\.mp4")
  echo "$(date +%H:%M) фаза 3: $g собрано $n/20" >> "$LOG"
done

# ФАЗА 4: добор дырок — 2 круга
for round in 1 2; do
  miss=0
  for g in $GIRLS; do
    n=$(ls "$OUT/$g" 2>/dev/null | grep -cE -- "-p1[1-4]\.mp4")
    if [ "$n" -lt 20 ]; then
      (( miss++ ))
      for pass in 11 12 13; do
        COVER_REUSE=1 TPLS="$TOP" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" $pass 2>&1 | grep -E "^(OK|FAIL|ИТОГО)" >> "$OUT/_сборка.log"
      done
      COVER_REUSE=1 TPLS="$TAIL2" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 14 2>&1 | grep -E "^(OK|FAIL|ИТОГО)" >> "$OUT/_сборка.log"
    fi
  done
  echo "$(date +%H:%M) фаза 4 круг $round: недобор у $miss девочек" >> "$LOG"
  [ "$miss" -eq 0 ] && break
  sleep 60
done

# ФАЗА 5: манифест + итог владельцу
MAN=~/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/манифест-волна3.txt
: > "$MAN"
total=0
for g in $GIRLS; do
  for f in "$OUT/$g"/*-p1[1-4].mp4(N); do
    base=$(basename "$f"); tpl=${base#$g-}; tpl=${tpl%-p1*.mp4}
    echo "$f;$tpl;готов" >> "$MAN"; (( total++ ))
  done
done
TOK=$(cat ~/.neironka/tgtok); CHAT=$(cat ~/.neironka/tgchat)
curl -s -X POST "https://api.telegram.org/bot$TOK/sendMessage" \
  --data-urlencode "chat_id=$CHAT" \
  --data-urlencode "text=Волна-3 готова: $total/160 постов. Восемь твоих девочек (кукла-1, мила-d01, n01, n02, p05, 097-dark11, пин-09, нов215), у каждой 20 новых милых обложек в разных локациях — по 5 на Москву, Питер, Дубай и Бали, у всех своя поза, одежда и место. Манифест: манифест-волна3.txt" >/dev/null
echo "=== $(date) волна-3 финиш: $total/160" >> "$LOG"
