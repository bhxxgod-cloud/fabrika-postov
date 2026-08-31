import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFile, readFile, unlink, mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Уникализатор видео на ffmpeg. Каждому аккаунту — свой сид, поэтому одно
// исходное видео превращается в N визуально-одинаковых, но РАЗНЫХ по хэшу файлов.
// Всё незаметно глазу (микро-кроп/скорость/цвет/шум), но ломает перцептивный хэш
// и метаданные — чтобы TikTok не считал перезалив дублем.
//
// ФОРМУЛЫ ЖИВУТ В ОДНОМ МЕСТЕ — ../uniq.cjs. Здесь только ввод-вывод (буфер ↔ файл)
// и системный ffmpeg вместо ffmpeg-static. Раньше тут лежала вторая копия тех же
// формул: пока копии совпадают, всё цело, но любая правка одной стороны молча
// разводит уникализацию мака и Railway, и один ролик на двух акках снова
// становится дублем. Путь ../uniq.cjs одинаково верен и из src/, и из dist/.
const requireCjs = createRequire(import.meta.url);
const { buildUniqArgs } = requireCjs('../uniq.cjs') as {
  buildUniqArgs: (o: {
    seed: number; level: string; inPath: string; outPath: string;
    maxW?: string | number; crf?: string | number; audioBr?: string;
  }) => { args: string[]; argsNoAudio: string[]; params: Record<string, number | boolean> };
};

export type UniqLevel = 'none' | 'medium' | 'max';

export interface UniqResult {
  buffer: Buffer;
  mime: string;
  params: Record<string, number | boolean>;
}

function run(cmd: string, args: string[], timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    const to = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg таймаут')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(to); reject(e); });
    p.on('close', (code) => { clearTimeout(to); code === 0 ? resolve() : reject(new Error(`ffmpeg код ${code}: ${err.slice(-400)}`)); });
  });
}

let cachedAvail: boolean | null = null;
export async function ffmpegAvailable(): Promise<boolean> {
  if (cachedAvail !== null) return cachedAvail;
  try { await run('ffmpeg', ['-version'], 8000); cachedAvail = true; } catch { cachedAvail = false; }
  return cachedAvail;
}

export async function uniquifyVideo(input: Buffer, seed: number, level: UniqLevel): Promise<UniqResult> {
  if (level === 'none') return { buffer: input, mime: 'video/mp4', params: {} };

  const dir = await mkdtemp(join(tmpdir(), 'uniq-'));
  const inPath = join(dir, 'in');
  const outPath = join(dir, 'out.mp4');
  const cleanup = async () => {
    for (const f of [inPath, outPath]) await unlink(f).catch(() => {});
    await rmdir(dir).catch(() => {});
  };

  try {
    await writeFile(inPath, input);

    // ЭКОНОМ-СЖАТИЕ (меньше аплоад-трафика через резид-прокси): ширину капаем до 720 (верт. рилсы 720×1280),
    // CRF повыше = легче файл, аудио пожиже. На телефоне не видно, но байты в разы меньше. Всё через env.
    const { args, argsNoAudio, params } = buildUniqArgs({
      seed: seed | 0, level, inPath, outPath,
      maxW: process.env.VIDEO_MAX_WIDTH, crf: process.env.VIDEO_CRF, audioBr: process.env.VIDEO_AUDIO_BR,
    });

    // 1-я попытка — со звуком (сдвиг темпа). Если исходник без аудио или atempo
    // ругнётся — 2-я попытка без аудио-фильтра.
    try {
      await run('ffmpeg', args);
    } catch {
      await unlink(outPath).catch(() => {});
      await run('ffmpeg', argsNoAudio);
    }

    const buffer = await readFile(outPath);
    return { buffer, mime: 'video/mp4', params };
  } finally {
    await cleanup();
  }
}
