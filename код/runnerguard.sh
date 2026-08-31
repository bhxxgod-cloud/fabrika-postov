#!/bin/bash
# СТОРОЖ ЛОКАЛЬНОГО РАННЕРА (перевыпуск 07.08 после третьего инцидента «очередь стоит молча»).
#
# ЧТО СЛУЧИЛОСЬ. Девять постов раздали на девять аккаунтов, задачи легли в local_jobs со статусом
# queued, раннер был жив по ps, но его лог не двигался 40 минут: он стоял на запросе к базе без
# таймаута. Начальник видел «ничего не произошло». Помогло только ручное убийство.
#
# ЧЕМ ЭТОТ СТОРОЖ ОТЛИЧАЕТСЯ ОТ ПРЕЖНЕГО (три его дыры, каждая делала его бесполезным):
#   1. Он смотрел на /tmp/localrunner.log, а рабочий лог давно /tmp/localrunner_main.log. Файл не
#      менялся с прошлых суток, то есть «возраст лога» у него был всегда огромным.
#   2. Признаком жизни он считал mtime лога. Это ложный признак в обе стороны: раннер молчит в
#      логе и когда работает (публикация идёт молча внутри дочернего процесса), и наоборот, лог
#      может дописать дочерний процесс, когда сам раннер уже завис.
#   3. Перезапуск делался через `pkill -f "node localrunner.cjs"`, то есть убивал ВСЕ раннеры
#      сразу, включая тот, который в этот момент нормально публиковал.
# Теперь признак жизни это ФАЙЛ СЕРДЦЕБИЕНИЯ, который пишет сам раннер (/tmp/localrunner.beat), и
# в нём главное поле не «я жив», а tick_at: время последнего УСПЕШНОГО опроса очереди. Зависший на
# запросе к базе процесс продолжал бы писать «жив», но tick_at у него застывает, и именно это
# отличает живой простой от зависания. Гасим строго по pid, по одному, и только процессы, у
# которых в командной строке стоит наш скрипт. Orbita и gologin не трогаем НИКОГДА.
#
# Запуск:  cd /Users/qq/Desktop/neironka-poster && nohup ./runnerguard.sh >/dev/null 2>&1 &
# Лог:     /tmp/runnerguard.log     Стоп: kill "$(cat /tmp/runnerguard.lock/pid)"
# Осмотр без действий: GUARD_DRY=1 ./runnerguard.sh   (пишет решения в лог, никого не трогает)
set -u
DIR="/Users/qq/Desktop/neironka-poster"
LOG="${GUARD_LOG:-/tmp/runnerguard.log}"
RLOG="${RUNNER_LOG:-/tmp/localrunner_main.log}"   # куда дописывает вывод поднятый нами раннер
BEAT="${RUNNER_BEAT:-/tmp/localrunner.beat}"      # метка сердцебиения, её пишет сам раннер
LOCKDIR="${GUARD_LOCK:-/tmp/runnerguard.lock}"
EVERY="${GUARD_EVERY:-60}"            # проверяем часто, вмешиваемся редко
STALE_TICK="${GUARD_STALE_TICK:-600}" # 10 мин без успешного опроса очереди = завис (порог из задачи)
STALE_BEAT="${GUARD_STALE_BEAT:-780}" # 13 мин без удара сердца = процесс замер целиком (удар раз в 5 мин)
JOB_MAX="${GUARD_JOB_MAX:-1800}"      # 30 мин на одну задачу: у раннера таймаут 20 мин плюс запас
COOLDOWN="${GUARD_COOLDOWN:-600}"     # не перезапускать чаще раза в 10 минут
DRY="${GUARD_DRY:-0}"
RUNNER="localrunner.cjs"
# GUARD_MATCH — метка «мои раннеры». В проде пусто: сторож обязан считать своим ЛЮБОЙ раннер,
# включая поднятый руками, иначе ручной запуск остался бы без присмотра. Метка нужна проверкам:
# с ней сторож видит только раннеры, запущенные им самим (`--tag <метка>` в командной строке), и
# приёмка не может случайно погасить рабочий раннер, поднятый другим чатом.
MATCH="${GUARD_MATCH:-}"

