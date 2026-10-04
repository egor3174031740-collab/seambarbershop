import { neon, Pool } from '@neondatabase/serverless';
import { computeSlots } from './slots.ts';

export const OPEN = 10 * 60, CLOSE = 20 * 60, LUNCH = { start: 14 * 60, end: 15 * 60 }, STEP = 30, LEAD_MIN = 30;

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
export const sql = neon(process.env.DATABASE_URL);
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function initDb() {
  await sql`CREATE TABLE IF NOT EXISTS services (id SERIAL PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL, duration INTEGER NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE)`;
  await sql`CREATE TABLE IF NOT EXISTS masters (id SERIAL PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE)`;
  await sql`CREATE TABLE IF NOT EXISTS bookings (
    id BIGSERIAL PRIMARY KEY, tg_id BIGINT NOT NULL, client_name TEXT, master_id INTEGER NOT NULL REFERENCES masters(id),
    service_id INTEGER NOT NULL REFERENCES services(id), service_name TEXT NOT NULL, price INTEGER NOT NULL,
    date DATE NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS ux_services_name ON services(name)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS ux_masters_name ON masters(name)`;
  await sql`CREATE INDEX IF NOT EXISTS ix_bookings_master_date ON bookings(master_id, date)`;
  await sql`CREATE INDEX IF NOT EXISTS ix_bookings_tg_status ON bookings(tg_id, status, date)`;
  await sql`INSERT INTO services(name,price,duration)
    VALUES ('Мужская стрижка',2000,60),('Стрижка машинкой',1500,30),('Борода',1200,30),('Стрижка + борода',3000,90),('Детская стрижка',1300,30),('Камуфляж седины',1800,30)
    ON CONFLICT(name) DO NOTHING`;
  await sql`INSERT INTO masters(name)
    VALUES ('Александр'),('Максим'),('Даниил')
    ON CONFLICT(name) DO NOTHING`;
}

type Row = Record<string, any>;
export async function services() { return await sql`SELECT id,name,price,duration FROM services WHERE active=TRUE ORDER BY id`; }
export async function masters() { return await sql`SELECT id,name FROM masters WHERE active=TRUE ORDER BY id`; }

export function nowLocal(tz = process.env.TZ_NAME ?? 'Europe/Moscow') {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(new Date());
  const g = (t:string) => p.find(x => x.type === t)!.value;
  return { date:`${g('year')}-${g('month')}-${g('day')}`, min:+g('hour')*60 + +g('minute') };
}
export const addDays = (d:string,n:number) => { const x=new Date(d+'T00:00:00Z'); x.setUTCDate(x.getUTCDate()+n); return x.toISOString().slice(0,10); };
export const hhmm = (m:number) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

async function freeSlots(masterId:number,date:string,duration:number) {
  const busy = await sql`SELECT start_min AS s,end_min AS e FROM bookings WHERE master_id=${masterId} AND date=${date} AND status='active'`;
  const now=nowLocal();
  if(date<now.date) return [];
  return computeSlots({work:[{start:OPEN,end:CLOSE}],busy:[...busy.map((r:any)=>({start:r.s,end:r.e})),LUNCH],duration,step:STEP,earliest:date===now.date?now.min+LEAD_MIN:0});
}
export async function slotsFor(masterId:number,date:string,duration:number) {
  const ids = masterId ? [masterId] : (await masters()).map((m:any)=>m.id);
  return [...new Set((await Promise.all(ids.map(id=>freeSlots(id,date,duration)))).flat() as number[])].sort((a,b)=>a-b);
}

export async function book(p:{tgId:number;name:string;masterId:number;serviceId:number;date:string;startMin:number}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize booking attempts for this branch/day/time while inside the transaction.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${p.date}:${p.startMin}`]);
    const s = (await client.query('SELECT * FROM services WHERE id=$1 AND active=TRUE',[p.serviceId])).rows[0] as Row|undefined;
    if(!s) throw new Error('no_service');
    const ms = p.masterId ? [{id:p.masterId}] : (await client.query('SELECT id FROM masters WHERE active=TRUE ORDER BY id')).rows;
    let chosen:number|undefined;
    for(const m of ms){
      const busy=(await client.query("SELECT start_min AS s,end_min AS e FROM bookings WHERE master_id=$1 AND date=$2 AND status='active'",[m.id,p.date])).rows;
      const now=nowLocal();
      const slots=computeSlots({work:[{start:OPEN,end:CLOSE}],busy:[...busy.map((r:any)=>({start:r.s,end:r.e})),LUNCH],duration:s.duration,step:STEP,earliest:p.date===now.date?now.min+LEAD_MIN:0});
      if(slots.includes(p.startMin)){chosen=m.id;break;}
    }
    if(!chosen){await client.query('ROLLBACK');return null;}
    const r=await client.query(`INSERT INTO bookings(tg_id,client_name,master_id,service_id,service_name,price,date,start_min,end_min)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[p.tgId,p.name,chosen,s.id,s.name,s.price,p.date,p.startMin,p.startMin+s.duration]);
    await client.query('COMMIT');
    return {id:Number(r.rows[0].id),masterId:chosen,service:s.name,price:s.price};
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}
export async function myBookings(tgId:number){return await sql`SELECT b.*,m.name AS master FROM bookings b JOIN masters m ON m.id=b.master_id WHERE b.tg_id=${tgId} AND b.status='active' AND b.date>=${nowLocal().date} ORDER BY b.date,b.start_min`;}
export async function cancel(id:number,tgId:number){const r=await sql`UPDATE bookings SET status='cancelled' WHERE id=${id} AND tg_id=${tgId} AND status='active'`;return Number(r.count)>0;}
