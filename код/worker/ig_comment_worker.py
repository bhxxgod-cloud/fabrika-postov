"""
Ферма комментов Instagram через приватный API (instagrapi).
Заходит по КУКАМ (sessionid) + прокси на аккаунт — без браузера, масштабируется.
Панель (Node) кладёт акки/куки/прокси/хэштеги в общую БД, воркер их выполняет
и пишет пульс в worker_heartbeat + логи в seed_comments.
"""
import os, time, json, random, urllib.parse, datetime

import requests
import psycopg2
import psycopg2.extras
from instagrapi import Client

DB = os.environ["DATABASE_URL"]
POLL = int(os.environ.get("SEED_POLL_SEC", "150"))

# РАДАР: как часто сканировать хэштеги и какой vision-моделью смотреть картинки.
RADAR_EVERY = int(os.environ.get("RADAR_EVERY_SEC", "900"))
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
VISION_MODEL = os.environ.get("RADAR_VISION_MODEL", "openai/gpt-4o-mini")
# Сигналы спроса в комментах: люди спрашивают, ЧЕМ/ГДЕ это сделано.
DEMAND_WORDS = [
    "как ты", "как это", "как сдела", "чем сдела", "где сдела", "в чём", "в чем",
    "какая нейрос", "какой нейрос", "что за прил", "какое прил", "какая прог", "что за прог",
    "чем дела", "как повтор", "как генери", "в какой", "подскаж", "скинь", "что использ",
]
CAP_WORDS = ["нейросет", "нейронк", "промпт", "сгенер", "нейро", "midjourney", "kling", "veo",
             "chatgpt", "оживил", "ии ", "#ии", "ai"]

# Ненавязчивые упоминания (без ссылок — IG режет ссылки). Вариативность = меньше палева.
MENTIONS = [
    "я такое в нейронке про делаю, там всё в куче 🙌",
    "через нейронку про генерю, удобно и по-русски",
    "делала в neironka, без впн работает",
    "нейронка про, там все нейросети вместе",
    "я в нейронке про — и картинки, и тексты в одном месте",
    "ищи нейронка про, там прям всё есть ✨",
]


def db():
    return psycopg2.connect(DB)


def heartbeat(conn, status, note=""):
    with conn.cursor() as c:
        c.execute(
            """INSERT INTO worker_heartbeat (worker,last_seen,status,note)
               VALUES ('ig_comment', now(), %s, %s)
               ON CONFLICT (worker) DO UPDATE SET last_seen=now(), status=EXCLUDED.status, note=EXCLUDED.note""",
            (status, note),
        )
    conn.commit()


def log_error(conn, source, message, detail=None):
    # Пишем ошибку в app_errors, чтобы было видно на сайте. Best-effort.
    try:
        with conn.cursor() as c:
            c.execute("INSERT INTO app_errors (source, message, detail) VALUES (%s,%s,%s)",
                      (source, str(message)[:500], (str(detail)[:2000] if detail else None)))
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass


def pick_account(conn):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
        c.execute(
            """
            SELECT * FROM (
              SELECT a.id, a.slug, a.ig_cookies, a.ig_proxy, a.ig_user_agent, g.seed_hashtags, g.seed_per_day, a.seed_at,
                (SELECT count(*) FROM seed_comments s WHERE s.account_id=a.id AND s.created_at > now()-interval '1 day') AS today
              FROM accounts a JOIN account_groups g ON g.id=a.group_id
              WHERE g.seed_enabled=true AND a.platform='comments' AND a.status<>'paused'
                AND coalesce(a.ig_role,'') <> 'reader'
                AND a.ig_cookies IS NOT NULL AND coalesce(a.ig_status,'') NOT IN ('banned','challenge')
            ) t WHERE t.today < t.seed_per_day ORDER BY t.seed_at ASC NULLS FIRST LIMIT 1
            """
        )
        return c.fetchone()


def set_status(conn, aid, st):
    with conn.cursor() as c:
        c.execute("UPDATE accounts SET ig_status=%s WHERE id=%s", (st, aid))
    conn.commit()