cd "$DIR" || exit 1
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# ── СИНГЛТОН ЧЕРЕЗ КАТАЛОГ (как в accjanitorloop.sh) ──────────────────────────────────────────
# mkdir атомарен, поэтому два запуска в одну секунду не разойдутся. Через pgrep синглтон делать
# нельзя: в runners3.sh шаблон `pgrep -f "RUNNER_ID=$N node localrunner.cjs"` не совпадает никогда,
# потому что присваивание переменной окружения выполняет шелл и в argv процесса его нет.
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  OLD="$(cat "$LOCKDIR/pid" 2>/dev/null || echo '')"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null && ps -o command= -p "$OLD" 2>/dev/null | grep -q runnerguard; then
    log "сторож уже работает (pid $OLD), выхожу"; exit 0
  fi
  rm -rf "$LOCKDIR" && mkdir "$LOCKDIR" || exit 1
fi
echo $$ > "$LOCKDIR/pid"
CHILD=""
cleanup() { [ -n "$CHILD" ] && kill "$CHILD" 2>/dev/null; rm -rf "$LOCKDIR"; }
trap 'cleanup; exit 0' INT TERM
trap 'cleanup' EXIT
# Спим и считаем факты в ФОНЕ с wait: пока bash ждёт обычную команду переднего плана, он
# откладывает обработку сигнала до её конца, и `kill` сторожа не сработал бы целую минуту.
runc() { "$@" & CHILD=$!; wait "$CHILD" 2>/dev/null; CHILD=""; }

# ── ФАКТЫ: МЕТКА СЕРДЦЕБИЕНИЯ + ОЧЕРЕДЬ В БАЗЕ ───────────────────────────────────────────────
# Одним заходом node: разбираем метку и спрашиваем базу, есть ли РЕАЛЬНАЯ работа (задачи queued,
# у которых срок уже подошёл: пост со слотом в будущем это не простой, а ожидание). Печатаем
# строку key=value, решения принимает шелл.
# ВАЖНО: в тексте этой программы НЕ должно быть имени скрипта раннера, иначе pgrep ниже поймает
# сам этот node и решит, что раннеров два.
PROBE='
const fs=require("fs");
const o={beat_pid:0,phase:"нет",job:0,beat_age:999999,tick_age:999999,job_age:0,db_err:0,due:0,due_old:0,stale_run:0,db:"ok"};
try{
  const b=JSON.parse(fs.readFileSync(process.env.RUNNER_BEAT,"utf8"));
  o.beat_pid=Number(b.pid||0); o.phase=String(b.phase||"?"); o.job=Number(b.job_id||0);
  o.beat_age=Math.round((Date.now()-Date.parse(b.beat_at))/1000);
  o.tick_age=b.tick_at?Math.round((Date.now()-Date.parse(b.tick_at))/1000):999999;
  o.job_age=b.job_since?Math.round((Date.now()-Date.parse(b.job_since))/1000):0;
  o.db_err=b.db_error?1:0;
}catch(e){}
const {Client}=require("pg");
const c=new Client({connectionString:fs.readFileSync("/tmp/dburl.txt","utf8").trim(),
  ssl:{rejectUnauthorized:false},keepAlive:true,connectionTimeoutMillis:10000,query_timeout:20000});
(async()=>{
  try{
    await c.connect();
    const r=await c.query(`SELECT
      count(*) FILTER (WHERE j.status=$s$queued$s$ AND (j.mode<>$s$igpost$s$ OR p.scheduled_at IS NULL OR p.scheduled_at<=now())) due,
      coalesce(max(extract(epoch from (now()-j.created_at))/60) FILTER (WHERE j.status=$s$queued$s$
        AND (j.mode<>$s$igpost$s$ OR p.scheduled_at IS NULL OR p.scheduled_at<=now())),0)::int due_old,
      count(*) FILTER (WHERE j.status=$s$running$s$ AND j.updated_at < now()-interval $s$45 minutes$s$) stale_run
      FROM local_jobs j LEFT JOIN posts p ON p.id::text=j.urls
      WHERE j.status IN ($s$queued$s$,$s$running$s$)`);
    o.due=Number(r.rows[0].due); o.due_old=Number(r.rows[0].due_old); o.stale_run=Number(r.rows[0].stale_run);
  }catch(e){ o.db="err"; }
  try{ await c.end(); }catch(e){}
  console.log(Object.entries(o).map(([k,v])=>k+"="+v).join(" "));
})();
'

