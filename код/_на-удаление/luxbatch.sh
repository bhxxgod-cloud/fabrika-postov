#!/bin/bash
# ЛЮКС-ВОЛНА 05.08: бьюти-гайд + популярные шаблоны на каждую девочку по дорогим референсам.
# Популярные по замерам 04.08: beauty-guide (57 просм/ч), makeup-colortype (30/ч), gelik-azs (42/ч),
# face-report (в топе спроса по комментам). Референсы: /tmp/luxrefs/<Имя>.jpg (luxrefs.cjs).
cd "/Users/qq/Desktop/neironka-poster"

GIRLS=("Полина" "Карина" "Дарья" "Анечка" "Мия")
TPLS=("img-beauty-guide" "img-makeup-colortype" "img-face-report" "img-gelik-azs")

for g in "${GIRLS[@]}"; do
  ref="/tmp/luxrefs/${g}.jpg"
  if [ ! -f "$ref" ]; then echo "=== $g: НЕТ РЕФЕРЕНСА, скип"; continue; fi
  for t in "${TPLS[@]}"; do
    echo "=== $g → $t"
    node genref.cjs "$ref" "$t" --label "$g" 2>&1 | grep -E "заказан|готов|проверка|ИТОГ|ОШИБКА" | tail -3
    sleep 15
  done
done
echo "ЛЮКС-ВОЛНА ГОТОВА"
