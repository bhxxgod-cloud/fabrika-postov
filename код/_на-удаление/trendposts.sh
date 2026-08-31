#!/bin/bash
# ТИПАЖИ → ПОСТЫ. Берём сгенерированные лица (gentrend.cjs) и заказываем по каждому
# полноценный фотопост в промо-разделе фабрики через опцию «своё фото» (genref.cjs).
#
# Почему по одному кадру на типаж, а не по всем трём: три сцены одной девушки нужны, чтобы
# ВЫБРАТЬ лучшую, а в пост идёт один референс — по нему фабрика соберёт все слайды сама.
#
# Запуск: ./trendposts.sh [шаблон]     (по умолчанию бьюти-гайд)
cd "/Users/qq/Desktop/neironka-poster"
TPL="${1:-img-beauty-guide}"

declare -a PAIRS=(
  "blonde-cap-1:блондинка с кепкой"
  "dark-mall-1:тёмные волосы"
  "nat-home-1:русая естественная"
  "glam-wave-1:блонд с волной"
)

for pair in "${PAIRS[@]}"; do
  file="/tmp/trend_girls/${pair%%:*}.jpg"
  label="${pair##*:}"
  if [ ! -f "$file" ]; then echo "· нет файла: $file"; continue; fi
  echo "=== $label → $TPL"
  node genref.cjs "$file" "$TPL" --label "$label" 2>&1 | grep -E "референс|заказан|готов|проверка|ИТОГ|ОШИБКА" | tail -5
  sleep 20
done