# ── РАБОТА С ПРОЦЕССАМИ: ТОЛЬКО ПО PID И ТОЛЬКО СВОЙ СКРИПТ ──────────────────────────────────
runner_pids() {
  # pgrep по argv; шаблон требует «node …/localrunner.cjs». Каждый pid ещё раз проверяем по ps и
  # выбрасываем всё, что запущено как `node -e` (это мог быть наш собственный опрос базы).
  local p out=""
  for p in $(pgrep -f "node .*${RUNNER}" 2>/dev/null); do
    local cmd; cmd="$(ps -o command= -p "$p" 2>/dev/null || echo '')"
    case "$cmd" in
      *" -e "*) continue ;;
      *node*${RUNNER}*)
        if [ -n "$MATCH" ]; then case "$cmd" in *"--tag $MATCH"*) ;; *) continue ;; esac; fi
        out="$out $p" ;;
    esac
  done
  echo "${out# }"
}
proc_age() {      # сколько секунд живёт процесс $1. На маке у ps НЕТ поля etimes (это linux),
                  # поэтому разбираем etime вида [[дни-]часы:]минуты:секунды сами.
  local e d h m s
  e="$(ps -o etime= -p "$1" 2>/dev/null | tr -d ' ')"
  [ -z "$e" ] && { echo 0; return; }
  d=0; h=0; m=0; s=0
  case "$e" in *-*) d="${e%%-*}"; e="${e#*-}" ;; esac
  local IFS=:
  set -- $e
  if [ $# -eq 3 ]; then h="$1"; m="$2"; s="$3"; elif [ $# -eq 2 ]; then m="$1"; s="$2"; else s="$1"; fi
  echo $(( 10#${d:-0} * 86400 + 10#${h:-0} * 3600 + 10#${m:-0} * 60 + 10#${s:-0} ))
}
kill_runner() {   # $1 = pid, $2 = причина
  local p="$1" why="$2" cmd
  cmd="$(ps -o command= -p "$p" 2>/dev/null || echo '')"
  case "$cmd" in
    *node*${RUNNER}*) ;;
    # Двойной предохранитель: если в командной строке нет нашего скрипта, НЕ трогаем ничего.
    # Никаких pkill по шаблонам: Orbita и профили gologin гасить нельзя ни при каких условиях,
    # это сносит окна фермы и личные окна начальника.
    *) log "отказ убивать pid $p: это не раннер ($cmd)"; return 1 ;;
  esac
  if [ "$DRY" = "1" ]; then log "[смотр] убил бы pid $p ($why)"; return 0; fi
  log "гашу раннер pid $p: $why"
  kill -TERM "$p" 2>/dev/null
  local i=0
  while [ $i -lt 10 ] && kill -0 "$p" 2>/dev/null; do runc sleep 1; i=$((i+1)); done
  if kill -0 "$p" 2>/dev/null; then log "pid $p не ушёл по TERM, добиваю KILL"; kill -9 "$p" 2>/dev/null; fi
  return 0
}
start_runner() {  # $1 = причина
  if [ "$DRY" = "1" ]; then log "[смотр] поднял бы раннер ($1)"; return 0; fi
  # Ключ vision передаём из файла: у поднятого нами раннера должно быть то же окружение, что у
  # запущенного руками. stderr обязательно в лог: сегодня раннер умер молча именно потому, что
  # его ошибки не попадали никуда.
  local ORKEY=""; [ -f /tmp/orkey.txt ] && ORKEY="$(tr -d '\n' < /tmp/orkey.txt)"
  # Настройки раннера пробрасываем те же, с которыми запустили сторожа: иначе поднятый после
  # зависания раннер оказался бы с другим поведением, чем убитый (на проверке это ловушка: сторож
  # поднимал бы раннер без ограничения режимов и тот брал бы настоящие публикации).
  local TAG=""; [ -n "$MATCH" ] && TAG="--tag $MATCH"
  ( cd "$DIR" && OPENROUTER_API_KEY="$ORKEY" RUNNER_BEAT="$BEAT" \
      RUNNER_MODES="${RUNNER_MODES:-}" POLL_SEC="${POLL_SEC:-8}" BEAT_SEC="${BEAT_SEC:-300}" \
      nohup node "$RUNNER" $TAG >> "$RLOG" 2>&1 & )
  LAST_START=$(date +%s)
  log "поднял раннер ($1), лог $RLOG"
}

