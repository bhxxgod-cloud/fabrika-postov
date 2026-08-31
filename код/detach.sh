#!/bin/bash
# ПОЛНОСТЬЮ ОТВЯЗАННЫЙ запуск (RULES-gologin.md).
# Браузер GoLogin — дочерний процесс скрипта: если скрипт убить (кнопка «стоп» в чате, таймаут команды,
# закрытие терминала), Orbita умирает вместе с ним и профиль НЕ синхронизируется → акк ВЫЛОГИНИВАЕТСЯ.
# Здесь процесс уходит в ОТДЕЛЬНУЮ сессию (os.setsid) и переживает смерть родителя.
# usage: ./detach.sh <logfile> <cmd> [args...]
LOG="$1"; shift
python3 - "$LOG" "$@" <<'PY'
import os, sys, subprocess
log, cmd = sys.argv[1], sys.argv[2:]
pid = os.fork()
if pid > 0:
    print(f"detached pid будет в {log}.pid")
    os._exit(0)
os.setsid()                      # новая сессия: сигналы родителя сюда не долетают
f = open(log, 'w')
p = subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT,
                     stdin=subprocess.DEVNULL, start_new_session=True)
open(log + '.pid', 'w').write(str(p.pid))
os._exit(0)
PY