def get_sessionid(cookies):
    for ck in cookies or []:
        if ck.get("name") == "sessionid":
            return urllib.parse.unquote(ck.get("value", ""))
    return None


def proxy_url(p):
    if not p:
        return None
    p = p.strip()
    low = p.lower()
    for sch in ("http://", "https://", "socks5://", "socks://"):
        if low.startswith(sch):
            rest = p[len(sch):]
            if "@" in rest:  # уже полноценный URL user:pass@host:port
                return p
            p = rest  # scheme://host:port:user:pass — почистим ниже
            break
    parts = [x.lstrip("/") for x in p.split(":")]  # срезаем случайные слэши в частях
    if len(parts) >= 4:  # host:port:user:pass
        return f"http://{parts[2]}:{':'.join(parts[3:])}@{parts[0]}:{parts[1]}"
    if len(parts) == 2:  # host:port
        return f"http://{parts[0]}:{parts[1]}"
    return "http://" + p


def run_one(conn, acc):
    tags = [t.strip().lstrip("#") for t in (acc["seed_hashtags"] or "").split(",") if t.strip()]
    if not tags:
        return
    # Отмечаем попытку СРАЗУ (при любом исходе), чтобы провальный акк не крутился.
    with conn.cursor() as c:
        c.execute("UPDATE accounts SET seed_at=now() WHERE id=%s", (acc["id"],))
    conn.commit()

    sid = get_sessionid(acc["ig_cookies"])
    if not sid:
        set_status(conn, acc["id"], "bad_cookies")
        return

    cl = Client()
    if acc.get("ig_user_agent"):
        cl.set_user_agent(acc["ig_user_agent"])
    pu = proxy_url(acc.get("ig_proxy"))
    if pu:
        cl.set_proxy(pu)

    try:
        cl.login_by_sessionid(sid)
    except Exception as e:
        print("[ig_comment] логин не прошёл:", str(e)[:120])
        set_status(conn, acc["id"], "bad_cookies")
        return
    set_status(conn, acc["id"], "login_ok")

    tag = random.choice(tags)
    try:
        medias = cl.hashtag_medias_recent(tag, amount=8)
    except Exception as e:
        print("[ig_comment] поиск хэштега упал:", str(e)[:120])
        medias = []
    if not medias:
        return

    media = random.choice(medias)
    text = random.choice(MENTIONS)
    try:
        cl.media_comment(media.pk, text)
        url = f"https://www.instagram.com/p/{getattr(media, 'code', '')}/"
        with conn.cursor() as c:
            c.execute(
                "INSERT INTO seed_comments (account_id,platform,target_url,text) VALUES (%s,'comments',%s,%s)",
                (acc["id"], url, text),
            )
        conn.commit()
        print(f"[ig_comment] коммент от {acc['slug']} под #{tag}: {text}")
    except Exception as e:
        msg = str(e).lower()
        print("[ig_comment] коммент не отправлен:", msg[:140])
        if "challenge" in msg:
            set_status(conn, acc["id"], "challenge")
        elif "feedback" in msg or "spam" in msg or "block" in msg:
            set_status(conn, acc["id"], "blocked")


# ==================== РАДАР (поиск постов, НЕ автокоммент) ====================
def radar_get_config(conn):
    with conn.cursor() as c:
        c.execute("SELECT tags, enabled FROM radar_config WHERE id=1")
        row = c.fetchone()
    if not row:
        return [], False
    tags = [t.strip().lstrip("#") for t in (row[0] or "").split(",") if t.strip()]
    return tags, bool(row[1])


def radar_pick_reader(conn):
    # ВЫДЕЛЕННЫЙ акк-искатель (ig_role='reader') — только для ЧТЕНИЯ хэштегов, не комментит.
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
        c.execute(
            """SELECT id, slug, ig_cookies, ig_proxy, ig_user_agent, ig_login, ig_password, ig_session
               FROM accounts
               WHERE ig_role='reader'
                 AND coalesce(ig_status,'') NOT IN ('banned','challenge','2fa','bad_login','ip_blocked')
               ORDER BY created_at ASC LIMIT 1"""
        )
        return c.fetchone()


