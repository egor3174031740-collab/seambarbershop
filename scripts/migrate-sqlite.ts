import { DatabaseSync } from 'node:sqlite';
import { Pool } from '@neondatabase/serverless';

const dbPath=process.env.DB_PATH||'barbershop.db';
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const sqlite=new DatabaseSync(dbPath); const pool=new Pool({connectionString:process.env.DATABASE_URL}); const c=await pool.connect();
try{
  await c.query('BEGIN');
  await c.query(`CREATE TABLE IF NOT EXISTS services (id SERIAL PRIMARY KEY,name TEXT NOT NULL,price INTEGER NOT NULL,duration INTEGER NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE)`);
  await c.query(`CREATE TABLE IF NOT EXISTS masters (id SERIAL PRIMARY KEY,name TEXT NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE)`);
  await c.query(`CREATE TABLE IF NOT EXISTS bookings (id BIGSERIAL PRIMARY KEY,tg_id BIGINT NOT NULL,client_name TEXT,master_id INTEGER NOT NULL REFERENCES masters(id),service_id INTEGER NOT NULL REFERENCES services(id),service_name TEXT NOT NULL,price INTEGER NOT NULL,date DATE NOT NULL,start_min INTEGER NOT NULL,end_min INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const services=sqlite.prepare('SELECT * FROM services').all() as any[]; const masters=sqlite.prepare('SELECT * FROM masters').all() as any[]; const bookings=sqlite.prepare('SELECT * FROM bookings').all() as any[];
  for(const r of services) await c.query(`INSERT INTO services(id,name,price,duration,active) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,price=EXCLUDED.price,duration=EXCLUDED.duration,active=EXCLUDED.active`,[r.id,r.name,r.price,r.duration,Boolean(r.active)]);
  for(const r of masters) await c.query(`INSERT INTO masters(id,name,active) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,active=EXCLUDED.active`,[r.id,r.name,Boolean(r.active)]);
  for(const r of bookings) await c.query(`INSERT INTO bookings(id,tg_id,client_name,master_id,service_id,service_name,price,date,start_min,end_min,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,[r.id,r.tg_id,r.client_name,r.master_id,r.service_id,r.service_name,r.price,r.date,r.start_min,r.end_min,r.status]);
  await c.query(`SELECT setval(pg_get_serial_sequence('services','id'),COALESCE((SELECT MAX(id) FROM services),1),true)`);
  await c.query(`SELECT setval(pg_get_serial_sequence('masters','id'),COALESCE((SELECT MAX(id) FROM masters),1),true)`);
  await c.query(`SELECT setval(pg_get_serial_sequence('bookings','id'),COALESCE((SELECT MAX(id) FROM bookings),1),true)`);
  await c.query('COMMIT'); console.log(`Migrated ${services.length} services, ${masters.length} masters, ${bookings.length} bookings.`);
}catch(e){await c.query('ROLLBACK');throw e}finally{c.release();sqlite.close();await pool.end()}
