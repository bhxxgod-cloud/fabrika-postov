# ИЗМЕРИТЕЛЬ КАДРА ДЛЯ facevalidate.cjs (локально, без платных API).
#
# Этот файл НЕ выносит приговоров и НЕ знает порогов. Он только измеряет кадр и отдаёт цифры,
# а все решения и пороги живут в одном месте, в facevalidate.cjs. Так порог правится в одном
# файле, а не в двух, и «почему отсеяли» всегда читается там же, где написано правило.
#
# Детект лица тот же, каким отбирали 100 аватарок: cv2.FaceDetectorYN (модель yunet.onnx).
# Новый стек не заводим.
#
# Протокол: на stdin JSON-массив путей, на stdout по одной JSON-строке на файл.
import json
import os
import sys

import cv2
import numpy as np

MODEL = os.environ.get('YUNET') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'yunet.onnx')
# Детектим на уменьшенной копии: на исходных 3000px YuNet считает секунды на кадр, а лица,
# которые нам нужны, крупные и на 1600px видны с запасом. Координаты возвращаем в масштабе оригинала.
DET_MAX = 1600
# Порог создания низкий нарочно: слабые лица нужны не для отбора, а чтобы ЗАМЕТИТЬ второго
# человека в кадре. Что считать вторым лицом, решает .cjs.
det = cv2.FaceDetectorYN_create(MODEL, '', (320, 320), 0.55, 0.3, 200)


def skin_mask(bgr):
    """Маска кожи по двум независимым правилам сразу (YCrCb и HSV): по отдельности каждое
    ловит бежевые стены и дерево, вместе дают заметно меньше ложной кожи."""
    ycrcb = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb)
    cr, cb = ycrcb[:, :, 1], ycrcb[:, :, 2]
    m1 = (cr >= 133) & (cr <= 176) & (cb >= 77) & (cb <= 128)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    m2 = ((h <= 25) | (h >= 172)) & (s >= 25) & (s <= 200) & (v >= 50)
    return (m1 & m2)


def lap_var(gray_patch, side=256):
    """Резкость как дисперсия лапласиана, но всегда на одной сетке side x side. Без нормировки
    цифра зависит от разрешения, и мыло в 3000px выглядит резче, чем честный кадр в 700px."""
    if gray_patch.size == 0:
        return 0.0
    g = cv2.resize(gray_patch, (side, side), interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


def text_like(gray):
    """Кандидаты в строки текста: морфологический градиент, бинаризация, склейка по горизонтали.
    Ищем вытянутые плотные пятна ростом со строку. Так ловятся надписи и подписи поверх фото
    (в пинтересте это половина картинок: цитаты, коллажи с текстом, водяные знаки)."""
    H, W = gray.shape[:2]
    k = max(1, int(round(min(H, W) / 400)))
    g = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
    _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    closed = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (9 * k, 1)))
    cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    n, area = 0, 0
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if h < 0.012 * H or h > 0.09 * H or w < 2 * h or w > 25 * h:
            continue
        if cv2.countNonZero(bw[y:y + h, x:x + w]) < 0.45 * w * h:
            continue
        n += 1
        area += w * h
    return n, round(area / float(H * W), 4)


def seams(bgr):
    """Признаки коллажа: жёсткий шов во всю ширину или высоту и однотонные полосы-разделители.
    Коллаж как референс лица не годится: генератор потом смешивает два лица в одно."""
    small = cv2.resize(bgr, (400, 400), interpolation=cv2.INTER_AREA)
    g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    inner = slice(40, 360)
    drow = np.abs(np.diff(g, axis=0)).mean(axis=1)           # средний перепад между соседними строками
    dcol = np.abs(np.diff(g, axis=1)).mean(axis=0)
    med_r = float(np.median(drow)) + 1e-6
    med_c = float(np.median(dcol)) + 1e-6
    row_ratio = float(drow[inner].max() / med_r)
    col_ratio = float(dcol[inner].max() / med_c)
    flat_rows = int(((g[inner].std(axis=1) < 4)).sum())      # однотонные строки = поля и гуттеры
    flat_cols = int(((g[:, inner].std(axis=0) < 4)).sum())
    return round(row_ratio, 1), round(col_ratio, 1), flat_rows, flat_cols