def save_session(conn, aid, settings):
    with conn.cursor() as c:
        c.execute("UPDATE accounts SET ig_session=%s WHERE id=%s", (json.dumps(settings), aid))
    conn.commit()


def make_code_handler(conn, aid):
    """instagrapi вызовет это, когда IG попросит код с почты/смс. Ставим статус «нужен код»,
    ждём до ~5 мин, пока юзер введёт код в панели (accounts.ig_challenge_code)."""
    def handler(username, choice):
        set_status(conn, aid, "need_code")
        for _ in range(60):  # ~5 минут (по 5 сек)
            heartbeat(conn, "radar", "жду код с почты (введи в панели)")
            time.sleep(5)
            try:
                with conn.cursor() as c:
                    c.execute("SELECT ig_challenge_code FROM accounts WHERE id=%s", (aid,))
                    row = c.fetchone()
                code = (row[0] if row else None)
            except Exception:
                conn.rollback()
                code = None
            if code and code.strip():
                with conn.cursor() as c:
                    c.execute("UPDATE accounts SET ig_challenge_code=NULL WHERE id=%s", (aid,))
                conn.commit()
                return code.strip()
        return ""  # таймаут — instagrapi упадёт, покажем в логе
    return handler


def reader_client(conn, acc):
    """Логинит акк-искатель: кэш сессии -> КУКИ (приоритет, надёжнее) -> логин+пароль.
    Кэшируем сессию, чтобы НЕ логиниться заново каждый раз (свежий логин = риск чекпоинта)."""
    cl = Client()
    if acc.get("ig_user_agent"):
        cl.set_user_agent(acc["ig_user_agent"])
    pu = proxy_url(acc.get("ig_proxy"))
    if pu:
        cl.set_proxy(pu)
    # 1) Есть кэш сессии instagrapi — проверяем дешёвым запросом, вход не трогаем.
    if acc.get("ig_session"):
        try:
            cl.set_settings(acc["ig_session"])
            cl.account_info()  # живая проверка сессии
            set_status(conn, acc["id"], "login_ok")
            return cl
        except Exception:
            pass  # сессия протухла — логинимся заново ниже
    last = None
    # 2) КУКИ — приоритет: это уже существующая сессия, без CSRF-хендшейка и почти без риска.
    sid = get_sessionid(acc.get("ig_cookies"))
    if sid:
        try:
            cl.login_by_sessionid(sid)
            save_session(conn, acc["id"], cl.get_settings())
            set_status(conn, acc["id"], "login_ok")
            return cl
        except Exception as e:
            last = e
            print("[radar] куки искателя не прошли:", str(e)[:120])
    # 3) ЛОГИН+ПАРОЛЬ — свежий логин (совпадающий фингерпринт). Если IG попросит код с
    #    почты/смс — handler поставит статус «нужен код» и подождёт ввода в панели.
    if acc.get("ig_login") and acc.get("ig_password"):
        try:
            cl.challenge_code_handler = make_code_handler(conn, acc["id"])
            cl.login(acc["ig_login"], acc["ig_password"])
            save_session(conn, acc["id"], cl.get_settings())
            set_status(conn, acc["id"], "login_ok")
            return cl
        except Exception as e:
            last = e
    if last is not None:
        name = type(last).__name__
        msg = str(last).lower()
        if name == "ChallengeRequired" or "challenge" in msg or "checkpoint" in msg:
            st = "challenge"
        elif name == "TwoFactorRequired" or "two_factor" in msg or "2fa" in msg or "verification_code" in msg:
            st = "2fa"
        elif name in ("BadPassword", "BadCredentials") or "password" in msg:
            st = "bad_login"
        elif "csrf" in msg or "forbidden" in msg:
            st = "ip_blocked"  # IP дата-центра без прокси — IG режет; ставь прокси / куки
        else:
            st = None  # транзиент (сеть/прокси) — не блокируем, попробуем на след. скане
        if st:
            set_status(conn, acc["id"], st)
        print("[radar] вход искателя не прошёл (" + (st or name) + "):", str(last)[:140])
        log_error(conn, "radar-login", f"вход искателя не прошёл ({st or name})", str(last)[:400])
    return None


