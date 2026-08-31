#!/bin/zsh
# МИЛЫ: плитки + топ-6 (проход 1). Аргументы — имена девочек.
S=~/Desktop/НЕЙРОНКА/РИЛСЫ-НОВАЯ-СХЕМА/_скрипты; OUT="$HOME/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ"; LOG="$OUT/_сборка.log"
TOP="img-beauty-guide,img-nose-verdict,img-haircut-match,img-brow-map,img-makeup-colortype,img-boyfriend-match"
cd /Users/qq/Desktop/neironka-poster
for g in "$@"; do
  o=~/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН/$g/обложка-гео-01.jpg
  [ -f "$o" ] || o=~/Desktop/НЕЙРОНКА/ДОГЕН-РАБОТА/$g.png
  node tilegen.cjs --go стрижки "$o" "$g" >/dev/null 2>&1
  node tilegen.cjs --go нос "$o" "$g" >/dev/null 2>&1
  COVER_REUSE=1 TPLS="$TOP" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 1 2>&1 | grep --line-buffered -E "^(OK|FAIL|SKIP|ИТОГО)" >> "$LOG"
done
echo "=== $(date) милы: $*" >> "$LOG"
