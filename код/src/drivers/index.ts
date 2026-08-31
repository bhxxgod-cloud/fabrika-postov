import type { PlatformDriver } from './types.js';
import { tiktokDriver } from './tiktok.js';
import { threadsDriver } from './threads.js';
import { youtubeDriver } from './youtube.js';
import { instagramDriver } from './instagram.js';

// Реестр драйверов. Воркер и прогрев выбирают драйвер по account.platform.
// Добавить площадку = добавить файл-драйвер и строку сюда.
const drivers: Record<string, PlatformDriver> = {
  tiktok: tiktokDriver,
  threads: threadsDriver,
  youtube: youtubeDriver,
  instagram: instagramDriver,
  comments: instagramDriver, // «Ферма комментов» комментит через Instagram (пока)
};

export function driverFor(platform: string): PlatformDriver {
  const d = drivers[platform];
  if (!d) throw new Error(`нет драйвера для площадки: ${platform}`);
  return d;
}

export { drivers };
export * from './types.js';
