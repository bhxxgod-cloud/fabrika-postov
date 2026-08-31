#!/bin/bash
# КОПИЯ МОСТА ВНЕ РАБОЧЕГО СТОЛА ДЛЯ LAUNCHD (15.08). macOS не пускает launchd-агентов на Рабочий
# стол (TCC: «Operation not permitted»), поэтому автозапуск после перезагрузки крутит копии из
# ~/.neironka/bin. ИСТОЧНИК ПРАВДЫ — репо; после любой правки tgwatch_in.cjs / branchwatch.cjs /
# tgkeepalive.sh запускать этот скрипт (keepalive сам зовёт его раз в минуту, когда стол доступен,
# так что вручную обычно не надо). Копии расходятся, если про это забыть — см. память «копии кода».
SRC=/Users/qq/Desktop/neironka-poster
DST=/Users/qq/.neironka/bin
for f in tgwatch_in.cjs branchwatch.cjs tgkeepalive.sh set_watch.sh; do
  [ -r "$SRC/$f" ] && ! cmp -s "$SRC/$f" "$DST/$f" && cp "$SRC/$f" "$DST/$f" && echo "$(date '+%H:%M:%S') обновлена копия $f" >> ~/.neironka/tgkeepalive.log
done
chmod +x "$DST/tgkeepalive.sh" 2>/dev/null
exit 0
