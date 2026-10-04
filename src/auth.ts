import { createHmac, timingSafeEqual } from 'node:crypto';

export type TgUser = { id:number; first_name?:string; last_name?:string; username?:string };
export function verifyTelegramInitData(initData:string, botToken:string, maxAge=86400): TgUser {
  if(!initData) throw new Error('missing_init_data');
  const p=new URLSearchParams(initData); const hash=p.get('hash');
  if(!hash) throw new Error('missing_hash');
  const authDate=Number(p.get('auth_date')||0);
  if(!authDate || Math.floor(Date.now()/1000)-authDate>maxAge) throw new Error('expired_init_data');
  const check=[...p.entries()].filter(([k])=>k!=='hash').sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=createHmac('sha256','WebAppData').update(botToken).digest();
  const expected=createHmac('sha256',secret).update(check).digest('hex');
  const a=Buffer.from(expected,'hex'), b=Buffer.from(hash,'hex');
  if(a.length!==b.length || !timingSafeEqual(a,b)) throw new Error('invalid_init_data');
  const user=JSON.parse(p.get('user')||'null');
  if(!user?.id) throw new Error('missing_user');
  return user;
}
