#!/bin/zsh
# ГОРОДСКАЯ ВОЛНА: как только у милы ≥8 городских обложек — сразу собираем её топ-6 (проход 2).
S=~/Desktop/НЕЙРОНКА/РИЛСЫ-НОВАЯ-СХЕМА/_скрипты; OUT="$HOME/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ"; LOG="$OUT/_сборка.log"
TOP="img-beauty-guide,img-nose-verdict,img-haircut-match,img-brow-map,img-makeup-colortype,img-boyfriend-match"
cd /Users/qq/Desktop/neironka-poster
DONE=""
while true; do
  all_done=1
  for g in мила-d01 мила-p01 мила-p02 мила-p03 мила-p04 мила-p05 мила-p07 мила-p08 мила-p09 мила-p10 мила-n01 мила-n02 мила-n03 мила-n04; do
    [[ "$DONE" == *"$g"* ]] && continue
    n=$(ls ~/Desktop/НЕЙРОНКА/ОБЛОЖКИ-ДОГЕН/$g 2>/dev/null | grep -cE 'обложка-(москва|питер|дубай|бали)')
    if [ "$n" -ge 8 ]; then
      COVER_REUSE=1 TPLS="$TOP" OUT_DIR="$OUT" node "$S/assemble_girl.cjs" "$g" 2 2>&1 | grep --line-buffered -E "^(OK|FAIL|ИТОГО)" >> "$LOG"
      DONE="$DONE $g"
    else all_done=0; fi
  done
  [ "$all_done" = "1" ] && break
  sleep 60
done
echo "=== $(date) городская волна мил готова" >> "$LOG"
