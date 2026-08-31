#!/bin/bash
# ОТКРЫВАЕТ ЖИВОЙ CHROME ВЛАДЕЛЬЦА ДЛЯ МОСТА КОДОВ.
#
# Зачем. Google не пускает в Gmail из-под автоматизации: на ввод пароля он
# отвечает «Couldn't sign you in — this browser or app may not be secure».
# Копия профиля тоже не выручает: на macOS куки зашифрованы ключом из связки
# ключей, и второй Chrome их не расшифровывает.
#
# Поэтому мост не логинится и не копирует, а подключается к УЖЕ ОТКРЫТОМУ
# браузеру владельца, где вход давно сделан. Для этого Chrome должен слушать
# порт отладки — его и включает этот скрипт.
#
# Chrome при этом остаётся обычным: те же вкладки, те же аккаунты, тот же
# профиль. Пользоваться им можно как всегда.
PORT=9223
PROFILE="$HOME/Library/Application Support/Google/Chrome"

if curl -s -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "мост уже открыт (порт $PORT)"
  exit 0
fi

if pgrep -f "Google Chrome.app/Contents/MacOS/Google Chrome" | grep -qv "$(pgrep -f "remote-debugging-port=$PORT" | tr '\n' '|')x" 2>/dev/null; then
  echo "Chrome сейчас запущен обычным образом — порт отладки так не включить."
  echo "Закрой Chrome (cmd+Q) и запусти этот скрипт снова."
  echo "Вкладки Chrome восстановит сам."
  exit 1
fi

open -na "Google Chrome" --args \
  --remote-debugging-port=$PORT \
  --user-data-dir="$PROFILE" \
  --profile-directory=Default

for i in $(seq 1 20); do
  sleep 1
  curl -s -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && { echo "мост открыт на порту $PORT"; exit 0; }
done
echo "Chrome запустился, но порт $PORT не отвечает"
exit 1
