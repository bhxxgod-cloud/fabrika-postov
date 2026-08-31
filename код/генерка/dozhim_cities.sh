#!/bin/zsh
# ДОЖИМ ГОРОДСКОЙ ВОЛНЫ ДО КОНЦА (приказ владельца 21.08: «выдай до конца посты»).
# Фазы: A) добить дырки обложек (сторож run_cities ждёт 8 на девочку и без этого не выйдет);
# B) дождаться конца run_cities и хвостов d01/n02; C) 3 круга дозаполнения пропусков сборки
# (провайдер штормил 503/таймаутами — сборщик пропускает готовое, круг добирает только дырки);
# D) итог владельцу в «клод мой».
S=~/Desktop/НЕЙРОНКА/РИЛСЫ-НОВАЯ-СХЕМА/_скрипты
OUT="$HOME/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ"
LOG="$OUT/_дожим.log"
TOP="img-beauty-guide,img-nose-verdict,img-haircut-match,img-brow-map,img-makeup-colortype,img-boyfriend-match"
ДЕВОЧКИ=(мила-d01 мила-p01 мила-p02 мила-p03 мила-p04 мила-p05 мила-p07 мила-p08 мила-p09 мила-p10 мила-n01 мила-n02 мила-n03 мила-n04)
cd /Users/qq/Desktop/neironka-poster

дыркиОбложек() {
  local всего=0
  for g in $ДЕВОЧКИ; do
    local n=$(ls ~/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН/$g 2>/dev/null | grep -cE 'обложка-(москва|питер|дубай|бали)-1')
    (( всего += 8 - n ))
  done
  echo $всего
}

# ФАЗА A: добивка обложек, до 5 кругов, пауза между кругами — провайдеру отдышаться
for round in 1 2 3 4 5; do
  d=$(дыркиОбложек)
  echo "$(date +%H:%M) фаза A круг $round: дырок обложек $d" >> "$LOG"
  [ "$d" -le 0 ] && break
  RETRY_SHIFT=$round node "$S/covers_dobivka.cjs" >> "$LOG" 2>&1
  sleep 120
done

# ФАЗА B: ждём сторожа волны и хвосты (d01-ретрай, n02-пересборка)
while ps -eo args | grep -q "[r]un_cities"; do sleep 60; done
sleep 360
while ps -eo args | grep -q "[a]ssemble_girl"; do sleep 60; done
echo "$(date +%H:%M) фаза B: волна и хвосты закончились" >> "$LOG"

# ФАЗА C: 3 круга дозаполнения — у кого меньше 6 роликов прохода 2, прогоняем ещё раз
for round in 1 2 3; do
  недобор=0
  for g in $ДЕВОЧКИ; do
    n=$(ls "$OUT/$g" 2>/dev/null | grep -c -- "-p2\.mp4")
    if [ "$n" -lt 6 ]; then
      (( недобор++ ))
      echo "$(date +%H:%M) фаза C круг $round: $g имеет $n/6 — добираю" >> "$LOG"
      COVER_REUSE=1 TPLS="$TOP" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 2 2>&1 | grep -E "^(OK|FAIL|ИТОГО)" >> "$OUT/_сборка.log"
    fi
  done
  [ "$недобор" -eq 0 ] && break
  sleep 90
done

# ФАЗА D: итог владельцу в «клод мой» (текст ботом напрямую — tgsend только для файлов)
итог="Городская волна собрана до конца."
всего=0
for g in $ДЕВОЧКИ; do
  n=$(ls "$OUT/$g" 2>/dev/null | grep -c -- "-p2\.mp4")
  (( всего += n ))
done
строки=""
for g in $ДЕВОЧКИ; do
  n=$(ls "$OUT/$g" 2>/dev/null | grep -c -- "-p2\.mp4")
  строки="$строки$g: $n/6"$'\n'
done
TOK=$(cat ~/.neironka/tgtok); CHAT=$(cat ~/.neironka/tgchat)
curl -s -X POST "https://api.telegram.org/bot$TOK/sendMessage" \
  --data-urlencode "chat_id=$CHAT" \
  --data-urlencode "text=Городская волна: $всего роликов прохода 2 по 14 милам (обложки Бали/Дубай/Питер/Москва на кадре 1, кадры 3/4 в той же локации).
$строки
Пакеты в СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ, tgpost шлёт их в контент-чат. Мед-лексика и дубли тегов вычищены во всех текстах." >/dev/null
echo "$(date +%H:%M) фаза D: итог отправлен, всего $всего" >> "$LOG"
