#!/bin/bash
# ВОССТАНОВЛЕНИЕ ТЕЛЕГРАМ-КАНАЛА ПОСЛЕ ПЕРЕЗАГРУЗКИ (13.08, разбор факта).
#
# ЧТО СЛУЧИЛОСЬ. Машина перезагрузилась, macOS вычистила /tmp — и вместе с ним ушли ОБА токена
# (/tmp/.tgtok, /tmp/.tgtok2), состояние моста и журнал входящих. Мост умер молча: демон не
# перезапустился, сторожа фермы (duty_safe, backlog_safe, gologin_watch) читают токен из того же
# /tmp и после перезагрузки просто перестают слать, ничего об этом не сообщая.
#
# ПОЧЕМУ ЛЕЧИМ ХРАНИЛИЩЕМ, А НЕ АККУРАТНОСТЬЮ. Токен в /tmp это не «временный файл», это ключ от
# единственного канала связи с начальником. Он обязан пережить перезагрузку. Держим его в домашней
# папке (~/.neironka, права 700/600), а в /tmp кладём КОПИЮ при старте: так все скрипты фермы,
# которые ищут /tmp/.tgtok*, менять не надо — контракт остаётся прежним.
#
# СЕКРЕТ КЛАДЁТ ЧЕЛОВЕК, А НЕ Я. Токены сюда вписывает владелец руками (или переносит из BotFather),
# в переписку и в репозиторий они не попадают. Файлы лежат вне гита: папка домашняя.
#
# Запуск:
#   bash tgrestore.sh              разложить ключи в /tmp и поднять мост
#   bash tgrestore.sh --no-daemon  только разложить ключи
#
# Первая настройка (один раз, руками, токен в переписку не вставлять):
#   mkdir -p ~/.neironka && chmod 700 ~/.neironka
#   printf %s '<токен claudex057_bot>'      > ~/.neironka/tgtok2 && chmod 600 ~/.neironka/tgtok2
#   printf %s '<токен xmoneyforporsche_bot>' > ~/.neironka/tgtok  && chmod 600 ~/.neironka/tgtok
#   printf %s '<id группы>'                  > ~/.neironka/tgchat && chmod 600 ~/.neironka/tgchat
set -u
KEYS="$HOME/.neironka"
REPO="$(cd "$(dirname "$0")" && pwd)"

put() {
  local from_="$1" to_="$2" name_="$3"
  if [ -s "$from_" ]; then
    install -m 600 "$from_" "$to_" && echo "  ✓ $name_ → $to_"
  else
    echo "  ✗ $name_: нет $from_ (положи ключ туда, см. шапку файла)"
    return 1
  fi
}

echo "восстанавливаю телеграм-канал из $KEYS"
[ -d "$KEYS" ] || { echo "  ✗ нет папки $KEYS — ключи не заведены, читай шапку tgrestore.sh"; exit 1; }

bridge_ok=0
put "$KEYS/tgtok2" /tmp/.tgtok2 "токен мостового бота (claudex057)" && bridge_ok=1
put "$KEYS/tgtok"  /tmp/.tgtok  "токен серверного бота (xmoney)" || true

# КАНАЛ СТОРОЖЕЙ. duty_safe/backlog_safe/gologin_watch/facewatch читают /tmp/tg_bot.txt и
# /tmp/tg_chat.txt. Без них они работают вхолостую: считают, шлют в никуда и молчат об этом.
if [ -s "$KEYS/tgchat" ]; then
  install -m 600 "$KEYS/tgchat" /tmp/tg_chat.txt && echo "  ✓ чат сторожей → /tmp/tg_chat.txt ($(cat /tmp/tg_chat.txt))"
  # Сторожа шлют тем ботом, который СОСТОИТ в этой группе. По умолчанию мостовой: он же читает ответы.
  if [ -s "$KEYS/tgtok_guard" ]; then install -m 600 "$KEYS/tgtok_guard" /tmp/tg_bot.txt
  elif [ -s "$KEYS/tgtok2" ]; then install -m 600 "$KEYS/tgtok2" /tmp/tg_bot.txt
  fi
  [ -s /tmp/tg_bot.txt ] && echo "  ✓ бот сторожей → /tmp/tg_bot.txt"
else
  echo "  ⚠ нет $KEYS/tgchat — сторожа (дежурство, бэклог, gologin, лицо) слать не будут"
fi

if [ "${1:-}" = "--no-daemon" ]; then exit 0; fi
[ "$bridge_ok" = "1" ] || { echo "  мост не поднимаю: нет токена мостового бота"; exit 1; }

# ОДИН ОПРОСЧИК НА БОТА. Второй получит «Conflict: terminated by other getUpdates request», и оба
# начнут терять сообщения, поэтому старого демона гасим перед запуском нового.
pkill -f "tgchat.cjs daemon" 2>/dev/null && echo "  прежний демон остановлен"
cd "$REPO" || exit 1
nohup node tgchat.cjs daemon >> /tmp/tgchat_daemon.log 2>&1 &
sleep 1
if pgrep -f "tgchat.cjs daemon" >/dev/null; then echo "  ✓ мост поднят (node tgchat.cjs daemon), журнал /tmp/tgchat_daemon.log"
else echo "  ✗ мост не поднялся, смотри /tmp/tgchat_daemon.log"; exit 1; fi
