// ПЛАНИРОВЩИК ПАЧКИ (масс-постинг по моделям, 01.08).
// Задача: владелец кидает N роликов, мы раскладываем их по времени так, чтобы не сжечь аккаунты.
// Уроки проекта, зашитые в правила:
//   • 21.07 акки жгло ОБЪЁМОМ на сыром свежаке → лестница «сколько постов в сутки» по возрасту акка;
//   • 01.08 один ролик на связанных акках = склейка по перцептивному хэшу и поведению → один media_url
//     не ставим двум аккам одной модели ближе чем через 48ч (и только явным mirror);
//   • публикация идёт окно-за-окном на маке → между любыми двумя постами сети держим паузу.
// Планировщик НИЧЕГО не пишет в БД: он возвращает план, запись делает вызывающий (api).
import { query } from './db/index.js';

const PRIME_HOURS = [9, 13, 19, 21];      // те же прайм-часы, что у одиночного постинга
const NIGHT_START = 2, NIGHT_END = 7;     // ночная тишина
const NETWORK_GAP_MIN = 30;               // между любыми двумя постами всей сети
const SPARE_GAP_H = 6;                    // между основным и запасным одной модели
const PERSONA_DAILY_CAP = 8;              // на модель в сутки: 2 акка × 4 публикации
const NETWORK_DAILY_CAP = 32;             // на сеть: 8 акков × 4 публикации
const HORIZON_DAYS = 7;                   // дальше не планируем: состояние акков меняется

export interface BatchItem { persona: string; video_url: string; caption?: string; target?: 'main' | 'spare'; }
export interface PlanRow {
  persona: string; target: 'main' | 'spare'; account_id: string | null; handle: string | null;
  video_url: string; caption: string | null; at: Date | null; reason: string; ok: boolean;
}

// Сколько постов в сутки можно этому акку.
// Решение владельца 02.08: держим ДВА поста в день. Возраст всё равно учитываем — акку первых
// суток два поста подряд дались бы тяжело, поэтому у совсем свежих остаётся один, а со второго
// дня выходим на два. Старые акки могут три.
// ОГОВОРКА, которую важно помнить: два поста в день на молодой акк — это осознанно принятый риск,
// а не безопасный режим. 01.08 мы уже видели, что второй пост Дарьи за день собрал меньше первого.
// Решение владельца 03.08: держим ЧЕТЫРЕ публикации в день — 1 ролик + 3 рилса из фотопостов.
// Это осознанный риск: 21.07 акки жгло именно объёмом на сыром свежаке. Поэтому лестница по
// возрасту остаётся — день первый живёт на одной публикации, дальше выходим на четыре, и только
// у совсем старых акков потолок выше.
export function dailyCapFor(createdAt: Date | null, warmupAt: Date | null, now: Date): number {
  const base = warmupAt || createdAt;
  if (!base) return 1;
  const days = Math.floor((now.getTime() - new Date(base).getTime()) / 86400000);
  if (days < 1) return 1;      // день заведения: одна публикация, акк ещё «сырой»
  if (days < 3) return 2;      // первые сутки-трое: разгоняемся плавно
  if (days <= 30) return 4;    // рабочий режим: 1 видео + 3 рилса
  return 5;
}

// Ближайший прайм-слот не раньше `from`, с джиттером ±20 мин, минуя ночную тишину.
function nextPrime(from: Date, seed: number): Date {
  const d = new Date(from);
  for (let i = 0; i < 24 * HORIZON_DAYS; i++) {
    const h = d.getHours();
    if (PRIME_HOURS.includes(h) && !(h >= NIGHT_START && h < NIGHT_END) && d > from) {
      const jitter = ((seed % 41) - 20) * 60000;   // детерминированный джиттер, ±20 мин
      return new Date(d.getTime() + jitter);
    }
    d.setHours(d.getHours() + 1, 0, 0, 0);
  }
  return new Date(from.getTime() + 3600000);
}

/**
 * Строит план публикаций. Ничего не пишет: возвращает строки с временем и причиной,
 * чтобы владелец увидел раскладку ДО записи (dry-run) и подтвердил.
 */
