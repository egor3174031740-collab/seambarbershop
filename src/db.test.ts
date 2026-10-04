import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, book, slotsFor, addDays, nowLocal, hhmm } from './db.ts';

const date = addDays(nowLocal().date, 2); // future day: independent of current time
const u = (tgId: number) => ({ tgId, name: 'T', date });

test('same slot cannot be booked twice; overlap with a longer service is rejected', () => {
  const db = openDb();
  const a = book(db, { ...u(1), masterId: 1, serviceId: 1, startMin: 15 * 60 }); // 60 min
  assert.ok(a);
  assert.equal(book(db, { ...u(2), masterId: 1, serviceId: 1, startMin: 15 * 60 }), null);
  assert.equal(book(db, { ...u(2), masterId: 1, serviceId: 3, startMin: 15 * 60 + 30 }), null); // overlaps
  assert.ok(book(db, { ...u(2), masterId: 1, serviceId: 3, startMin: 16 * 60 }));            // right after: ok
});
test('"any master" falls through to the next free master', () => {
  const db = openDb();
  const r1 = book(db, { ...u(1), masterId: 0, serviceId: 1, startMin: 11 * 60 });
  const r2 = book(db, { ...u(2), masterId: 0, serviceId: 1, startMin: 11 * 60 });
  assert.notEqual(r1!.masterId, r2!.masterId);
});
test('slots respect lunch and closing time; booked time disappears', () => {
  const db = openDb();
  const s = slotsFor(db, 1, date, 60).map(hhmm);
  assert.ok(!s.includes('14:00') && !s.includes('13:30') && s.includes('13:00') && s.at(-1) === '19:00');
  book(db, { ...u(1), masterId: 1, serviceId: 1, startMin: 10 * 60 });
  assert.ok(!slotsFor(db, 1, date, 60).map(hhmm).includes('10:00'));
});
