const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// CORS — cho phép file local và mọi origin gọi vào
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ========== CONFIG ==========
// Lưu data từ app HTML sync lên
let DATA = {
  accounts: [],
  profitEntries: {},
  costs: [],
  campaigns: [],
  balance: {},
  tgToken: process.env.TG_TOKEN || '',
  tgChatId: process.env.TG_CHAT_ID || '',
  tgNotifyPayout: true,
  tgNotifyWarranty: true,
  tgNotifyDaily: true,
  tgLastDaily: '',
  tgWarrantyNotified: {}
};

// ========== TELEGRAM ==========
async function sendTelegram(msg) {
  if (!DATA.tgToken || !DATA.tgChatId) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${DATA.tgToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: DATA.tgChatId,
          text: msg,
          parse_mode: 'HTML'
        })
      }
    );
    const json = await res.json();
    console.log('[TG]', json.ok ? '✅ Sent' : '❌ Failed', json.description || '');
    return json.ok;
  } catch (e) {
    console.error('[TG Error]', e.message);
    return false;
  }
}

// ========== HELPERS ==========
function fmt(n) {
  return '$' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtVND(usd) {
  return Math.round(usd * 26000).toLocaleString('vi-VN') + '₫';
}
function getToday() {
  return new Date().toISOString().split('T')[0];
}
function getTotals() {
  const accounts = DATA.accounts || [];
  const costs = DATA.costs || [];
  const pe = DATA.profitEntries || {};
  const ti = accounts.reduce((s, a) => s + (a.costUSD || 0), 0)
           + costs.reduce((s, c) => s + (c.usd || 0), 0);
  const tv = accounts.reduce((s, a) => {
    const v = (a.onHold || 0) - (a.orders || 0) * 5 + (a.netEarnings || 0);
    return s + v; // Full value, không nhân 0.75
  }, 0);
  const tp = Object.values(pe).flat().reduce((s, e) => s + (e.amount || 0), 0);
  const live = accounts.filter(a => a.status === 'LIVE').length;
  const die = accounts.filter(a => a.status === 'DIE').length;
  const warn = accounts.filter(a => a.status === 'WARNING').length;
  return { ti, tv, tp, live, die, warn };
}

// ========== NOTIFICATION LOGIC ==========
async function checkNotifications() {
  const today = getToday();
  const todayMs = new Date(today).getTime();
  const hour = new Date().getHours();
  console.log(`[CHECK] ${today} ${hour}:00 — Running notification check...`);

  // 1. PAYOUT ALERTS
  if (DATA.tgNotifyPayout) {
    const soon = (DATA.accounts || []).filter(a => {
      if (!a.payout) return false;
      const diff = (new Date(a.payout).getTime() - todayMs) / 86400000;
      return diff >= 0 && diff <= 3;
    });
    if (soon.length) {
      const lines = soon.map(a => {
        const diff = Math.round((new Date(a.payout).getTime() - todayMs) / 86400000);
        const when = diff === 0 ? '🔴 HÔM NAY' : diff === 1 ? '🟡 Ngày mai' : `🟢 Còn ${diff} ngày`;
        return `• <b>${a.name}</b> — ${when} (${a.payout})`;
      }).join('\n');
      await sendTelegram(`⏰ <b>Sắp đến ngày về tiền!</b>\n\n${lines}`);
      await sleep(500);
    }
  }

  // 2. WARRANTY ENDED
  if (DATA.tgNotifyWarranty && DATA.campaigns) {
    const ended = DATA.campaigns.filter(c => {
      if (!c.activateDate) return false;
      return c.activateDate === today && !(DATA.tgWarrantyNotified || {})[c.id];
    });
    if (ended.length) {
      if (!DATA.tgWarrantyNotified) DATA.tgWarrantyNotified = {};
      const lines = ended.map(c => `• <b>${c.name}</b> — ${c.qty} acc sẵn sàng bán!`).join('\n');
      await sendTelegram(`🎉 <b>Hết bảo hành rồi!</b>\n\n${lines}\n\n✅ Có thể bắt đầu bán ngay hôm nay.`);
      ended.forEach(c => { DATA.tgWarrantyNotified[c.id] = true; });
      await sleep(500);
    }
  }

  // 3. DAILY SUMMARY lúc 20h
  const minute = new Date().getMinutes();
  // Daily summary lúc 20:12 (test) — đổi lại thành hour >= 20 sau khi test xong
  if (DATA.tgNotifyDaily && hour === 20 && minute >= 12 && DATA.tgLastDaily !== today) {
    const pe = DATA.profitEntries || {};
    const todayEntries = pe[today] || [];
    const todayTotal = todayEntries.reduce((s, e) => s + e.amount, 0);
    const t = getTotals();
    const bal = DATA.balance || {};
    const totalBal = t.tv + (bal.pipo || 0) + (bal.mango || 0) + (bal.flash || 0);

    const msg = `📊 <b>Tóm tắt ngày ${today}</b>\n\n`
      + `💰 Profit: <b>${fmt(todayTotal)}</b> (~${fmtVND(todayTotal)})\n`
      + `📦 Số đơn: <b>${todayEntries.length}</b>\n`
      + `👤 Accounts: LIVE ${t.live} · DIE ${t.die} · WARNING ${t.warn}\n`
      + `💳 Tổng số dư: <b>${fmt(totalBal)}</b> (~${fmtVND(totalBal)})`;

    await sendTelegram(msg);
    DATA.tgLastDaily = today;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ========== CRON JOBS ==========
// Kiểm tra mỗi giờ
cron.schedule('0 * * * *', () => {
  checkNotifications();
});

// Ping chính mình mỗi 14 phút để Render không ngủ
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
if (SELF_URL) {
  cron.schedule('*/14 * * * *', async () => {
    try {
      await fetch(SELF_URL + '/ping');
      console.log('[PING] Self-ping OK');
    } catch (e) {
      console.log('[PING] Failed:', e.message);
    }
  });
}

// ========== API ROUTES ==========

// App HTML sync data lên đây
app.post('/sync', (req, res) => {
  const d = req.body;
  if (!d) return res.status(400).json({ ok: false });

  // Merge data
  DATA.accounts = d.accounts || DATA.accounts;
  DATA.profitEntries = d.profitEntries || DATA.profitEntries;
  DATA.costs = d.costs || DATA.costs;
  DATA.campaigns = d.campaigns || DATA.campaigns;
  DATA.balance = d.balance || DATA.balance;
  if (d.tgToken) DATA.tgToken = d.tgToken;
  if (d.tgChatId) DATA.tgChatId = d.tgChatId;
  DATA.tgNotifyPayout = d.tgNotifyPayout ?? DATA.tgNotifyPayout;
  DATA.tgNotifyWarranty = d.tgNotifyWarranty ?? DATA.tgNotifyWarranty;
  DATA.tgNotifyDaily = d.tgNotifyDaily ?? DATA.tgNotifyDaily;

  console.log(`[SYNC] Data updated — ${DATA.accounts.length} accounts, ${Object.keys(DATA.profitEntries).length} profit days`);
  res.json({ ok: true, accounts: DATA.accounts.length });
});

// Test gửi Telegram ngay
app.post('/test', async (req, res) => {
  const ok = await sendTelegram('🛒 <b>TikShop Bot</b>\n✅ Server đang chạy 24/7!\nMọi thông báo sẽ được gửi tự động.');
  res.json({ ok });
});

// Force check ngay
app.post('/check', async (req, res) => {
  await checkNotifications();
  res.json({ ok: true });
});

// Gửi báo cáo ngay
app.post('/report', async (req, res) => {
  const today = getToday();
  const pe = DATA.profitEntries || {};
  const todayEntries = pe[today] || [];
  const todayTotal = todayEntries.reduce((s, e) => s + e.amount, 0);
  const t = getTotals();
  const bal = DATA.balance || {};
  const totalBal = t.tv + (bal.pipo || 0) + (bal.mango || 0) + (bal.flash || 0);
  const msg = `📊 <b>Báo cáo ${today}</b>\n\n`
    + `💰 Profit hôm nay: <b>${fmt(todayTotal)}</b> (~${fmtVND(todayTotal)})\n`
    + `📦 Số đơn: <b>${todayEntries.length}</b>\n`
    + `👤 LIVE: ${t.live} · DIE: ${t.die} · WARNING: ${t.warn}\n`
    + `💳 Tổng số dư: <b>${fmt(totalBal)}</b> (~${fmtVND(totalBal)})`;
  const ok = await sendTelegram(msg);
  res.json({ ok });
});

// Ping endpoint
app.get('/ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), accounts: DATA.accounts.length });
});

app.get('/', (req, res) => {
  res.send(`
    <h2>🛒 TikShop Bot Server</h2>
    <p>Status: <b style="color:green">Running ✅</b></p>
    <p>Accounts: ${DATA.accounts.length}</p>
    <p>Last check: ${new Date().toLocaleString('vi-VN')}</p>
    <p>Endpoints: POST /sync · POST /test · POST /report · GET /ping</p>
  `);
});

// ========== START ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 TikShop Bot running on port ${PORT}`);
  console.log(`TG Token: ${DATA.tgToken ? '✅ Set' : '❌ Not set (set TG_TOKEN env)'}`);
  console.log(`TG ChatID: ${DATA.tgChatId ? '✅ Set' : '❌ Not set (set TG_CHAT_ID env)'}`);
  // Check ngay khi start
  setTimeout(checkNotifications, 3000);
});