LAST_START=0
LAST_RESTART=0
LAST_OK_REPORT=0
LAST_WARN=0
FAIL_STREAK=0
log "=== сторож раннера запущен (pid $$): проверка каждые ${EVERY} с, порог зависания ${STALE_TICK} с, метка $BEAT, dry=$DRY"

while true; do
  NOW=$(date +%s)
  FACTS="$(RUNNER_BEAT="$BEAT" node -e "$PROBE" 2>/dev/null)"
  # Пустой ответ означает, что не запустился сам node (факты собрать не удалось), а НЕ то, что
  # раннер плохой. Судить в этом случае нельзя: без оговорки мы бы прочитали «метки нет» и убили
  # здоровый раннер из-за своей же проблемы.
  if [ -z "$FACTS" ]; then log "не собрал факты (не отработал node), круг пропускаю"; runc sleep "$EVERY"; continue; fi
  beat_pid=0; phase="нет"; job=0; beat_age=999999; tick_age=999999; job_age=0; db_err=0; due=0; due_old=0; stale_run=0; db=ok
  for kv in $FACTS; do case "$kv" in *=*) eval "${kv%%=*}='${kv#*=}'" ;; esac; done
  PIDS="$(runner_pids)"; N=$(echo $PIDS | wc -w | tr -d ' ')

  # 1. РАННЕРОВ НЕТ. Поднимаем всегда, а не только когда очередь непустая: задача может лечь в
  #    любую секунду, и ждать её, лежа, значит снова получить «ничего не произошло».
  if [ "$N" -eq 0 ]; then
    # Защита от бесконечной карусели: если раннер падает сразу после старта (например база
    # недоступна), не дёргаем его каждую минуту, а расходимся по backoff и пишем это в лог.
    SINCE_START=$(( NOW - LAST_START ))
    if [ "$LAST_START" -gt 0 ] && [ "$SINCE_START" -lt 90 ]; then
      FAIL_STREAK=$((FAIL_STREAK+1))
      BACK=$(( FAIL_STREAK * 60 )); [ "$BACK" -gt 600 ] && BACK=600
      log "раннер умер через ${SINCE_START} с после старта (подряд $FAIL_STREAK), жду ${BACK} с. Очередь: due=$due, самая старая $due_old мин, база=$db"
      runc sleep "$BACK"
    else
      FAIL_STREAK=0
    fi
    start_runner "процесса не было; очередь due=$due (старшая $due_old мин)"
    runc sleep "$EVERY"; continue
  fi

  # 2. РАННЕРОВ БОЛЬШЕ ОДНОГО. Правило CONC=1: две сессии на один аккаунт это самый надёжный
  #    способ его убить. Оставляем того, кто владеет меткой сердцебиения (он точно работает),
  #    остальных гасим по одному pid. Прежний сторож здесь делал pkill и убивал всех.
  if [ "$N" -gt 1 ]; then
    KEEP=""
    for p in $PIDS; do [ "$p" = "$beat_pid" ] && KEEP="$p"; done
    [ -z "$KEEP" ] && KEEP="$(echo $PIDS | awk '{print $NF}')"
    log "раннеров $N (pids: $PIDS), оставляю $KEEP, остальных гашу (CONC=1)"
    for p in $PIDS; do [ "$p" != "$KEEP" ] && kill_runner "$p" "лишний раннер, работать должен один"; done
    runc sleep "$EVERY"; continue
  fi

  PID="$PIDS"
  AGE_PROC="$(proc_age "$PID")"
  SINCE_RESTART=$(( NOW - LAST_RESTART ))
  REASON=""

  # 3. РЕШЕНИЕ О ЗАВИСАНИИ. Порядок проверок от самого грубого признака к самому тонкому.
  if [ "$beat_age" -ge 999999 ] && [ "$AGE_PROC" -gt 180 ]; then
    REASON="метки сердцебиения нет вовсе, а процесс живёт ${AGE_PROC} с (старый раннер без сердцебиения либо метка не пишется)"
  elif [ "$beat_age" -gt "$STALE_BEAT" ]; then
    REASON="сердце молчит ${beat_age} с (порог ${STALE_BEAT}): процесс замер целиком"
  elif [ "$phase" = "job" ] && [ "$job_age" -gt "$JOB_MAX" ]; then
    REASON="задача #$job идёт ${job_age} с (порог ${JOB_MAX}): публикатор не уложился даже в свой таймаут"
  elif [ "$phase" != "job" ] && [ "$tick_age" -gt "$STALE_TICK" ]; then
    # ЭТО И ЕСТЬ СЛУЧАЙ ИНЦИДЕНТА: сердце бьётся (таймер живёт), но очередь не опрашивается,
    # значит цикл стоит на запросе к базе. Раньше такое состояние было снаружи неотличимо от
    # нормального простоя, и его никто не ловил.
    REASON="очередь не опрашивалась ${tick_age} с (порог ${STALE_TICK}), фаза «$phase»: цикл стоит"
  fi
  # ОГОВОРКА ПРО НЕДОСТУПНУЮ БАЗУ. Если база не отвечает И раннеру, И сторожу, виноват не раннер:
  # перезапуск ничего не лечит, а карусель «убил, поднял» каждые 10 минут только мусорит лог и
  # теряет работу. Замер процесса (сердце молчит) это отдельный случай, там перезапуск нужен.
  if [ -n "$REASON" ] && [ "$db" = "err" ] && [ "$db_err" = "1" ] && [ "$beat_age" -le "$STALE_BEAT" ]; then
    log "раннер жив (сердце ${beat_age} с назад), но база не отвечает ни ему, ни мне: не перезапускаю, это не он. ($REASON)"
    REASON=""
  fi

  if [ -n "$REASON" ]; then
    if [ "$SINCE_RESTART" -lt "$COOLDOWN" ] && [ "$LAST_RESTART" -gt 0 ]; then
      log "признак зависания ($REASON), но перезапуск был ${SINCE_RESTART} с назад, жду кулдаун ${COOLDOWN} с"
    else
      log "ЗАВИСАНИЕ: $REASON. Очередь: due=$due (старшая $due_old мин), зависших running=$stale_run, база=$db"
      if kill_runner "$PID" "$REASON"; then
        start_runner "после зависания"
        LAST_RESTART=$(date +%s)
      fi
    fi
    runc sleep "$EVERY"; continue
  fi

  # 4. РАННЕР ЖИВ И ОПРАШИВАЕТ ОЧЕРЕДЬ, А ЗАДАЧИ ВСЁ РАВНО СТОЯТ. Перезапуск тут не помогает
  #    (он и так работает), поэтому не трогаем, а ГРОМКО пишем: это либо дыра ретраев, либо
  #    задача, которую отбор в SQL не берёт. Такой случай надо разбирать глазами.
  #    Жалуемся не чаще раза в 15 минут: иначе одна непонятая задача превращает лог сторожа в
  #    стену, в которой не видно настоящих событий.
  if [ "$due" -gt 0 ] && [ "$due_old" -gt 10 ] && [ "$phase" = "idle" ] && [ "$tick_age" -lt 300 ] \
     && [ $(( NOW - LAST_WARN )) -ge 900 ]; then
    LAST_WARN=$NOW
    log "⚠ раннер жив и опрашивает очередь (${tick_age} с назад), но $due задач стоят, старшая ${due_old} мин. Перезапуск не поможет, смотреть глазами: отбор задачи в SQL, дыра ретраев или ограничение режимов у раннера"
  fi
  if [ "$stale_run" -gt 0 ]; then
    log "в running висит $stale_run задач старше 45 мин (их подметает предохранитель на сердцебиении раннера)"
  fi

  # Раз в полчаса отчёт «всё в порядке», чтобы по логу сторожа было видно, что он сам жив.
  if [ $(( NOW - LAST_OK_REPORT )) -ge 1800 ]; then
    LAST_OK_REPORT=$NOW
    WHAT=""; [ "$job" != "0" ] && WHAT=", задача #$job"
    log "порядок: раннер pid $PID (живёт ${AGE_PROC} с), фаза «$phase»${WHAT}, опрос ${tick_age} с назад, сердце ${beat_age} с назад, очередь due=$due, база=$db"
  fi
  runc sleep "$EVERY"
done