def vision_describe(image_url):
    if not OPENROUTER_KEY or not image_url:
        return None
    try:
        r = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENROUTER_KEY}", "Content-Type": "application/json"},
            json={"model": VISION_MODEL, "max_tokens": 180, "messages": [{"role": "user", "content": [
                {"type": "text", "text": "Это пост из Instagram в нише нейросетей. Кратко по-русски: что на картинке и какой текст на ней. И это похоже на AI-сгенерированный контент (фото/видео человека рядом с чем-то дорогим, аватар, оживление фото, арт)? Ответь СТРОГО: ОПИСАНИЕ: <1-2 предложения> | AI: да|нет"},
                {"type": "image_url", "image_url": {"url": image_url}}]}]},
            timeout=45,
        )
        return r.json()["choices"][0]["message"]["content"]
    except Exception as e:
        print("[radar] vision упал:", str(e)[:120])
        return None


def radar_scan(conn):
    tags, enabled = radar_get_config(conn)
    if not enabled or not tags:
        return
    acc = radar_pick_reader(conn)
    if not acc:
        print("[radar] нет акка-искателя — добавь его в разделе «Аккаунт для поиска»")
        heartbeat(conn, "radar", "нет акка-искателя")
        return
    cl = reader_client(conn, acc)
    if not cl:
        heartbeat(conn, "radar", f"вход искателя {acc['slug']} не прошёл")
        return

    now = datetime.datetime.now(datetime.timezone.utc)
    phrase = random.choice(tags)
    tag = phrase.replace(' ', '').lstrip('#')  # для hashtag-эндпоинта (полноценный keyword-поиск — в браузерном движке)
    heartbeat(conn, "radar", f"сканирую «{phrase}»")
    # ТОП (вирусные, часто старые но живые) в приоритете — это и есть посты со спросом
    # «как сделал». Recent — фолбэк, если топ недоступен.
    medias, read_err = None, None
    for fetch in (lambda: cl.hashtag_medias_top(tag, amount=15), lambda: cl.hashtag_medias_recent(tag, amount=15)):
        try:
            medias = fetch()
            break
        except Exception as e:
            read_err = e
    if medias is None:
        e = read_err
        msg = str(e).lower()
        # Сессия не принимается на чтение — почти всегда IP без прокси (дата-центр). Сбрасываем
        # кэш сессии и, если прокси нет, помечаем ip_blocked (перестаём долбить, ждём прокси).
        if "login_required" in msg or "forbidden" in msg or "csrf" in msg or "challenge" in msg:
            with conn.cursor() as cc:
                cc.execute("UPDATE accounts SET ig_session=NULL WHERE id=%s", (acc["id"],))
            conn.commit()
            if not acc.get("ig_proxy"):
                set_status(conn, acc["id"], "ip_blocked")
                print("[radar] искателю НУЖЕН прокси — IG не принимает сессию с дата-центра")
                heartbeat(conn, "radar", "искателю нужен прокси (ip_blocked)")
                return
            set_status(conn, acc["id"], "session_dead")
        print("[radar] чтение #" + tag + " упало:", str(e)[:100])
        heartbeat(conn, "radar", f"#{tag}: не читается")
        log_error(conn, "radar-read", f"чтение «{tag}» упало", str(e)[:400])
        return

    kept = 0
    for m in medias:
        try:
            code = getattr(m, "code", None)
            if not code:
                continue
            taken = getattr(m, "taken_at", None)
            if taken and taken.tzinfo is None:
                taken = taken.replace(tzinfo=datetime.timezone.utc)
            post_age = (now - taken).total_seconds() / 86400 if taken else 999
            caption = (getattr(m, "caption_text", "") or "")[:600]
            like_count = int(getattr(m, "like_count", 0) or 0)
            comment_count = int(getattr(m, "comment_count", 0) or 0)

            # Комменты: спрос («как/чем/где сделал») + дата ПОСЛЕДНЕГО коммента (живость).
            demand, last_comment = 0, None
            try:
                for cm in cl.media_comments(m.pk, amount=25):
                    t = (getattr(cm, "text", "") or "").lower()
                    if any(w in t for w in DEMAND_WORDS):
                        demand += 1
                    ct = getattr(cm, "created_at_utc", None) or getattr(cm, "created_at", None)
                    if ct:
                        if ct.tzinfo is None:
                            ct = ct.replace(tzinfo=datetime.timezone.utc)
                        if last_comment is None or ct > last_comment:
                            last_comment = ct
            except Exception:
                pass

            # ЖИВОСТЬ: пост актуален, пока под ним пишут. Последний коммент > 14 дней —
            # пост мёртвый/не ранжируется, мимо (даже если сам вирусный, но давно затих).
            # Нет комментов и пост старше 30 дней — тоже мимо.
            if last_comment is not None:
                activity_age = (now - last_comment).total_seconds() / 86400
                if activity_age > 14:
                    continue
            elif post_age > 30:
                continue
            else:
                activity_age = post_age

            cap_relevant = any(w in caption.lower() for w in CAP_WORDS)
            # Дешёвый фильтр: не тратим vision на явно нерелевантное.
            if demand == 0 and not cap_relevant:
                continue

            image_url = str(getattr(m, "thumbnail_url", "") or "")
            vsum = vision_describe(image_url)
            ai_content = bool(vsum) and ("AI: да" in vsum.replace("АI", "AI"))

            relevance = min(100, (min(50, demand * 12)) + (25 if cap_relevant else 0) + (25 if ai_content else 0))
            # Свежесть — по активности (живой пост важнее нового-но-мёртвого).
            freshness = max(0, 30 - int(activity_age * 2))
            engagement = min(20, comment_count // 50)
            score = relevance + freshness + engagement + min(20, demand * 5)
            url = f"https://www.instagram.com/p/{code}/"

            with conn.cursor() as c:
                c.execute(
                    """INSERT INTO radar_posts (code, tag, url, image_url, caption, like_count, comment_count, taken_at, last_comment_at, demand_hits, vision_summary, relevance, score)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (code) DO UPDATE SET
                         comment_count=EXCLUDED.comment_count, like_count=EXCLUDED.like_count, demand_hits=EXCLUDED.demand_hits,
                         last_comment_at=EXCLUDED.last_comment_at,
                         vision_summary=COALESCE(EXCLUDED.vision_summary, radar_posts.vision_summary),
                         relevance=EXCLUDED.relevance, score=EXCLUDED.score
                       WHERE radar_posts.status='new'""",
                    (code, tag, url, image_url, caption, like_count, comment_count, taken, last_comment, demand, vsum, relevance, score),
                )
            conn.commit()
            kept += 1
        except Exception as e:
            conn.rollback()
            print("[radar] пост упал:", str(e)[:100])
    print(f"[radar] #{tag}: из {len(medias)} постов в панель попало {kept}")
    heartbeat(conn, "radar", f"#{tag}: +{kept} постов")


def main():
    print("[ig_comment] воркер запущен, poll =", POLL, "сек")
    last_radar = 0.0
    while True:
        try:
            conn = db()
            # РАДАР: ищем релевантные посты и кладём в панель (комментит человек сам).
            if time.time() - last_radar > RADAR_EVERY:
                try:
                    radar_scan(conn)
                except Exception as e:
                    print("[radar] скан упал:", str(e)[:120])
                    log_error(conn, "radar", "скан упал", str(e)[:400])
                last_radar = time.time()
            # Автокоммент-ферма работает ТОЛЬКО если у группы включён seed_enabled (по умолчанию нет).
            heartbeat(conn, "idle", "ищу аккаунт")
            acc = pick_account(conn)
            if acc:
                heartbeat(conn, "working", f"коммент от {acc['slug']}")
                run_one(conn, acc)
                heartbeat(conn, "idle", f"готово: {acc['slug']}")
            else:
                heartbeat(conn, "idle", "радар активен, автокоммент выключен")
            conn.close()
        except Exception as e:
            print("[ig_comment] цикл упал:", str(e)[:160])
        # человеческий разброс между действиями
        time.sleep(POLL + random.randint(0, 90))


if __name__ == "__main__":
    main()
