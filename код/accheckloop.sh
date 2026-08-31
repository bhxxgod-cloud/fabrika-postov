#!/bin/bash
# ЦИКЛ ЕДИНОГО ЧЕКА АККОВ — раз в 6 часов.
#
# ЗАЧЕМ ОТДЕЛЬНЫЙ ЦИКЛ, ЕСЛИ ЕСТЬ КРОН. Проверено 06.08: крон на этом маке НЕ МОЖЕТ читать
# ~/Desktop. И /usr/sbin/cron, и launchd-агент получают EPERM на readdir и read внутри папки
# проекта (macOS TCC: у планировщика нет Full Disk Access). Ровно по этой причине давно стоящая
# запись `17 */6 * * * … stats.cjs` не работала НИ РАЗУ, в /tmp/stats.log лежит только
# «EPERM: process.cwd failed». Крон-запись для accheck оставлена и оживёт сама, как только
# начальник выдаст Full Disk Access для cron (Системные настройки → Конфиденциальность и
# безопасность → Полный доступ к диску → добавить /usr/sbin/cron). А пока регулярность держит
# этот цикл: он запускается из обычной сессии, как postdaemon и localrunner, и права у него есть.
#
# Запуск: nohup ./accheckloop.sh >/dev/null 2>&1 &     (лог в /tmp/accheck.log)
cd "/Users/qq/Desktop/neironka-poster" || exit 1
# FIRST_SLEEP — не гнать чек в первую же секунду после старта: если прогон только что был руками,
# сверка лиц (платные vision-запросы) повторилась бы впустую.
[ -n "$FIRST_SLEEP" ] && sleep "$FIRST_SLEEP"
while true; do
  echo "=== $(date '+%Y-%m-%d %H:%M') запуск чека ===" >> /tmp/accheck.log
  node accheck.cjs >> /tmp/accheck.log 2>&1
  sleep 21600
done
