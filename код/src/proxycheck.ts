// Быстрая авто-диагностика прокси акка для алертов о паузе.
// Без внешних либ: штатный http в forward-режиме (GET http://api.ipify.org через HTTP-прокси).
// Два замера подряд → отличаем: МЁРТВ (нет ответа) / РОТИРУЕТ (разные IP) / СТАБИЛЕН (один IP).
import http from 'node:http';
import { parseProxy } from './gologin.js';

function egress(host: string, port: number, user: string, pass: string, timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    try {
      const headers: Record<string, string> = { Host: 'api.ipify.org', Connection: 'close' };
      if (user) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
      const req = http.request({ host, port, method: 'GET', path: 'http://api.ipify.org/', headers, timeout: timeoutMs }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.length > 100) req.destroy(); });
        res.on('end', () => { const s = d.trim(); fin(/^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? s : null); });
      });
      req.on('error', () => fin(null));
      req.on('timeout', () => { req.destroy(); fin(null); });
      req.end();
    } catch { fin(null); }
  });
}

// Возвращает короткую строку-вердикт для телеграм-алерта.
export async function diagnoseProxy(proxyRaw?: string | null): Promise<string> {
  if (!proxyRaw) return 'ℹ прокси не задан у акка';
  const s = parseProxy(proxyRaw);
  if (!s) return `ℹ прокси не распознан (${String(proxyRaw).slice(0, 30)})`;
  if (s.mode !== 'http') return `ℹ прокси ${s.mode} — авто-проверка только для http`;
  const a = await egress(s.host, s.port, s.username || '', s.password || '');
  const b = await egress(s.host, s.port, s.username || '', s.password || '');
  const port = `:${s.port}`;
  if (!a && !b) return `🔴 ПРОКСИ МЁРТВ ${port} (нет ответа ×2) — замени прокси`;
  if (a && b && a !== b) return `🔴 ПРОКСИ РОТИРУЕТ ${port} (${a} ≠ ${b}) — нужен STICKY, вход в IG невозможен`;
  return `🟢 прокси стабилен ${port} (${a || b}) — причина в кредах/2FA/челлендже, нужен ручной вход`;
}
