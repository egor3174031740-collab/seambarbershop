import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyTelegramInitData } from './auth.ts';
import { initDb, services, masters, slotsFor, book, myBookings, cancel } from './db-neon.ts';
import { bot } from './bot.ts';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../public');
const port = Number(process.env.PORT || 10000);
const botToken = process.env.BOT_TOKEN || '';

function json(res: any, status: number, data: any) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-telegram-init-data',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    // Разрешаем Telegram открывать наше приложение внутри своего iframe
    'content-security-policy': "frame-ancestors 'self' https://t.me https://telegram.org https://*.tg.dev telegram://*;",
  });
  res.end(JSON.stringify(data));
}

async function body(req: any) {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

function user(req: any) {
  return verifyTelegramInitData(String(req.headers['x-telegram-init-data'] || ''), botToken);
}

function okPath(p: string) {
  return p.replace(/\/+\$/, '') || '/';
}

async function handler(req: any, res: any) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = okPath(url.pathname);

    // Обработка предварительных CORS-запросов (Preflight)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, x-telegram-init-data',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'content-security-policy': "frame-ancestors 'self' https://t.me https://telegram.org https://*.tg.dev telegram://*;",
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/telegram/webhook') {
      const secret = process.env.WEBHOOK_SECRET;
      if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
        return json(res, 401, { error: 'unauthorized' });
      }
      const update = await body(req);
      await bot.handleUpdate(update);
      return json(res, 200, { ok: true });
    }

    if (path.startsWith('/api/')) {
      if (req.method === 'GET' && path === '/api/services') {
        return json(res, 200, { services: await services() });
      }

      if (req.method === 'GET' && path === '/api/masters') {
        return json(res, 200, { masters: await masters() });
      }

      if (req.method === 'GET' && path === '/api/slots') {
        const serviceId = Number(url.searchParams.get('serviceId'));
        const masterId = Number(url.searchParams.get('masterId') || 0);
        const date = url.searchParams.get('date') || '';
        const ss = await services();
        const s = (ss as any[]).find((x) => x.id === serviceId);
        if (!s || !/^\d{4}-\d{2}-\d{2}\$/.test(date)) {
          return json(res, 400, { error: 'bad_request' });
        }
        return json(res, 200, { slots: await slotsFor(masterId, date, s.duration) });
      }

      const u = user(req);

      if (req.method === 'GET' && path === '/api/bookings') {
        return json(res, 200, { bookings: await myBookings(u.id) });
      }

      if (req.method === 'POST' && path === '/api/book') {
        const b = await body(req);
        const r = await book({
          tgId: u.id,
          name: u.first_name || 'Клиент',
          masterId: Number(b.masterId || 0),
          serviceId: Number(b.serviceId),
          date: String(b.date),
          startMin: Number(b.startMin),
        });
        if (!r) return json(res, 409, { error: 'slot_taken' });
        return json(res, 200, { booking: r });
      }

      const m = path.match(/^\/api\/bookings\/(\d+)\/cancel\$/);
      if (req.method === 'POST' && m) {
        return json(res, 200, { ok: await cancel(Number(m[1]), u.id) });
      }

      return json(res, 404, { error: 'not_found' });
    }

    if (req.method === 'GET') {
      const file = path === '/' ? '/index.html' : path;
      const full = join(root, file.replace(/^\//, ''));
      const data = await readFile(full);
      const ext = extname(full);
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
      };
      
      // Отдаем статические файлы со специальными заголовками встраивания для Telegram
      res.writeHead(200, { 
        'content-type': types[ext] || 'application/octet-stream',
        'access-control-allow-origin': '*',
        'content-security-policy': "frame-ancestors 'self' https://t.me https://telegram.org https://*.tg.dev telegram://*;",
      });
      res.end(data);
      return;
    }

    json(res, 405, { error: 'method_not_allowed' });
  } catch (e: any) {
    console.error(e);
    const status = e.message?.includes('init_data') || e.message === 'missing_user' ? 401 : 500;
    json(res, status, { error: e.message || 'server_error' });
  }
}

if (!botToken) throw new Error('BOT_TOKEN is not set');

await initDb();

const publicUrl = process.env.WEB_APP_URL || process.env.RENDER_EXTERNAL_URL;
if (!publicUrl) throw new Error('WEB_APP_URL or RENDER_EXTERNAL_URL is not set');

const server = createServer(handler);
server.listen(port, '0.0.0.0', async () => {
  console.log(`Web app listening on ${port}`);
  const webhookUrl = `${publicUrl.replace(/\/$/, '')}/telegram/webhook`;
  await bot.api.setWebhook(
    webhookUrl,
    process.env.WEBHOOK_SECRET ? { secret_token: process.env.WEBHOOK_SECRET } : undefined,
  );
  console.log(`Telegram webhook configured: ${webhookUrl}`);
});
