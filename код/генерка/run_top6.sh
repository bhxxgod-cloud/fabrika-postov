#!/bin/zsh
# ТОП-6 ШАБЛОНОВ (приказ 17.08): beauty-guide, nose, haircut, brow, makeup, boyfriend-match.
S=~/Desktop/НЕЙРОНКА/РИЛСЫ-НОВАЯ-СХЕМА/_скрипты; OUT="$HOME/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ"; LOG="$OUT/_сборка.log"
TOP="img-beauty-guide,img-nose-verdict,img-haircut-match,img-brow-map,img-makeup-colortype,img-boyfriend-match"
cd /Users/qq/Desktop/neironka-poster
for g in "$@"; do
  for pass in 3 4 5; do
    COVER_REUSE=1 TPLS="$TOP" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" $pass 2>&1 | grep --line-buffered -E "^(OK|FAIL|SKIP|ИТОГО)" >> "$LOG"
  done
done
echo "=== $(date) топ6 завершён: $*" >> "$LOG"