export async function planBatch(items: BatchItem[], now = new Date()): Promise<PlanRow[]> {
  // Акки моделей + их возраст и уже опубликованное за сутки
  const accs = await query<Record<string, any>>(
    `SELECT a.id, a.persona, a.is_spare, coalesce(a.ig_login,a.slug) handle, a.created_at, a.warmup_started_at,
            a.session_status, a.status, coalesce(a.ig_status,'') ig_status, a.health_state, a.dressed_at,
            (coalesce(a.ig_cookies::text,'')<>'') has_cookies,
            (SELECT count(*) FROM posts p WHERE p.account_id=a.id AND p.status='published'
               AND p.published_at > now() - interval '24 hours') today_n,
            (SELECT max(p.scheduled_at) FROM posts p WHERE p.account_id=a.id
               AND p.status IN ('approved','publishing')) last_planned
       FROM accounts a
      WHERE a.persona IS NOT NULL AND a.persona<>'' AND a.deleted_at IS NULL`);

  // Последний уже занятый слот сети (учитываем и опубликованное, и запланированное)
  const netRow = await query<Record<string, any>>(
    `SELECT max(x) t FROM (
       SELECT max(published_at) x FROM posts WHERE published_at > now() - interval '2 days'
       UNION ALL SELECT max(scheduled_at) FROM posts WHERE status='approved') s`);
  let lastNet: Date = netRow.rows[0]?.t ? new Date(netRow.rows[0].t) : new Date(now.getTime() - 3600000);
  if (lastNet < now) lastNet = now;

  // Что уже опубликовано этим аккаунтом (для дедупа контента)
  const seen = await query<Record<string, any>>(
    `SELECT account_id, media_url FROM posts WHERE media_url IS NOT NULL
       AND created_at > now() - interval '7 days'`);
  const usedByAcc = new Set(seen.rows.map((x) => `${x.account_id}|${x.media_url}`));

  const perAccPlanned = new Map<string, number>();     // сколько НОВЫХ постов уже положили в план
  const perPersonaPlanned = new Map<string, number>();
  let netPlanned = 0;
  const lastByAcc = new Map<string, Date>();
  const lastByPersona = new Map<string, Date>();
  const plan: PlanRow[] = [];

  for (const [i, it] of items.entries()) {
    const target: 'main' | 'spare' = it.target === 'spare' ? 'spare' : 'main';
    const acc = accs.rows.find((a) => a.persona === it.persona && (!!a.is_spare) === (target === 'spare'));
    const row: PlanRow = {
      persona: it.persona, target, account_id: acc?.id ?? null, handle: acc?.handle ?? null,
      video_url: it.video_url, caption: it.caption ?? null, at: null, reason: '', ok: false,
    };

    if (!acc) { row.reason = `нет ${target === 'spare' ? 'запасного' : 'основного'} аккаунта у модели`; plan.push(row); continue; }
    // Гейты здоровья: не планируем на то, что заведомо не опубликуется
    if (acc.status === 'paused') { row.reason = 'аккаунт на паузе'; plan.push(row); continue; }
    if (['restricted', 'suspended', 'captcha', 'challenge'].includes(acc.ig_status) || acc.health_state === 'restricted') {
      row.reason = 'аккаунт ограничен IG'; plan.push(row); continue;
    }
    if (!acc.has_cookies) { row.reason = 'нет кук — постер не откроет'; plan.push(row); continue; }
    // Не планируем на неподготовленный акк: там ещё чужая ава и чужие посты (урок 02.08).
    if (!acc.dressed_at) { row.reason = 'акк не оформлен — сначала ава и чистка чужих постов'; plan.push(row); continue; }
    // Выдержка после оформления: свежеоформленный акк в постинг не пускаем (см. worker.ts).
    const dressedAgoH = (now.getTime() - new Date(acc.dressed_at).getTime()) / 3600000;
    if (dressedAgoH < 6) {
      row.reason = `акк оформлен ${Math.round(dressedAgoH)}ч назад — ждём 6ч (решение владельца 03.08)`;
      plan.push(row); continue;
    }
    if (acc.session_status !== 'live') { row.reason = 'сессия не подтверждена'; plan.push(row); continue; }
    if (usedByAcc.has(`${acc.id}|${it.video_url}`)) { row.reason = 'этот ролик уже был на этом аккаунте'; plan.push(row); continue; }

    // Лимиты: на акк (по возрасту), на модель, на сеть
    const cap = dailyCapFor(acc.created_at, acc.warmup_started_at, now);
    const already = Number(acc.today_n || 0) + (perAccPlanned.get(acc.id) || 0);
    if (already >= cap) { row.reason = `суточный лимит аккаунта исчерпан (${cap}/сут, возраст акка)`; plan.push(row); continue; }
    if ((perPersonaPlanned.get(it.persona) || 0) >= PERSONA_DAILY_CAP) { row.reason = `лимит модели ${PERSONA_DAILY_CAP}/сут`; plan.push(row); continue; }
    if (netPlanned >= NETWORK_DAILY_CAP) { row.reason = `лимит сети ${NETWORK_DAILY_CAP}/сут`; plan.push(row); continue; }

    // Время: не раньше паузы сети, не раньше личных интервалов
    let at = new Date(Math.max(lastNet.getTime() + NETWORK_GAP_MIN * 60000, now.getTime() + 120000));
    const prevAcc = lastByAcc.get(acc.id) || (acc.last_planned ? new Date(acc.last_planned) : null);
    if (prevAcc) at = new Date(Math.max(at.getTime(), prevAcc.getTime() + 5 * 3600000));   // 5ч между постами акка
    const prevPersona = lastByPersona.get(it.persona);
    if (prevPersona && target === 'spare') at = new Date(Math.max(at.getTime(), prevPersona.getTime() + SPARE_GAP_H * 3600000));
    at = nextPrime(at, i * 7 + it.persona.length);

    row.at = at; row.ok = true;
    row.reason = `слот ${at.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` +
      ` · лимит акка ${already + 1}/${cap}`;
    plan.push(row);

    lastNet = at; lastByAcc.set(acc.id, at); lastByPersona.set(it.persona, at);
    perAccPlanned.set(acc.id, (perAccPlanned.get(acc.id) || 0) + 1);
    perPersonaPlanned.set(it.persona, (perPersonaPlanned.get(it.persona) || 0) + 1);
    netPlanned++;
  }
  return plan;
}