def patch_stats(bgr, cx, cy, r):
    """Статистика маленького пятна: яркость и насыщенность. Пятна берём по точкам лица
    (глаз, щека), поэтому радиус всегда в долях ширины лица, а не в пикселях."""
    H, W = bgr.shape[:2]
    x0, x1 = max(0, int(cx - r)), min(W, int(cx + r) + 1)
    y0, y1 = max(0, int(cy - r)), min(H, int(cy + r) + 1)
    if x1 <= x0 or y1 <= y0:
        return None
    p = bgr[y0:y1, x0:x1]
    hsv = cv2.cvtColor(p, cv2.COLOR_BGR2HSV)
    lab_l = cv2.cvtColor(p, cv2.COLOR_BGR2GRAY)
    return {
        'l_med': float(np.median(lab_l)),
        'l_p90': float(np.percentile(lab_l, 90)),
        'l_p10': float(np.percentile(lab_l, 10)),
        's_med': float(np.median(hsv[:, :, 1])),
        'h_med': float(np.median(hsv[:, :, 0])),
    }


def box_dark(gray, med_l, cx, cy, bw, bh):
    """Доля тёмного и плотность горизонтальных краёв в небольшом прямоугольнике.
    Тёмное считаем ОТНОСИТЕЛЬНО медианной яркости самого лица, иначе тёмная кожа и тёмный
    кадр читаются как макияж.

    Почему коробка вокруг точки глаза, а не полоса во всю ширину лица (так было в первой
    версии и мерило неправду): полоса по линии щёк краями заезжает в волосы и фон, они тёмные,
    и «щёки» выходили темнее глаз даже на кадрах с жирными стрелками. Коробка под глазом стоит
    на той же вертикали, что и глаз, значит сравниваются кожа и глаз, а не глаз и волосы."""
    H, W = gray.shape[:2]
    x0, x1 = max(0, int(cx - bw / 2)), min(W, int(cx + bw / 2) + 1)
    y0, y1 = max(0, int(cy - bh / 2)), min(H, int(cy + bh / 2) + 1)
    if y1 <= y0 or x1 <= x0:
        return None
    p = gray[y0:y1, x0:x1]
    return (float((p < 0.55 * med_l).mean()),
            float(np.abs(cv2.Sobel(p, cv2.CV_32F, 0, 1, ksize=3)).mean()))


def hf_map(gray):
    """Карта мелкой детали: остаток после гауссова размытия. Операция ПОКСЕЛЬНАЯ, поэтому по ней
    можно считать медиану по произвольной маске (например только по фону), а не по прямоугольнику."""
    g = gray.astype(np.float32)
    return np.abs(g - cv2.GaussianBlur(g, (0, 0), 1.6))


