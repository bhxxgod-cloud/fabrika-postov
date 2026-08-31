#!/bin/zsh
# ОЧЕРЕДЬ СБОРКИ: основные 9 на всех → арты 14 на всех → новые пин-девочки по мере обложек. Лог построчно.
S=~/Desktop/НЕЙРОНКА/РИЛСЫ-НОВАЯ-СХЕМА/_скрипты; OUT="$HOME/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ"; LOG="$OUT/_сборка.log"
cd /Users/qq/Desktop/neironka-poster
GIRLS=(134-нов14 анжела-удивлена аня-апгрейд блонд-авто блондинка-сучка губки-бантиком розовая-неон сучка-в-кровати сучка-в-машине шатенка-мост нов215 051-n1v03_makeup-colortype 072-нов38 097-dark11_haircut-match 101-нов07 117-нов17 126-d16v2_face-report кукла-1 блонд-каре)
ART="img-bw-editorial,img-golden-portrait,img-retro-90s,img-double-exposure,img-doodle-watercolor,img-popart,img-winx-fairy,img-gta,img-fantasy-char,img-plush-toy,img-boyfriend-match,img-business-portrait,img-tryon,img-beauty-guide"
echo "=== $(date) старт: основные" >> "$LOG"
for g in $GIRLS; do OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 1 2>&1 | grep --line-buffered -E "^(OK|FAIL|SKIP|ИТОГО)" >> "$LOG"; done
echo "=== $(date) основные готовы, старт артов" >> "$LOG"
for g in $GIRLS; do COVER_REUSE=1 TPLS="$ART" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 2 2>&1 | grep --line-buffered -E "^(OK|FAIL|SKIP|ИТОГО)" >> "$LOG"; done
echo "=== $(date) арты готовы, старт новых пин" >> "$LOG"
for i in 01 02 03 04 05 06 07 08 09 10 11; do
  until [ "$(ls ~/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН/пин-$i 2>/dev/null | grep -c '^обложка')" -ge 12 ]; do sleep 120; done
  o=~/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН/пин-$i/$(ls ~/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН/пин-$i | grep '^обложка' | grep -v сетка | head -1)
  node tilegen.cjs --go стрижки "$o" "пин-$i" >/dev/null 2>&1; node tilegen.cjs --go нос "$o" "пин-$i" >/dev/null 2>&1
  OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "пин-$i" 1 2>&1 | grep --line-buffered -E "^(OK|FAIL|SKIP|ИТОГО)" >> "$LOG"
  COVER_REUSE=1 TPLS="$ART" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "пин-$i" 2 2>&1 | grep --line-buffered -E "^(OK|FAIL|SKIP|ИТОГО)" >> "$LOG"
done
echo "=== $(date) ВСЁ ГОТОВО" >> "$LOG"
