#!/bin/zsh
# СТОРОЖ ОТЧЁТОВ: на каждое «ИТОГО <девочка>: N рилсов» в логе сборки — одна строка в «клод мой».
LOG="$HOME/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ/_сборка.log"; SEEN="$HOME/.neironka/marketolog_reported.txt"; touch "$SEEN"
tok=$(cat /tmp/.tgtok | tr -d '[:space:]'); chat=$(cat /tmp/.tgchat | tr -d '[:space:]')
while true; do
  grep -E "^ИТОГО|^=== .*ВСЁ ГОТОВО" "$LOG" 2>/dev/null | while read -r line; do
    key=$(echo "$line" | md5); grep -q "$key" "$SEEN" && continue; echo "$key" >> "$SEEN"
    total=$(find "$HOME/Desktop/СОКРОВИЩНИЦА-РИЛСЫ/ТОП РОЛИКИ + ТЕКСТ" -name "*.mp4" | wc -l | tr -d ' ')
    curl -s -X POST "https://api.telegram.org/bot$tok/sendMessage" -d "chat_id=$chat" --data-urlencode "text=[Маркетолог] $line · всего в ТОП РОЛИКИ + ТЕКСТ: $total (пакеты с 2 описаниями уходят в Traffic сами)" >/dev/null
    sleep 3
  done
  sleep 60
done
