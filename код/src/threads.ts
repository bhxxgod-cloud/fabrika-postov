// ТРЕДС: минимальный OAuth-контур. Канал = строка yt_channels с platform='threads'
// (client_id/client_secret приложения Меты, auth jsonb: {access_token,user_id,expires_at}).
// Флоу: /api/threads/oauth/url?ch=ID → диалог на телефоне (там активен нужный профиль) →
// /api/threads/oauth/cb: code → short token → long-lived (60 дн), сохраняем в auth.
import type { Request, Response, Router } from 'express';
import { query } from './db/index.js';

const REDIRECT = () => (process.env.PUBLIC_URL || 'https://web-production-efed0.up.railway.app') + '/api/threads/oauth/cb';

export function mountThreads(api: Router) {
  const err = (res: Response, e: unknown) => res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  api.get('/threads/oauth/url', async (req, res) => {
    try {
      const id = Number(req.query.ch);
      const { rows: [c] } = await query<any>(`SELECT * FROM yt_channels WHERE id=$1 AND platform='threads'`, [id]);
      if (!c) return res.status(404).json({ error: 'нет threads-канала ' + id });
      const u = 'https://threads.net/oauth/authorize?' + new URLSearchParams({
        client_id: c.client_id, redirect_uri: REDIRECT(),
        scope: 'threads_basic,threads_content_publish', response_type: 'code', state: String(c.id),
      });
      res.json({ url: u });
    } catch (e) { err(res, e); }
  });
  const cb = async (req: Request, res: Response) => {
    try {
      const code = String(req.query.code || ''); const id = Number(req.query.state);
      const { rows: [c] } = await query<any>(`SELECT * FROM yt_channels WHERE id=$1 AND platform='threads'`, [id]);
      if (!c || !code) return res.status(400).send('нет канала или кода');
      const st = await fetch('https://graph.threads.net/oauth/access_token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, grant_type: 'authorization_code', redirect_uri: REDIRECT(), code }),
      }).then((r) => r.json());
      if (!st.access_token) return res.status(400).send('обмен кода: ' + JSON.stringify(st));
      const lt = await fetch('https://graph.threads.net/access_token?' + new URLSearchParams({
        grant_type: 'th_exchange_token', client_secret: c.client_secret, access_token: st.access_token,
      })).then((r) => r.json());
      const token = lt.access_token || st.access_token;
      const expires = new Date(Date.now() + (Number(lt.expires_in) || 3600) * 1000).toISOString();
      await query(`UPDATE yt_channels SET auth = coalesce(auth,'{}'::jsonb) || jsonb_build_object('access_token',$2::text,'user_id',$3::text,'expires_at',$4::text), connected_at=now(), updated_at=now() WHERE id=$1`,
        [c.id, token, String(st.user_id || ''), expires]);
      res.redirect('/?tab=youtube&threads=connected');
    } catch (e) { err(res, e); }
  };
  api.get('/threads/oauth/cb', cb);
  (api as any).thOauthCb = cb;
}
