#!/bin/zsh
# ОДНА ПОЛОСА ОЧЕРЕДИ: девочки из аргументов, каждая: основные 9 → арты 14. Лог общий, построчно.
S=~/Desktop/НЕЙРОНКА/РИЛСЫ-НОВАЯ-СХЕМА/_скрипты; OUT="$HOME/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ"; LOG="$OUT/_сборка.log"
ART="img-bw-editorial,img-golden-portrait,img-retro-90s,img-double-exposure,img-doodle-watercolor,img-popart,img-winx-fairy,img-gta,img-fantasy-char,img-plush-toy,img-boyfriend-match,img-business-portrait,img-tryon,img-beauty-guide"
cd /Users/qq/Desktop/neironka-poster
for g in "$@"; do
  if [[ "$g" == пин-* ]]; then o=~/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН/$g/$(ls ~/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН/$g | grep '^обложка' | grep -v сетка | head -1); node tilegen.cjs --go стрижки "$o" "$g" >/dev/null 2>&1; node tilegen.cjs --go нос "$o" "$g" >/dev/null 2>&1; fi
  OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 1 2>&1 | grep --line-buffered -E "^(OK|FAIL|SKIP|ИТОГО)" >> "$LOG"
  COVER_REUSE=1 TPLS="$ART" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 2 2>&1 | grep --line-buffered -E "^(OK|FAIL|SKIP|ИТОГО)" >> "$LOG"
done
echo "=== $(date) полоса завершена: $*" >> "$LOG"
