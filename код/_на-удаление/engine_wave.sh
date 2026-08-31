#!/bin/bash
# ВОЛНА ПОСТОВ ИЗ НОВЫХ ФОТО НАЧАЛЬНИКА (06.08, приказ: «делай всё через нейронку, делай мне
# посты»). Строго ПО ОДНОМУ: движок параллель не даёт, лок конвейера делит сборщиков сам.
# Девочка22 и девочка23 уже собраны, тут остальные годные кадры из ~/Pictures/Screenshots
# (отбор из аудита: длинные распущенные волосы, чистый кадр; бейдж/сигарета/каре отсеяны).
cd "$(dirname "$0")"
S="/Users/qq/Pictures/Screenshots"
run() {
  local persona="$1" file="$2"
  [ -f "$file" ] || { echo "НЕТ ФАЙЛА: $file"; return; }
  echo "=== $persona ← $(basename "$file")"
  COVER_REF=1 node makepost.cjs "$persona" hearts-trend --ref "$file"
}
run "девочка24" "$S/Screenshot 2026-08-06 at 16.32.01.png"
run "девочка25" "$S/Screenshot 2026-08-06 at 16.31.45.png"
run "девочка26" "$S/Screenshot 2026-08-06 at 16.32.44.png"
run "девочка27" "$S/Screenshot 2026-08-06 at 16.32.41.png"
run "девочка28" "$S/Screenshot 2026-08-06 at 16.32.57.png"
run "девочка29" "$S/Screenshot 2026-08-06 at 16.32.30.png"
run "девочка30" "$S/Screenshot 2026-08-06 at 16.32.34.png"
run "девочка31" "$S/Screenshot 2026-08-06 at 16.32.48.png"
run "девочка32" "$S/Screenshot 2026-08-06 at 16.33.03.png"
echo "ВОЛНА ЗАВЕРШЕНА"
