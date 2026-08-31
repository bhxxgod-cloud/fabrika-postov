#!/bin/bash
# СТОРОЖ НАД СТОРОЖЕМ (14.08, усилен 15.08 по приказу «мост должен работать всегда»).
#
# ЗАЧЕМ. Цепочка «телеграм → tgwatch_in.cjs → файл входящих → слежение → я» надёжна ровно
# настолько, насколько надёжно её самое слабое звено. Если tgwatch_in упадёт или ЗАВИСНЕТ, файл
# перестанет пополняться, и тишина будет неотличима от «владелец ничего не писал».
#
# ЧТО ДЕЛАЕТ. Раз в минуту: (1) поднимает упавших сторожей; (2) если сторож входящих жив, но пульс
# (~/.neironka/tg_мост_пульс.txt — время последнего успешного опроса) старше 5 минут, значит он
# завис (сеть, подвисший fetch) — убивает и поднимает заново; (3) каждый подъём пишет в лог И в файл
# входящих, чтобы главный чат видел падения тем же каналом, что и сообщения владельца.
# ИМЕНА ПЕРЕМЕННЫХ ЛАТИНИЦЕЙ (аудит 15.08: «ЛОГ=…» bash не считает присваиванием).
# Сам keepalive поднимается при входе в систему через LaunchAgent com.neironka.tgkeepalive.
# РАБОТАЕМ ИЗ КОПИИ В ~/.neironka/bin: launchd не пускает на Рабочий стол. Если стол доступен
# (запуск из сессии), сначала обновляем копии из репо.
bash /Users/qq/Desktop/neironka-poster/tgsync.sh 2>/dev/null
cd /Users/qq/.neironka/bin || exit 1
LOG=~/.neironka/tgkeepalive.log
INBOX=~/.neironka/tg_входящие.txt
PULSE=~/.neironka/tg_мост_пульс.txt
alarm() { echo "$(date '+%H:%M:%S') $1" >> $LOG; printf '%s\t⚠ МОСТ\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$1" >> $INBOX; }
while true; do
  if ! pgrep -f "tgwatch_in\.cjs" > /dev/null; then
    alarm "сторож входящих лежал — поднимаю"
    nohup node tgwatch_in.cjs 30 >> ~/.neironka/tgwatch_in.log 2>&1 &
  else
    if [ -f "$PULSE" ]; then
      NOW=$(date +%s); LAST=$(( $(cat "$PULSE") / 1000 )); AGE=$(( NOW - LAST ))
      if [ "$AGE" -gt 300 ]; then
        alarm "сторож входящих завис (пульс ${AGE}с назад) — перезапускаю"
        pkill -f "tgwatch_in\.cjs"; sleep 2
        nohup node tgwatch_in.cjs 30 >> ~/.neironka/tgwatch_in.log 2>&1 &
      fi
    fi
  fi
  if ! pgrep -f "branchwatch\.cjs" > /dev/null; then
    echo "$(date '+%H:%M:%S') сторож веток лежал — поднимаю" >> $LOG
    nohup node branchwatch.cjs 45 >> ~/.neironka/branchwatch.log 2>&1 &
  fi
  # СТОРОЖ СЕТИ. Уход мака из сети фермы виден только по симптомам, и они обманчивы:
  # «прокси не работают» при полностью исправных прокси. 21.08.2026 это стоило полдня.
  if ! pgrep -f "set_watch" > /dev/null; then
    echo "$(date '+%H:%M:%S') сторож сети лежал — поднимаю" >> $LOG
    nohup bash set_watch.sh >> ~/.neironka/set_watch.log 2>&1 &
  fi
  bash /Users/qq/Desktop/neironka-poster/tgsync.sh 2>/dev/null
  sleep 60
done
