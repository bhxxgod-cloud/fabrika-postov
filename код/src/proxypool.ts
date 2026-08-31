// Пул запасных sticky-прокси (таблица proxy_pool, заполняется пачкой из браузера — у ClickIP нет API).
// Восстановление берёт свободный порт МГНОВЕННО, проверяет живость (residential-IP иногда дохнут) и
// назначает акку. Так чиним ротирующий/мёртвый прокси без ручной возни с браузером.
import http from 'node:http';
import { query } from './db/index.js';
import { parseProxy } from './gologin.js';

// Живой ли прокси: GET http://api.ipify.org в forward-режиме (без внешних либ). Возвращает IP или null.
function egress(host: string, port: number, user: string, pass: string, timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    try {
      const headers: Record<string, string> = { Host: 'api.ipify.org', Connection: 'close' };
      if (user) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
      const req = http.request({ host, port, method: 'GET', path: 'http://api.ipify.org/', headers, timeout: timeoutMs }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; if (d.length > 100) req.destroy(); });
        res.on('end', () => { const s = d.trim(); fin(/^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? s : null); });
      });
      req.on('error', () => fin(null));
      req.on('timeout', () => { req.destroy(); fin(null); });
      req.end();
    } catch { fin(null); }
  });
}

async function alive(proxyRaw: string): Promise<boolean> {
  const s = parseProxy(proxyRaw);
  if (!s || s.mode !== 'http') return false;
  const a = await egress(s.host, s.port, s.username || '', s.password || '');
  return !!a;
}

/** Сколько свободных прокси в пуле (для алертов «пул кончается»). */
export async function poolFreeCount(): Promise<number> {
  const r = await query<{ n: string }>(`SELECT count(*) n FROM proxy_pool WHERE status='free'`).catch(() => null);
  return r ? Number(r.rows[0].n) : 0;
}

/**
 * Взять свободный sticky из пула для акка: атомарно (FOR UPDATE SKIP LOCKED), проверить живость,
 * мёртвые пометить 'dead' и брать следующий. Возвращает строку прокси или null (пул пуст/все мёртвы).
 */
export async function drawProxy(slug: string): Promise<string | null> {
  for (let i = 0; i < 6; i++) {
    const r = await query<{ proxy: string }>(
      `UPDATE proxy_pool SET status='assigned', assigned_slug=$1, assigned_at=now()
       WHERE id = (SELECT id FROM proxy_pool WHERE status='free' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING proxy`, [slug],
    ).catch(() => null);
    const proxy = r?.rows[0]?.proxy;
    if (!proxy) return null;                       // пул пуст
    if (await alive(proxy)) return proxy;          // живой — отдаём
    await query(`UPDATE proxy_pool SET status='dead', assigned_slug=NULL WHERE proxy=$1`, [proxy]).catch(() => {});
  }
  return null;
}

/** Вернуть прокси в пул (если акк удалили/переназначили) — чтобы порт не пропадал. */
export async function releaseProxyBack(proxyRaw: string): Promise<void> {
  await query(`UPDATE proxy_pool SET status='free', assigned_slug=NULL, assigned_at=NULL WHERE proxy=$1`, [proxyRaw]).catch(() => {});
}
