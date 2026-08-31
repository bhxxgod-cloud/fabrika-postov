#!/bin/bash
# ОЧЕЛОВЕЧИВАНИЕ 6 ЖИВЫХ (05.08): био + 5 подписок на каждый акк, СТРОГО после того как его
# igpost-задача бласта закрылась (двойная сессия на акк = мёртвый акк). Идём по порядку слотов.
cd "/Users/qq/Desktop/neironka-poster"
export DB_PUBLIC_URL="$(cat /tmp/dburl.txt)"

wait_free () { # slug: ждём пока нет живой igpost-задачи
  while node -e "
const {Client}=require('pg'),fs=require('fs');
const c=new Client({connectionString:fs.readFileSync('/tmp/dburl.txt','utf8').trim(),ssl:{rejectUnauthorized:false}});
(async()=>{await c.connect();
const n=(await c.query(\"SELECT 1 FROM local_jobs WHERE slug='\$1' AND mode='igpost' AND status IN ('queued','running') LIMIT 1\".replace('\$1','$1'))).rowCount;
await c.end(); process.exit(n?0:1);})()" 2>/dev/null; do sleep 60; done
}

declare -a ROWS=(
  "kasey37750|бьюти и ИИ-тренды на себе 💛 пробую шаблоны и делюсь"
  "case17002|тесты нейрошаблонов на себе ✨ что зашло, то в ленте"
  "gerardo53233|бьюти-эксперименты и находки 🤍 повторяю тренды"
  "kade76559|глоу-ап дневник 💫 шаблоны, макияж, стиль"
  "damari1735|собираю вдохновение каждый день 🌿 бьюти и ИИ"
  "bryan436344|мой бьюти-плейграунд 💛 тренды и разборы"
)

for row in "${ROWS[@]}"; do
  slug="${row%%|*}"; bio="${row##*|}"
  echo "=== $slug: жду свободного окна"
  wait_free "$slug"
  sleep 90
  echo "=== $slug: био + подписки"
  BIO_TEXT="$bio" node followbeauty.cjs "$slug" 5 2>&1 | grep -E "био|ПОДПИСКИ|подписа|ИТОГ" | tail -6
  sleep 120
done
echo "ОЧЕЛОВЕЧИВАНИЕ ГОТОВО"
