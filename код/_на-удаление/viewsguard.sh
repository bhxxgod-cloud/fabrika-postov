#!/bin/zsh
# СТОРОЖ ЧЕКЕРА ПРОСМОТРОВ (09.08, перевыпуск после разбора первой версии).
# Схема как у моста в телеграм: демон в бесконечном цикле плюс хранитель, который раз в минуту
# смотрит, жив ли он, и поднимает. Круглосуточность нужна потому, что смысл чекера в РЯДЕ по дням:
# пропущенные сутки это дырка в ряду, а по дырявому ряду нельзя сказать, растут просмотры или стоят.
#
# ДВЕ ДЫРЫ ПЕРВОЙ ВЕРСИИ, из-за которых она молча не работала (найдены после падения ноутбука):
#   1. nohup внутри сторожа. У сторожа нет управляющего терминала, и BSD nohup на этом падает с
#      «can't detach from console: Inappropriate ioctl for device», НИЧЕГО не запуская. Сторож
#      честно писал «поднимаю» каждую минуту, а демона не поднимал ни разу. Здесь nohup не нужен:
#      сторож сам сирота (ppid 1), его дети переживают закрытие терминала.
#   2. Признаком жизни был pgrep. После сна машины он перестал видеть живой процесс, и сторож в
#      цикле пытался поднять второй демон. Теперь признак жизни это ФАКТ, который пишет сам демон:
#      /tmp/viewsmon.beat с pid и временем последнего шага. Заодно ловится зависание: процесс жив,
#      а tick застыл (при обходе шаг раз в десятки секунд, в простое раз в 30 с, порог 10 минут).
#
# Гасим только СВОЙ процесс и только по pid из beat, предварительно убедившись, что в его командной
# строке действительно viewsmon.cjs. Orbita и gologin не трогаем НИКОГДА: pkill по ним снёс бы все
# окна, включая личные.
#
# Запуск:  cd /Users/qq/Desktop/neironka-poster && ./viewsguard.sh >/dev/null 2>&1 &
# Логи:    демон /tmp/viewsmon.log, сторож /tmp/viewsguard.log, сердцебиение /tmp/viewsmon.beat
# Стоп:    pkill -f viewsguard.sh   потом   pkill -f "viewsmon.cjs daemon"
set -u
DIR="/Users/qq/Desktop/neironka-poster"
LOG="${VIEWS_GUARD_LOG:-/tmp/viewsguard.log}"
DLOG="${VIEWS_LOG:-/tmp/viewsmon.log}"
BEAT="${VIEWS_BEAT:-/tmp/viewsmon.beat}"
STALE="${VIEWS_STALE:-600}"   # секунд без шага = считаем зависшим
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$DIR" || exit 1
echo "[$(date '+%F %T')] сторож поднят (порог зависания ${STALE}с)" >> "$LOG"

while true; do
  ALIVE=0
  if [[ -f "$BEAT" ]]; then
    PID=$(/usr/bin/sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$BEAT")
    AGE=$(( $(date +%s) - $(/usr/bin/stat -f %m "$BEAT") ))
    if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
      # pid из beat должен принадлежать именно нашему скрипту, а не случайному процессу с тем же id
      if ps -o command= -p "$PID" | grep -q "viewsmon.cjs"; then
        if (( AGE < STALE )); then
          ALIVE=1
        else
          echo "[$(date '+%F %T')] демон $PID завис: без шага ${AGE}с, гашу по pid" >> "$LOG"
          kill "$PID" 2>/dev/null; sleep 3; kill -9 "$PID" 2>/dev/null
        fi
      fi
    fi
  fi
  if (( ALIVE == 0 )); then
    echo "[$(date '+%F %T')] демон не найден, поднимаю" >> "$LOG"
    node viewsmon.cjs daemon >> "$DLOG" 2>&1 &
    sleep 10
  fi
  sleep 60
done