def scene(img, gray, hsv, skin):
    """ЗАМЕРЫ СЦЕНЫ: чем телефонный кадр из жизни отличается от коммерческого студийного.

    Считаются БЕЗ лица, по всему кадру, поэтому работают и там, где лицо не нашлось.
    Всё меряется на копии не крупнее 640px по длинной стороне: цифры получаются сравнимыми
    между кадром 700px и кадром 3000px, а без нормировки шум и мелкая деталь у крупного файла
    всегда выходят выше, и это будет мерить разрешение, а не сцену.

    Кайма (ring) это рамка по краю кадра шириной 12% меньшей стороны. Это НЕ «фон человека»:
    прямоугольник фона в тесном портрете найти нельзя (проверено: маска тела съедала кадр
    целиком), а вот у самого края кадра почти всегда лежит либо задник, либо комната.
    """
    H, W = gray.shape[:2]
    out = {'ar': round(W / float(H or 1), 3)}
    sc = min(1.0, 640.0 / float(max(W, H)))
    if sc < 1.0:
        g = cv2.resize(gray, (int(W * sc), int(H * sc)), interpolation=cv2.INTER_AREA)
        cimg = cv2.resize(img, (int(W * sc), int(H * sc)), interpolation=cv2.INTER_AREA)
        chsv = cv2.resize(hsv, (int(W * sc), int(H * sc)), interpolation=cv2.INTER_NEAREST)
        csk = cv2.resize(skin.astype(np.uint8), (int(W * sc), int(H * sc)), interpolation=cv2.INTER_NEAREST) > 0
    else:
        g, cimg, chsv, csk = gray, img, hsv, skin
    h, w = g.shape[:2]
    gf = g.astype(np.float32)

    # ---- КАЙМА КАДРА: ровная заливка против бытовых мелочей ----
    b = max(4, int(0.12 * min(h, w)))
    ring = np.zeros((h, w), bool)
    ring[:, :] = True
    ring[b:h - b, b:w - b] = False
    rg = g[ring]
    hist = np.bincount((rg >> 2).astype(np.int32), minlength=64).astype(np.float64)
    p = hist / max(1.0, hist.sum())
    p = p[p > 0]
    out['edge_ent'] = round(float(-(p * np.log2(p)).sum()), 3)        # энтропия яркости каймы, бит
    q = (cimg[:, :, 0] >> 3).astype(np.int32) * 1024 \
        + (cimg[:, :, 1] >> 3).astype(np.int32) * 32 + (cimg[:, :, 2] >> 3).astype(np.int32)
    out['edge_col'] = round(len(np.unique(q[ring])) / (rg.size / 1000.0), 2)   # уникальных цветов на 1000 px
    loc = cv2.blur((gf - cv2.blur(gf, (9, 9))) ** 2, (9, 9))
    out['edge_flat'] = round(float((loc[ring] < 6).mean()), 3)        # доля каймы без всякой структуры
    can = cv2.Canny(g, 60, 160) > 0
    out['edge_cany'] = round(float(can[ring].mean()), 4)             # плотность контуров в кайме
    hr = chsv[:, :, 0][ring]
    sr = chsv[:, :, 1][ring]
    hb = np.bincount((hr[sr >= 40] // 10).astype(np.int32), minlength=18).astype(np.float64)
    out['edge_hues'] = int((hb / max(1.0, hb.sum()) > 0.05).sum()) if hb.sum() > 0.02 * rg.size else 0
    out['edge_sat'] = round(float(np.median(sr)), 1)
    out['edge_l'] = round(float(np.median(rg)), 1)

    # ---- НЕРОВНОСТЬ СВЕТА ----
    # Блоки 8x8 по кадру: у студии свет ровный, у комнаты и улицы по кадру идут пятна и тени.
    bl = cv2.resize(gf, (8, 8), interpolation=cv2.INTER_AREA)
    out['lum_bstd'] = round(float(bl.std()), 1)
    out['lum_spread'] = round(float(np.percentile(gf, 95) - np.percentile(gf, 5)) / 255.0, 3)
    out['blowout'] = round(float((g >= 250).mean()), 4)              # пересвет от вспышки или окна
    out['crush'] = round(float((g <= 6).mean()), 4)
    out['black_lift'] = round(float(np.percentile(gf, 1)), 1)        # плёночный или приложенческий пресет поднимает чёрное
    # Вспышка в лоб и окно сбоку дают яркое пятно: сравниваем самый яркий блок с медианой блоков.
    out['hot_spot'] = round(float(bl.max() / (np.median(bl) + 1e-6)), 3)
    # Виньетка: центр против каймы. У телефона с фильтром центр заметно светлее.
    cen = np.zeros((h, w), bool)
    cen[int(0.3 * h):int(0.7 * h), int(0.3 * w):int(0.7 * w)] = True
    out['vign'] = round(float(gf[cen].mean() / (gf[ring].mean() + 1e-6)), 3)

    # ---- ШУМ В ТЕНЯХ ----
    # У телефонного кадра в тенях всегда видно зерно матрицы, у студийного снимка тени чистые.
    # Меряем ТОЛЬКО в тенях (нижняя четверть яркости) и только по ровным местам, иначе вместо
    # шума померится текстура волос и ткани.
    hm = hf_map(g)
    dark = (gf <= np.percentile(gf, 25)) & (loc < 40)
    out['shadow_noise'] = round(float(np.median(hm[dark])), 3) if dark.sum() > 0.01 * h * w else None
    mid = (gf > np.percentile(gf, 40)) & (gf < np.percentile(gf, 70)) & (loc < 40)
    out['mid_noise'] = round(float(np.median(hm[mid])), 3) if mid.sum() > 0.01 * h * w else None

    # ---- ЦВЕТ ----
    bb, gg, rr = cimg[:, :, 0].astype(np.float32), cimg[:, :, 1].astype(np.float32), cimg[:, :, 2].astype(np.float32)
    out['warm'] = round(float(rr.mean() / (bb.mean() + 1e-6)), 3)     # тёплый свет лампы против холодной студии
    out['sat_p90'] = round(float(np.percentile(chsv[:, :, 1], 90)), 1)
    out['sat_std'] = round(float(chsv[:, :, 1].std()), 1)

    # ---- БЫТОВЫЕ ОБЪЕКТЫ ----
    # Грубо по приказу: доля кадра, которая НЕ кожа и НЕ ровная заливка. У студийного портрета
    # на ровном заднике это почти ноль, у кадра в комнате, в машине, на улице там мебель,
    # окно, дверь, вещи, узор на одежде.
    out['clutter'] = round(float(((~csk) & (loc >= 6)).mean()), 3)
    out['flat_frac'] = round(float((loc < 6).mean()), 3)
    return out


def measure(path):
    out = {'path': path}
    img = cv2.imread(path)
    if img is None:
        out['err'] = 'не читается'
        return out
    H, W = img.shape[:2]
    out.update({'w': W, 'h': H})

    hsv_all = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    out['sat_med'] = round(float(np.median(hsv_all[:, :, 1])), 1)     # мало = чёрно-белый кадр
    out['sharp_all'] = round(lap_var(gray), 1)

    # ЗАМЕРЫ СЦЕНЫ СЧИТАЕМ ДО ДЕТЕКТА и до всех возвратов: кадр без лица тоже надо уметь
    # сравнивать со сценами наших рабочих кадров, иначе половина набора выпадает из статистики.
    sm = skin_mask(img)
    try:
        out.update(scene(img, gray, hsv_all, sm))
    except Exception as e:
        out['scene_err'] = str(e)[:80]

    # ---- детект лиц ----
    sc = min(1.0, DET_MAX / float(max(W, H)))
    dimg = cv2.resize(img, (int(W * sc), int(H * sc)), interpolation=cv2.INTER_AREA) if sc < 1.0 else img
    det.setInputSize((dimg.shape[1], dimg.shape[0]))
    _, faces = det.detect(dimg)
    faces = [] if faces is None else [np.array(f, dtype=np.float64) for f in faces]
    # Первые 14 чисел это геометрия (рамка и пять точек) и её надо вернуть в масштаб оригинала,
    # а 15-е это score и его масштабировать нельзя.
    for f in faces:
        f[:14] /= sc
    # ХОЗЯИН КАДРА это САМОЕ КРУПНОЕ ИЗ УВЕРЕННЫХ лиц (порог 0.85 тот же, что в отборе аватарок).
    # Просто «самое крупное» брать нельзя: бывает крупное лицо с оценкой 0.6 при чётком лице
    # рядом, и кадр уходил в брак как «лицо неуверенное», хотя одно нормальное лицо в нём есть.
    # Если уверенных нет вовсе, кладём первым лучшее по оценке, чтобы .cjs отказал по ней.
    strong = [f for f in faces if float(f[14]) >= 0.85]
    if strong:
        primary = max(strong, key=lambda f: float(f[3]))
    elif faces:
        primary = max(faces, key=lambda f: float(f[14]))
    else:
        out['no_face'] = True
        out['faces'] = []
        return out
    rest = sorted([f for f in faces if f is not primary], key=lambda f: -float(f[3]))
    fl = [primary] + rest
    out['n_strong'] = len(strong)
    out['faces'] = [{'x': round(float(f[0])), 'y': round(float(f[1])), 'w': round(float(f[2])),
                     'fh': round(float(f[3])), 'score': round(float(f[14]), 3)} for f in fl[:6]]

    f = primary
    fx, fy, fw, fh = [float(v) for v in f[:4]]
    lm = [(float(f[4 + i * 2]), float(f[5 + i * 2])) for i in range(5)]   # пр.глаз, л.глаз, нос, пр.угол рта, л.угол рта
    reye, leye, nose, rmouth, lmouth = lm
    eye_x, eye_y = (reye[0] + leye[0]) / 2, (reye[1] + leye[1]) / 2
    mouth_x, mouth_y = (rmouth[0] + lmouth[0]) / 2, (rmouth[1] + lmouth[1]) / 2
    eye_d = float(np.hypot(leye[0] - reye[0], leye[1] - reye[1])) or 1.0

    out['face_frac'] = round(fh / H, 3)                               # крупность лица по кадру
    out['face_area_frac'] = round(fw * fh / float(W * H), 4)
    # Кроп «голова целиком»: рамка YuNet это брови..подбородок, вся голова примерно в 3.1 раза шире.
    out['crop_side'] = int(round(min(3.1 * fh, W, H)))
    out['score'] = round(float(f[14]), 3)

    # ---- КАДРИРОВКА: аватарка против первого кадра поста ----
    # Аватарка это лицо по центру и во весь кружок, у неё вокруг головы нет ни воздуха, ни
    # сцены. Первому кадру поста нужен воздух: над головой место под хук, вокруг место под сцену.
    # Всё в долях кадра, чтобы разрешение не влияло.
    out['face_cx'] = round((fx + fw / 2) / W, 3)
    out['face_cy'] = round((fy + fh / 2) / H, 3)
    out['head_room'] = round(fy / float(H), 3)                        # воздух над рамкой лица
    out['below_room'] = round(max(0.0, H - (fy + fh)) / float(H), 3)   # сколько кадра ниже подбородка
    out['side_room'] = round(min(fx, W - (fx + fw)) / float(W), 3)    # ближайший боковой отступ
    # Голова целиком в кадре: если рамка лица прижата к краю, кадр обрезан по лицу (аватарочный кроп).
    out['tight_crop'] = round(min(out['head_room'], out['side_room']), 3)

    # Резкость и яркость по самому лицу: мыло на лице важнее мыла в кадре.
    fx0, fy0 = max(0, int(fx)), max(0, int(fy))
    fx1, fy1 = min(W, int(fx + fw)), min(H, int(fy + fh))
    face_gray = gray[fy0:fy1, fx0:fx1]
    out['sharp_face'] = round(lap_var(face_gray), 1)
    med_l = float(np.median(face_gray)) if face_gray.size else 1.0
    out['face_l_med'] = round(med_l, 1)

    # ---- поворот головы: годится ли как «взгляд в камеру» ----
    # Настоящее направление взгляда локально не измерить, поэтому меряем фронтальность головы:
    # у повёрнутой в профиль нос уезжает от середины глаз, и снимок перестаёт смотреть в камеру.
    out['yaw'] = round(abs(nose[0] - eye_x) / eye_d, 3)
    out['roll'] = round(abs(leye[1] - reye[1]) / eye_d, 3)
    out['eye_d_frac'] = round(eye_d / fw, 3)

    # ---- акцент на глаза и стрелки ----
    # Каждый глаз сравниваем с кожей ПРЯМО ПОД ЭТИМ ЖЕ глазом: одна вертикаль, одно освещение.
    bw_, bh_ = 0.36 * fw, 0.17 * fh
    drop = 0.45 * (mouth_y - eye_y)
    cheek_y = eye_y + drop                                           # линия щёк, ниже по ней же берём пробы кожи
    eyes, cheeks = [], []
    for (ex, ey) in (reye, leye):
        e = box_dark(gray, med_l, ex, ey, bw_, bh_)
        c = box_dark(gray, med_l, ex, ey + drop, bw_, bh_)
        if e and c:
            eyes.append(e)
            cheeks.append(c)
    # РЕЗКОСТЬ ПО ГЛАЗАМ, А НЕ ПО ВСЕМУ ЛИЦУ. Кожа гладкая сама по себе, поэтому лапласиан по
    # лицу всегда ниже, чем по кадру с волосами и фоном, и сравнивать их между собой бессмысленно
    # (в первой версии правило «фокус не на лице» на этом и падало: у нормальных кадров отношение
    # выходило 0.3 при пороге 0.55, то есть под нож шло большинство). Ресницы, стрелка и блик в
    # зрачке это настоящая мелкая деталь: если кадр в фокусе, она есть, если мыло, её нет.
    eye_patches = []
    for (ex, ey) in (reye, leye):
        px0, px1 = max(0, int(ex - bw_ / 2)), min(W, int(ex + bw_ / 2))
        py0, py1 = max(0, int(ey - bh_ / 2)), min(H, int(ey + bh_ / 2))
        if px1 > px0 and py1 > py0:
            eye_patches.append(lap_var(gray[py0:py1, px0:px1], side=128))
    if eye_patches:
        out['sharp_eye'] = round(float(np.mean(eye_patches)), 1)

    # РЕЗКОСТЬ ПРИ ТОМ РАЗМЕРЕ, В КОТОРОМ КАДР ПОЙДЁТ В ПОСТ (1080 по длинной стороне).
    # Это НЕ придирка к цифрам, а исправление подмены. Замер проверен опытом: сорок кадров
    # из пинтереста привели к нашему конвейеру (1080 + jpeg72), и медиана sharp_eye упала
    # с 245 до 148, то есть примерно 40% «резкости» у крупного файла это просто его размер.
    # Сравнивать по сырой резкости наши кадры (инстаграм, 1080) с оригиналами пинтереста
    # (до 3000px) значит мерить происхождение файла, а не съёмку. Поля с _n меряются после
    # приведения к 1080 и сравнимы между любыми источниками.
    kn = min(1.0, 1080.0 / float(max(W, H)))
    if kn < 1.0:
        nimg = cv2.resize(gray, (int(W * kn), int(H * kn)), interpolation=cv2.INTER_AREA)
        nh, nw = nimg.shape[:2]
        nx0, ny0 = max(0, int(fx * kn)), max(0, int(fy * kn))
        nx1, ny1 = min(nw, int((fx + fw) * kn)), min(nh, int((fy + fh) * kn))
        out['sharp_face_n'] = round(lap_var(nimg[ny0:ny1, nx0:nx1]), 1)
        nep = []
        for (ex, ey) in (reye, leye):
            px0, px1 = max(0, int((ex - bw_ / 2) * kn)), min(nw, int((ex + bw_ / 2) * kn))
            py0, py1 = max(0, int((ey - bh_ / 2) * kn)), min(nh, int((ey + bh_ / 2) * kn))
            if px1 > px0 and py1 > py0:
                nep.append(lap_var(nimg[py0:py1, px0:px1], side=128))
        if nep:
            out['sharp_eye_n'] = round(float(np.mean(nep)), 1)
    else:
        out['sharp_face_n'] = out.get('sharp_face')
        if 'sharp_eye' in out:
            out['sharp_eye_n'] = out['sharp_eye']

    if eyes:
        e_dark = float(np.mean([e[0] for e in eyes]))
        c_dark = float(np.mean([c[0] for c in cheeks]))
        e_edge = float(np.mean([e[1] for e in eyes]))
        c_edge = float(np.mean([c[1] for c in cheeks]))
        out['eye_dark'] = round(e_dark, 3)
        out['eye_accent'] = round(e_dark - c_dark, 3)                # насколько глаз темнее кожи под ним
        out['eye_edge_ratio'] = round(e_edge / (c_edge + 1e-6), 2)   # стрелка и ресницы это резкие линии

    # ---- чёрные линзы на всю склеру ----
    # У живого глаза рядом со зрачком есть светлый белок, значит в пятне глаза найдётся яркая
    # точка. Линза на всю склеру делает пятно ровно тёмным. Меряем В ДОЛЯХ от яркости лица,
    # иначе тёмный кадр целиком читается как линзы.
    er = 0.085 * fw
    e1, e2 = patch_stats(img, reye[0], reye[1], er), patch_stats(img, leye[0], leye[1], er)
    ep = [p for p in (e1, e2) if p]
    out['eye_white'] = round(min(p['l_p90'] for p in ep) / (med_l + 1e-6), 3) if ep else None

    # ---- трупный тон кожи ----
    # Щёки: сбоку от носа, на полпути до рта. Живая кожа тёплая и насыщенная, трупный тон
    # серый (насыщенность у нуля) или уехавший в зелень/синь по тону.
    cr = 0.10 * fw
    c1 = patch_stats(img, eye_x - 0.62 * eye_d, cheek_y, cr)
    c2 = patch_stats(img, eye_x + 0.62 * eye_d, cheek_y, cr)
    cp = [p for p in (c1, c2) if p]
    if cp:
        out['cheek_s'] = round(float(np.mean([p['s_med'] for p in cp])), 1)
        out['cheek_h'] = round(float(np.mean([p['h_med'] for p in cp])), 1)
        out['cheek_l'] = round(float(np.mean([p['l_med'] for p in cp])), 1)

    # ---- кровь ----
    # Кровь это крупные насыщенно-красные пятна. Два исключения обязательны, иначе меряется не то:
    # 1) кружок вокруг рта, иначе яркая помада читается как кровь;
    # 2) ВСЁ, ЧТО ВЫГЛЯДИТ КОЖЕЙ. Загорелая кожа в тёплом закатном свете сама проходит по «красный
    #    канал сильно больше остальных», и на этом правило ловило десятки обычных портретов без
    #    единой капли крови. Кровь по цвету за пределы диапазона кожи выходит, кожа нет.
    b, g_, r = img[:, :, 0].astype(np.int16), img[:, :, 1].astype(np.int16), img[:, :, 2].astype(np.int16)
    red = (r > 60) & (r > 1.9 * g_) & (r > 1.9 * b) & ~sm
    yy, xx = np.mgrid[0:H, 0:W]
    red[(xx - mouth_x) ** 2 + (yy - mouth_y) ** 2 < (0.33 * fw) ** 2] = False
    out['red_frac'] = round(float(red.mean()), 4)
    face_box = np.zeros((H, W), bool)
    face_box[fy0:fy1, fx0:fx1] = True
    out['red_on_face'] = round(float((red & face_box).mean() / (out['face_area_frac'] + 1e-6)), 4)

    # ---- открытая кожа по площади ----
    # Голова целиком (с волосами и шеей) из подсчёта уходит: нам важна кожа ТЕЛА, а лицо
    # обязано быть крупным по определению задачи.
    head = np.zeros((H, W), bool)
    hx0, hx1 = int(max(0, fx - 0.55 * fw)), int(min(W, fx + 1.55 * fw))
    hy0, hy1 = int(max(0, fy - 1.0 * fh)), int(min(H, fy + 1.9 * fh))
    head[hy0:hy1, hx0:hx1] = True
    out['skin_frac'] = round(float(sm.mean()), 3)
    out['body_skin'] = round(float((sm & ~head).mean()), 3)          # кожа вне головы = тело

    # КОЖА ПОД ТОН ЭТОГО ЛИЦА. Общая маска кожи считает кожей бежевую стену, песочный фон,
    # кремовый свитер и подсвеченные волосы, и на кадрах с тёплым фоном «доля открытого тела»
    # уходила за 0.3 у обычных портретов в свитере. Поэтому берём тон кожи САМОГО лица (медиана
    # Cr и Cb внутри рамки) и считаем телом только то, что совпало с ним близко. Стена того же
    # тона всё ещё может пройти, поэтому решающим правилом это не делаем: оно работает только
    # там, где лицо мелкое, то есть в кадре реально есть место для тела.
    ycrcb = cv2.cvtColor(img, cv2.COLOR_BGR2YCrCb)
    face_sm = sm[fy0:fy1, fx0:fx1]
    if face_sm.any():
        fcr = ycrcb[fy0:fy1, fx0:fx1, 1][face_sm]
        fcb = ycrcb[fy0:fy1, fx0:fx1, 2][face_sm]
        cr0, cb0 = float(np.median(fcr)), float(np.median(fcb))
        tight = sm & (np.abs(ycrcb[:, :, 1].astype(np.int16) - cr0) <= 10) \
                   & (np.abs(ycrcb[:, :, 2].astype(np.int16) - cb0) <= 10)
        out['body_skin_tone'] = round(float((tight & ~head).mean()), 3)
    else:
        out['body_skin_tone'] = 0.0
    # НИЗ КАДРА СЧИТАЕМ ТОЛЬКО ВНЕ ГОЛОВЫ И В ДОЛЯХ ОТ ЭТОЙ ЖЕ ЗОНЫ. В первой версии здесь была
    # просто доля кожи в нижних 45% кадра, и на любом крупном портрете она уходила за 0.8, потому
    # что снизу кадра стояло собственное лицо. Так под нож попадали ровно те кадры, которые нам
    # нужны. Теперь меряем: какая часть НЕголовы внизу кадра это кожа, то есть торс.
    bottom = np.zeros((H, W), bool)
    bottom[int(0.55 * H):, :] = True
    zone = bottom & ~head
    out['torso_skin'] = round(float((sm & zone).sum() / zone.sum()), 3) if zone.sum() > 0.02 * H * W else 0.0
    # Живая тёплая кожа внутри рамки лица. Трупный тон, зелёно-серый грим и синие подтёки дают
    # заметно меньше. Это надёжнее одной пробы оттенка на щеке: та ловила зелёный свет и врала.
    out['face_skin'] = round(float(sm[fy0:fy1, fx0:fx1].mean()), 3) if fy1 > fy0 and fx1 > fx0 else 0.0

    # ---- ЖИВОЙ КАДР ПРОТИВ СТУДИЙНОГО: ЧТО ЗА КАДРОМ ЧЕЛОВЕКА ----
    # Приказ: живой кадр это селфи с бытовым фоном, коммерческий это ровный задник без деталей.
    # Фон берём МАСКОЙ, а не прямоугольником, и это не придирка: два прямоугольных подхода
    # (полоса человека шириной 3.6 ширины лица; четыре угла по 26%) дали фон 0% у ВСЕХ сорока
    # размеченных кадров, то есть замер был мёртвый. Причина: это тесные портретные кропы, лицо
    # занимает 30..58% высоты, чистого прямоугольника фона в них нет. Коробка тела узкая, 2.1
    # ширины лица, иначе от кадра не остаётся ничего.
    body = np.zeros((H, W), bool)
    bx0, bx1 = int(max(0, fx - 0.55 * fw)), int(min(W, fx + 1.55 * fw))
    body[int(max(0, fy - 0.85 * fh)):, bx0:bx1] = True
    bgm = ~body
    out['bg_frac'] = round(float(bgm.mean()), 3)
    if bgm.sum() > 0.04 * H * W:
        hm = hf_map(gray)
        gf = gray.astype(np.float32)
        loc = cv2.blur((gf - cv2.blur(gf, (9, 9))) ** 2, (9, 9))
        out['bg_hf'] = round(float(np.median(hm[bgm])), 2)
        # bg_flat это доля фона без всякой мелкой структуры: у задника из бумаги она под 0.9,
        # у комнаты, машины и улицы заметно ниже.
        out['bg_flat'] = round(float((loc[bgm] < 6).mean()), 3)
        out['bg_std'] = round(float(gray[bgm].std()), 1)
        out['bg_sat'] = round(float(np.median(hsv_all[:, :, 1][bgm])), 1)

    # ---- ЧУЧЕЛО: ЧЁРНЫЕ ГУБЫ ----
    # Пятно вокруг середины рта, сами губы это его тёмная треть (иначе меряется кожа вокруг).
    # Яркость в долях от яркости лица: тёмный кадр не должен читаться как чёрная помада.
    lx0, lx1 = max(0, int(mouth_x - 0.26 * fw)), min(W, int(mouth_x + 0.26 * fw))
    ly0, ly1 = max(0, int(mouth_y - 0.13 * fh)), min(H, int(mouth_y + 0.13 * fh))
    lp = img[ly0:ly1, lx0:lx1]
    if lp.size:
        lg = cv2.cvtColor(lp, cv2.COLOR_BGR2GRAY)
        lhsv = cv2.cvtColor(lp, cv2.COLOR_BGR2HSV)
        m = lg <= np.percentile(lg, 33)
        out['lip_l'] = round(float(np.median(lg[m])) / (med_l + 1e-6), 3)
        out['lip_s'] = round(float(np.median(lhsv[:, :, 1][m])), 1)

    # ---- текст и коллажи ----
    tn, ta = text_like(gray)
    out['text_n'], out['text_area'] = tn, ta
    rr, cc, fr, fc = seams(img)
    out['seam_row'], out['seam_col'], out['flat_rows'], out['flat_cols'] = rr, cc, fr, fc
    return out


def main():
    paths = json.load(sys.stdin)
    for p in paths:
        try:
            r = measure(p)
        except Exception as e:                                        # один битый файл не должен ронять прогон
            r = {'path': p, 'err': str(e)[:120]}
        sys.stdout.write(json.dumps(r, ensure_ascii=False) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
