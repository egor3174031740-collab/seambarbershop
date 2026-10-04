import { DatabaseSync } from 'node:sqlite'; // built into Node >= 22.5, no native deps
import { computeSlots } from './slots.ts';

export const OPEN = 10 * 60, CLOSE = 20 * 60, LUNCH = { start: 14 * 60, end: 15 * 60 }, STEP = 30, LEAD_MIN = 30;

export function nowLocal(tz = process.env.TZ_NAME ?? 'Europe/Moscow') {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t: string) => p.find(x => x.type === t)!.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, min: +g('hour') * 60 + +g('minute') };
}
export const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY, name TEXT, price INTEGER, duration INTEGER, active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS masters  (id INTEGER PRIMARY KEY, name TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS bookings (id INTEGER PRIMARY KEY, tg_id INTEGER, client_name TEXT, master_id INTEGER, service_id INTEGER,
      service_name TEXT, price INTEGER, date TEXT, start_min INTEGER, end_min INTEGER, status TEXT DEFAULT 'active');
    CREATE INDEX IF NOT EXISTS ix_b ON bookings(master_id, date);`);
  if (!db.prepare('SELECT 1 FROM services').get()) {
    const s = db.prepare('INSERT INTO services(name,price,duration) VALUES (?,?,?)');
    for (const r of [['Мужская стрижка', 2000, 60], ['Стрижка машинкой', 1500, 30], ['Борода', 1200, 30], ['Стрижка + борода', 3000, 90], ['Детская стрижка', 1300, 30], ['Камуфляж седины', 1800, 30]]) s.run(...r as [string, number, number]);
    const m = db.prepare('INSERT INTO masters(name) VALUES (?)');
    for (const n of ['Александр', 'Максим', 'Даниил']) m.run(n);
  }
  return db;
}

type Row = Record<string, any>;
export const services = (db: DatabaseSync) => db.prepare('SELECT * FROM services WHERE active=1').all() as Row[];
export const masters = (db: DatabaseSync) => db.prepare('SELECT * FROM masters WHERE active=1').all() as Row[];

export function freeSlots(db: DatabaseSync, masterId: number, date: string, duration: number): number[] {
  const busy = (db.prepare("SELECT start_min s, end_min e FROM bookings WHERE master_id=? AND date=? AND status='active'").all(masterId, date) as Row[])
    .map(r => ({ start: r.s, end: r.e }));
  const now = nowLocal();
  if (date < now.date) return [];
  return computeSlots({ work: [{ start: OPEN, end: CLOSE }], busy: [...busy, LUNCH], duration, step: STEP, earliest: date === now.date ? now.min + LEAD_MIN : 0 });
}
/** masterId 0 = any master: union of slots */
export function slotsFor(db: DatabaseSync, masterId: number, date: string, duration: number): number[] {
  const ids = masterId ? [masterId] : masters(db).map(m => m.id);
  return [...new Set(ids.flatMap(id => freeSlots(db, id, date, duration)))].sort((a, b) => a - b);
}

/** Re-checks the slot inside an exclusive transaction: two clients can never get the same time. */
export function book(db: DatabaseSync, p: { tgId: number; name: string; masterId: number; serviceId: number; date: string; startMin: number }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const svc = db.prepare('SELECT * FROM services WHERE id=? AND active=1').get(p.serviceId) as Row | undefined;
    if (!svc) throw new Error('no_service');
    const ids = p.masterId ? [p.masterId] : masters(db).map(m => m.id);
    const mid = ids.find(id => freeSlots(db, id, p.date, svc.duration).includes(p.startMin));
    if (!mid) { db.exec('ROLLBACK'); return null; }
    const r = db.prepare('INSERT INTO bookings(tg_id,client_name,master_id,service_id,service_name,price,date,start_min,end_min) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(p.tgId, p.name, mid, svc.id, svc.name, svc.price, p.date, p.startMin, p.startMin + svc.duration);
    db.exec('COMMIT');
    return { id: Number(r.lastInsertRowid), masterId: mid, service: svc.name, price: svc.price as number };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export const myBookings = (db: DatabaseSync, tgId: number) =>
  db.prepare("SELECT b.*, m.name master FROM bookings b JOIN masters m ON m.id=b.master_id WHERE tg_id=? AND status='active' AND date>=? ORDER BY date,start_min").all(tgId, nowLocal().date) as Row[];
export const cancel = (db: DatabaseSync, id: number, tgId: number) =>
  Number(db.prepare("UPDATE bookings SET status='cancelled' WHERE id=? AND tg_id=? AND status='active'").run(id, tgId).changes) > 0;
