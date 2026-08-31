#!/bin/zsh
# КОНВЕЙЕР «ПОЧИНИЛ, СОБРАЛ, ОТПРАВИЛ» (09.08).
#
# ЗАЧЕМ. Раньше я делал это тремя ручными шагами и каждый ждал в переднем плане по несколько минут.
# Снаружи это выглядело как зависание, а отправка рвалась на середине. Теперь один скрипт: работает
# в фоне, пишет прогресс в лог с временем, отправляет пачками по 10. Никто ничего не ждёт руками.
#
# ЧТО ДЕЛАЕТ по каждой персоне:
#   1. обложка заново из ЧИСТОГО оригинала (fixcover.cjs: source_cover или refs/<персона>.jpg,
#      один хук, поверх текста никогда не пишем);
#   2. рилс 4:5 с проверенным отрывком музыки (magosreels.cjs);
#   3. накопил 10 штук, отправил в телеграм (tgblast.cjs) и пошёл дальше.
#
# Запуск: ./pipeline.sh персона1 персона2 ...     (или: ./pipeline.sh --file /tmp/list.txt)
set -u
cd /Users/qq/Desktop/neironka-poster
LOG=/tmp/pipeline.log
SCR=/private/tmp/claude-501/-Users-qq-untitled-folder/d42590c4-d66b-4f34-8988-d11faef6f654/scratchpad
OUT=$SCR/pipe_reels
WAVE=$SCR/pipe_wave
say() { print -r -- "[$(date +%H:%M:%S)] $*" >> $LOG }

if [[ "${1:-}" == "--file" ]]; then
  PERSONAS=("${(@f)$(<${2})}")
else
  PERSONAS=("$@")
fi

: > $LOG
rm -rf $OUT $WAVE; mkdir -p $OUT $WAVE/reels
say "конвейер начал, персон: ${#PERSONAS[@]}"

sent=0; built=0; failed=0; n=0
flush_wave() {
  local cnt=$(ls $WAVE/reels/*.mp4 2>/dev/null | wc -l | tr -d ' ')
  [[ "$cnt" -eq 0 ]] && return
  # Манифест для отправлялки строим из базы: номер, файл, персона, короткий id поста.
  # ФИЛЬТР ПО СКЛАДУ ОБЯЗАТЕЛЕН (09.08). Запрос брал ПОСЛЕДНИЙ пост персоны с четырьмя кадрами
  # вообще, без оглядки на статус: если у девочки есть уже опубликованный пост другого шаблона,
  # свежее нашего, подпись рилса приезжала от НЕГО (чужой шаблон, чужой хук, чужие теги). Берём
  # только тот же склад, из которого рилс и собран: backlog/approved и ещё не опубликован.
  node -e '
const fs=require("fs");const {Client}=require("pg");
const dir=process.argv[1];
const files=fs.readdirSync(dir+"/reels").filter(f=>f.endsWith(".mp4")).sort();
const c=new Client({connectionString:fs.readFileSync("/tmp/dburl.txt","utf8").trim(),ssl:{rejectUnauthorized:false}});
(async()=>{await c.connect();const L=[];
for(const [i,f] of files.entries()){
  const p=f.replace(/^reel_\d+_/,"").replace(/\.mp4$/,"");
  const r=await c.query("select left(id::text,8) id from posts where meta->>'"'"'persona'"'"'=$1 and jsonb_array_length(meta->'"'"'image_urls'"'"')=4 and status in ('"'"'backlog'"'"','"'"'approved'"'"') and published_at is null order by created_at desc limit 1",[p]);
  if(r.rows[0]) L.push((i+1)+". "+f+" — персона "+p+", пост "+r.rows[0].id);
}
fs.writeFileSync(dir+"/magos-reels-состав.txt",L.join("\n"));await c.end();})()' $WAVE
  say "отправляю волну: $cnt шт."
  node tgblast.cjs $WAVE/reels >> $LOG 2>&1
  local okc=$(grep -c "✅" $LOG)
  sent=$((sent+cnt))
  say "волна ушла, всего отправлено: $sent"
  rm -rf $WAVE; mkdir -p $WAVE/reels
}

for p in $PERSONAS; do
  [[ -z "$p" ]] && continue
  n=$((n+1))
  say "($n/${#PERSONAS[@]}) $p: обложка из чистого оригинала"
  if ! TG_OFF=1 node fixcover.cjs "$p" >> $LOG 2>&1; then
    say "  ✗ $p: обложка не перенанесена, пропускаю"; failed=$((failed+1)); continue
  fi
  say "($n/${#PERSONAS[@]}) $p: собираю рилс"
  if PERSONA_LIKE="$p" REEL_ASPECT=4:5 OUT_DIR=$OUT node magosreels.cjs 1 >> $LOG 2>&1; then
    f=$(ls -t $OUT/*_${p}.mp4 2>/dev/null | head -1)
    if [[ -n "${f:-}" ]]; then
      cp "$f" "$WAVE/reels/reel_$(printf %02d $((built+1)))_${p}.mp4"
      built=$((built+1)); say "  ✅ $p готов (собрано всего: $built)"
    else
      say "  ✗ $p: рилс не найден после сборки"; failed=$((failed+1))
    fi
  else
    say "  ✗ $p: сборка рилса упала"; failed=$((failed+1))
  fi
  # Пачка набралась, отправляем и продолжаем.
  [[ $(ls $WAVE/reels/*.mp4 2>/dev/null | wc -l | tr -d ' ') -ge 10 ]] && flush_wave
done

flush_wave
say "КОНВЕЙЕР ЗАКОНЧИЛ: собрано $built, отправлено $sent, ошибок $failed"
