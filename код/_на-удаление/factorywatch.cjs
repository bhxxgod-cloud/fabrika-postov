'use strict';
// СТОРОЖ ФАБРИКИ: ждёт, когда генерация оживёт, и сам поднимает волну постов.
//
// ЗАЧЕМ. 11.08 фабрика партнёра встала на «Exhausted balance» у провайдера fal.ai. Пополнение это
// не наша сторона, ждать можно час, можно сутки, и всё это время склад исходников (244 фотографии)
// простаивает. Сторож раз в 10 минут бесплатно спрашивает у фабрики, чем кончились последние заказы
// (factorycheck.cjs, ничего не заказывает), и в первую же минуту, когда отказы прекратились,
// запускает волну и пишет об этом в телеграм.
//
// ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕТ. Никаких пробных заказов «на проверку»: заказ это деньги, а история
// заказов отвечает на тот же вопрос бесплатно. И никаких повторных запусков: подняв волну один раз,
// сторож уходит, чтобы не наплодить четыре волны на одном складе.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { можноПускать } = require('./factorycheck.cjs');

const ПАУЗА_МС = Number(process.env.FACTORYWATCH_MS || 10 * 60000);
const ПОСТОВ = Number(process.env.WATCH_WANT || 160);
const ПОЛОС = Number(process.env.WATCH_LANES || 4);
const ЛОГ = '/tmp/factorywatch.log';

function пиши(с) {
  const строка = `[${new Date().toISOString()}] ${с}`;
  console.log(строка);
  try { fs.appendFileSync(ЛОГ, строка + '\n'); } catch {}
}

function вТелеграм(текст) {
  try {
    spawn('node', [path.join(__dirname, 'tgchat.cjs'), 'send', текст],
      { cwd: __dirname, detached: true, stdio: 'ignore' }).unref();
  } catch (e) { пиши(`телеграм не отправился: ${e.message}`); }
}

(async () => {
  пиши(`сторож фабрики поднят: проверка раз в ${Math.round(ПАУЗА_МС / 60000)} мин, `
    + `при оживлении пущу волну на ${ПОСТОВ} постов в ${ПОЛОС} полосы`);
  for (;;) {
    let в;
    try { в = await можноПускать(); }
    catch (e) { пиши(`проверка не вышла: ${String(e.message).slice(0, 120)}`); в = null; }
    if (в) {
      пиши(`статусы ${JSON.stringify(в.с.по)}, отказов ${в.с.отказов} из ${в.с.свежих}`
        + (в.можно ? ', фабрика ЖИВА' : `, стоит: ${в.почему.slice(0, 120)}`));
      if (в.можно) {
        const лог = `/tmp/wave_auto_${Date.now()}.log`;
        const out = fs.openSync(лог, 'a');
        spawn('node', [path.join(__dirname, 'postwave.cjs'), String(ПОСТОВ), String(ПОЛОС)], {
          cwd: __dirname, detached: true, stdio: ['ignore', out, out],
          env: { ...process.env, TEMPLATES: process.env.TEMPLATES || 'img-face-report',
            PHOTOS: process.env.PHOTOS || 'src_good', OP_LANES: String(ПОЛОС) },
        }).unref();
        пиши(`волна запущена, лог ${лог}`);
        вТелеграм('ФАБРИКА ОЖИЛА. Отказов по балансу больше нет, волна постов запущена сама: '
          + `${ПОСТОВ} постов в ${ПОЛОС} полосы. Лог ${лог}.`);
        process.exit(0);
      }
    }
    await new Promise((r) => setTimeout(r, ПАУЗА_МС));
  }
})();
