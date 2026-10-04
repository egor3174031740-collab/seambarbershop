const tg = window.Telegram?.WebApp; 
tg?.ready(); 
tg?.expand();

const content = document.querySelector('#content'); 
document.querySelector('#close')?.addEventListener('click', () => tg?.close());

// ИСПРАВЛЕНИЕ: Перевели 'x-telegram-init-data' в нижний регистр, как требует Node.js сервер
const headers = {
  'content-type': 'application/json',
  'x-telegram-init-data': tg?.initData || ''
};

async function api(path, opt = {}) {
  const r = await fetch(path, {
    ...opt,
    headers: { ...headers, ...(opt.headers || {}) }
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Ошибка');
  return d;
}

const money = n => new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
const dateLabel = d => new Date(d + 'T00:00:00Z').toLocaleDateString('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

let S = [], M = [], state = { service: null, master: 0, date: null, time: null };

function shell(title, body, back = true) {
  content.innerHTML = `<div class="card"><div class="title">${title}</div>${body}</div>${back ? '<button class="btn secondary" id="back">← Назад</button>' : ''}`;
  document.querySelector('#back')?.addEventListener('click', home);
}

async function home() {
  try {
    const b = await api('/api/bookings');
    shell('BARBER HOUSE', `<div class="grid"><button class="btn" id="book">✂️ Записаться</button><button class="btn secondary" id="my">📅 Мои записи</button></div><div class="card"><b>Услуги и цены</b><div class="price">${S.map(x => `x.name — {money(x.price)}`).join(' · ')}</div></div>`, false);
    document.querySelector('#book').onclick = servicesView;
    document.querySelector('#my').onclick = () => myView(b.bookings);
  } catch (e) {
    error(e);
  }
}

async function servicesView() {
  shell('Выберите услугу', S.map(x => `<button class="btn secondary service" data-id="${x.id}" style="margin:5px 0;text-align:left"><b>${x.name}</b><div class="price">${money(x.price)} · ${x.duration} мин</div></button>`).join(''));
  document.querySelectorAll('.service').forEach(b => b.onclick = () => {
    state.service = S.find(x => x.id == b.dataset.id);
    mastersView();
  });
}

async function mastersView() {
  shell('Выберите мастера', `<button class="btn secondary master" data-id="0" style="margin:5px 0">Любой свободный</button>` + M.map(x => `<button class="btn secondary master" data-id="${x.id}" style="margin:5px 0">${x.name}</button>`).join(''));
  document.querySelectorAll('.master').forEach(b => b.onclick = () => {
    state.master = +b.dataset.id;
    datesView();
  });
}

async function datesView() {
  let out = '<div class="grid">', n = 0;
  const now = new Date();
  for (let i = 0; i < 14 && n < 7; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i)).toISOString().slice(0, 10);
    const x = await api(`/api/slots?serviceId=${state.service.id}&masterId=${state.master}&date=${d}`);
    if (x.slots.length) {
      out += `<button class="btn secondary date" data-date="${d}">${dateLabel(d)}</button>`;
      n++;
    }
  }
  out += '</div>';
  shell(n ? 'Выберите дату' : 'Свободного времени нет', n ? out : '<div class="empty">На ближайшие две недели свободного времени нет.</div>');
  document.querySelectorAll('.date').forEach(b => b.onclick = () => timesView(b.dataset.date));
}

async function timesView(date) {
  state.date = date;
  const x = await api(`/api/slots?serviceId=${state.service.id}&masterId=${state.master}&date=${date}`);
  shell(dateLabel(date), `<div class="grid">${x.slots.map(t => `<button class="btn secondary time" data-time="t">{hhmm(t)}</button>`).join('')}</div>`);
  document.querySelectorAll('.time').forEach(b => b.onclick = () => confirmView(+b.dataset.time));
}

async function confirmView(time) {
  state.time = time;
  const m = state.master ? M.find(x => x.id === state.master)?.name : 'любой свободный мастер';
  shell('Подтвердите запись', `<p><b>${state.service.name}</b><br>${money(state.service.price)} · ${state.service.duration} мин<br>${dateLabel(state.date)}, ${hhmm(time)}<br>Мастер: ${m}</p><button class="btn" id="confirm">✅ Записаться</button>`);
  document.querySelector('#confirm').onclick = async () => {
    try {
      const r = await api('/api/book', {
        method: 'POST',
        body: JSON.stringify({ serviceId: state.service.name ? state.service.id : Number(state.service.id), masterId: state.master, date: state.date, startMin: state.time })
      });
      tg?.HapticFeedback?.notificationOccurred('success');
      shell('Готово!', `<p>Вы записаны на <b>${dateLabel(state.date)} в ${hhmm(state.time)}</b>.<br>${r.booking.service} — ${money(r.booking.price)}</p><button class="btn" id="home">В меню</button>`, false);
      document.querySelector('#home').onclick = home;
    } catch (e) {
      alert(e.message);
    }
  };
}

function myView(bs) {
  shell('Мои записи', bs.length ? bs.map(b => `<div class="card booking"><div><b>${dateLabel(b.date)} ${hhmm(b.start_min)}</b><div class="price">${b.service_name} · ${b.master}</div></div><button class="btn secondary cancel" data-id="${b.id}">Отменить</button></div>`).join('') : '<div class="empty">Предстоящих записей нет.</div>');
  document.querySelectorAll('.cancel').forEach(b => b.onclick = async () => {
    if (confirm('Отменить запись?')) {
      await api(`/api/bookings/${b.dataset.id}/cancel`, { method: 'POST' });
      myView((await api('/api/bookings')).bookings);
    }
  });
}

function error(e) {
  content.innerHTML = `<div class="card"><div class="title">Не удалось открыть приложение</div><div class="empty">${e.message === 'missing_init_data' ? 'Откройте приложение строго из Telegram бота.' : e.message}</div></div>`;
}

(async () => {
  try {
    const [a, b] = await Promise.all([api('/api/services'), api('/api/masters')]);
    S = a.services;
    M = b.masters;
    await home();
  } catch (e) {
    error(e);
  }
})();
