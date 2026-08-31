// === Аналитик скринов Instagram ===
// Когда текстовый classifyIgScreen (radar.ts) не уверен ('unknown') ИЛИ вход провалился с непонятным
// экраном — вместо того чтобы слепо будить владельца, СНАЧАЛА показываем скрин vision-модели, которая
// «знает все экраны», получаем структурный вердикт и ДЕЙСТВИЕ. Владельца дёргаем только на 'unknown'
// (так растим пул типовых экранов) и на терминальных случаях, где нужны руки/замена.
//
// Пул известных экранов (растёт): лента, уведомления, куки, «сохранить вход», логин-форма, 2FA,
// чек-поинт почта/SMS, вериф номера, капча, суспенд, ограничение аккаунта.
import type { Page } from 'playwright-core';
import { visionAct } from './ai.js';

export type ScreenKind =
  | 'feed' | 'notifications' | 'cookies' | 'save_login' | 'login_form'
  | 'two_factor' | 'checkpoint_email_sms' | 'checkpoint_phone'
  | 'captcha' | 'suspended' | 'account_restricted' | 'unknown';

// Действие выводим ДЕТЕРМИНИРОВАННО из типа экрана (модель выбирает только тип — так надёжнее, чем
// доверять ей выбор действия). ready=работать, dismiss=закрыть всплывашку, relogin=вход паролем,
// enter_2fa=ввести TOTP, email_code=код с почты, hands=нужны руки, terminal=акк спалён (замена).
const ACTION: Record<ScreenKind, string> = {
  feed: 'ready', notifications: 'dismiss', cookies: 'dismiss', save_login: 'dismiss',
  login_form: 'relogin', two_factor: 'enter_2fa', checkpoint_email_sms: 'email_code',
  checkpoint_phone: 'hands', captcha: 'terminal', suspended: 'terminal', account_restricted: 'terminal',
  unknown: 'escalate',
};
const TERMINAL = new Set<ScreenKind>(['captcha', 'suspended', 'account_restricted']);
const KINDS = Object.keys(ACTION) as ScreenKind[];

export interface ScreenVerdict {
  kind: ScreenKind; action: string; terminal: boolean; confidence: number; note: string; raw?: string;
}

const SYSTEM = `You are an Instagram screen classifier for an automation system. Look at the screenshot and classify it as EXACTLY ONE screen type. Reply ONLY with compact JSON, no prose:
{"kind":"<type>","confidence":0-100,"note":"<max 12 words in Russian describing what you see>"}

Types:
- feed: normal logged-in Instagram (home feed / reels / profile / explore) with NO modal covering it
- notifications: modal "Turn on notifications"
- cookies: cookie consent banner (Allow all / Decline optional cookies)
- save_login: modal "Save your login info?"
- login_form: logged OUT — login page with username & password fields
- two_factor: enter a security/verification code from an authenticator app
- checkpoint_email_sms: Instagram asks to confirm identity via a code sent to email or phone (SMS)
- checkpoint_phone: Instagram asks to add or confirm a phone number
- captcha: "Confirm you're human" / captcha / "are you a robot" check
- suspended: "We suspended your account" / account suspended or disabled
- account_restricted: "We limited how often you can do certain things" / action blocked / temporarily restricted
- unknown: none of the above, or you cannot tell

Rule: if a modal covers the feed, classify the MODAL (notifications/cookies/save_login), not feed.`;

function normalizeKind(s: unknown): ScreenKind {
  const v = String(s || '').toLowerCase().replace(/[^a-z_]/g, '');
  if ((KINDS as string[]).includes(v)) return v as ScreenKind;
  if (/suspend|disabled|ban/.test(v)) return 'suspended';
  if (/captcha|human|robot/.test(v)) return 'captcha';
  if (/2fa|twofactor|authenticator|totp/.test(v)) return 'two_factor';
  if (/email|sms|mail/.test(v)) return 'checkpoint_email_sms';
  if (/phone|tel/.test(v)) return 'checkpoint_phone';
  if (/login|password|loggedout/.test(v)) return 'login_form';
  if (/cookie/.test(v)) return 'cookies';
  if (/notif/.test(v)) return 'notifications';
  if (/save/.test(v)) return 'save_login';
  if (/limit|restrict|block/.test(v)) return 'account_restricted';
  if (/feed|home|reel|profile|explore/.test(v)) return 'feed';
  return 'unknown';
}

/** Классифицировать скрин (PNG-буфер) через vision-модель. Всегда возвращает вердикт (unknown при сбое). */
export async function analyzeScreen(png: Buffer, ctx: { url?: string; slug?: string } = {}): Promise<ScreenVerdict> {
  const user = `URL: ${ctx.url || '?'}${ctx.slug ? ` (account ${ctx.slug})` : ''}. Classify this Instagram screen.`;
  let raw = '';
  try { raw = await visionAct(png.toString('base64'), SYSTEM, user, 200); } catch { /* сеть/лимит — ниже unknown */ }
  let kind: ScreenKind = 'unknown', confidence = 0, note = '';
  try {
    const j = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    kind = normalizeKind(j.kind);
    confidence = Math.max(0, Math.min(100, Number(j.confidence) || 0));
    note = String(j.note || '').replace(/\s+/g, ' ').slice(0, 120);
  } catch { /* модель вернула не-JSON — остаётся unknown */ }
  return { kind, action: ACTION[kind], terminal: TERMINAL.has(kind), confidence, note, raw: raw.slice(0, 200) };
}

/** Снять PNG со страницы и классифицировать. Удобная обёртка для воркера. */
export async function analyzeScreenPage(page: Page, ctx: { slug?: string } = {}): Promise<{ verdict: ScreenVerdict; png: Buffer | null }> {
  const png = await page.screenshot({ type: 'png' }).catch(() => null);
  if (!png) return { verdict: { kind: 'unknown', action: 'escalate', terminal: false, confidence: 0, note: 'не смог снять скрин' }, png: null };
  const verdict = await analyzeScreen(png, { url: page.url(), slug: ctx.slug });
  return { verdict, png };
}
