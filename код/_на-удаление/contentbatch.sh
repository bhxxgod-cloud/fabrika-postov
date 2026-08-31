#!/bin/bash
# Добивка контента 04.08: импорт спасённых рендеров Карины + дозаказы.
cd "/Users/qq/Desktop/neironka-poster"

node importfactory.cjs e349ccfc 82825216 --persona "Карина" 2>&1 | grep -E "склад|брак|найден|ОШИБКА"
sleep 10
node genposts.cjs "Карина" 1 2>&1 | grep -E "готов|склад|брак|ИТОГ|ОШИБКА" | tail -3
sleep 10
for tpl in img-face-report img-makeup-colortype img-nose-verdict; do
  node genref.cjs "/Users/qq/Downloads/146A1503_копия_2_(cropped)-2.jpg" "$tpl" --label "Мия" 2>&1 | grep -E "заказан|готов|проверка|ИТОГ|ОШИБКА" | tail -4
  sleep 15
done
node genposts.cjs "Дарья" 1 2>&1 | grep -E "готов|склад|брак|ИТОГ|ОШИБКА" | tail -3
sleep 10
node genposts.cjs "Анечка" 1 2>&1 | grep -E "готов|склад|брак|ИТОГ|ОШИБКА" | tail -3
echo "БАТЧ ЗАВЕРШЁН"
