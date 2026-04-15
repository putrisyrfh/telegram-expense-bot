const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const bot = new TelegramBot(TOKEN, { polling: true });

console.log('[startup] GEMINI_API_KEY:',
  GEMINI_API_KEY
    ? `SET (len=${GEMINI_API_KEY.length}, prefix=${GEMINI_API_KEY.slice(0, 6)}..., suffix=...${GEMINI_API_KEY.slice(-4)})`
    : 'MISSING');

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const visionModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

async function callVisionWithRetry(parts, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await visionModel.generateContent(parts);
    } catch (err) {
      const msg = err.message || '';
      const transient = msg.includes('503') || msg.includes('overload') || msg.includes('Service Unavailable') || msg.includes('429');
      if (!transient || attempt === maxRetries) throw err;
      const waitMs = 2000 * attempt; // 2s, 4s, 6s
      console.log(`[retry ${attempt}] Gemini transient error, retry in ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

// ===== GOOGLE AUTH =====
const credentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString()
);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// ===== STATE =====
let lastInsertedRow = null;       // single-row inserts (text expense)
let lastReceiptRows = null;       // [startRow, endRow] dari /receipt save

// ===== START (FORMAT LO — KEEP) =====
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🏔️ Central Asia Expense Bot

Kirim expense ke sini, otomatis masuk Google Sheets!

📝 Format:
[item] [jumlah] [currency] [yg bayar] split [siapa]

✏️ Contoh:
• makan 10 usd putri split all
• taxi 15000 kzt kyne split putri, kyne
• hotel 500000 idr ayu a split semua

💱 Currency: IDR, USD, EUR, KZT, KGS, UZS
👥 Orang: putri, ayu a, kyne, ayu`);
});

// ===== HELPERS =====
function normalizePayer(name) {
  const n = name.toLowerCase();

  if (n.includes('putri')) return 'Putri🐬';
  if (n.includes('kyne')) return 'Kyne🍊';
  if (n.includes('ayu a')) return 'Ayu A🌸';
  if (n.includes('ayu')) return 'Ayu🌿';

  return 'Putri🐬';
}

function getFormattedDate() {
  return new Date().toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: '2-digit'
  }).replace(',', '');
}

function parseExpense(text) {
  text = text.toLowerCase().trim();

  const parts = text.split(' split ');
  if (parts.length !== 2) {
    return { error: 'Tambahin "split". Contoh: makan 10 usd putri split all' };
  }

  const before = parts[0];
  const after = parts[1];

  const words = before.split(' ');
  const amount = parseFloat(words[words.length - 3]);
  const currency = words[words.length - 2].toUpperCase();
  const paidBy = words[words.length - 1];
  const item = words.slice(0, words.length - 3).join(' ');

  let splitTo = [];
  if (after === 'all' || after === 'semua') {
    splitTo = ['putri', 'ayu a', 'kyne', 'ayu'];
  } else {
    splitTo = after.split(',').map(x => x.trim());
  }

  return { item, amount, currency, paidBy, splitTo };
}

function capitalize(str) {
  return str.replace(/\b\w/g, l => l.toUpperCase());
}

// ===== INSERT FUNCTION (BIAR DIPAKE ULANG) =====
async function insertOrUpdateRow(rowNumber, data) {
  const date = getFormattedDate();
  const paidBy = normalizePayer(data.paidBy);

  const splitPutri = data.splitTo.includes('putri');
  const splitAyuA = data.splitTo.includes('ayu a');
  const splitKyne = data.splitTo.includes('kyne');
  const splitAyu = data.splitTo.includes('ayu');

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Spending Tracker!A${rowNumber}:M${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        date,
        data.item,
        data.amount,
        data.currency,

        null,      // Amount IDR → formula

        paidBy,

        splitPutri,
        splitAyuA,
        splitKyne,
        splitAyu,

        null,      // Amount per person → formula
        '',        // Category
        false      // Settled
      ]]
    }
  });
}

// ===== MAIN INPUT =====
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;
  if (receiptSessions[chatId]) return; // skip kalo lagi di flow /receipt

  try {
    const data = parseExpense(text);

    if (data.error) {
      bot.sendMessage(chatId, '❌ ' + data.error);
      return;
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Spending Tracker!A:A',
    });

    const nextRow = (res.data.values || []).length + 1;
    lastInsertedRow = nextRow;

    await insertOrUpdateRow(nextRow, data);

    bot.sendMessage(chatId,
`✅ Tercatat!

📝 ${capitalize(data.item)}
💰 ${data.amount} ${data.currency}
💳 Dibayar: ${capitalize(data.paidBy)}
👥 Split: ${data.splitTo.join(', ')}`
    );

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '❌ Error: ' + err.message);
  }
});

// ===== UNDO =====
function emptyRow() {
  return ['', '', '', '', null, '', false, false, false, false, null, '', false];
}

bot.onText(/\/undo/, async (msg) => {
  const chatId = msg.chat.id;

  // prioritas: clear receipt range kalo lebih recent
  if (lastReceiptRows) {
    const [start, end] = lastReceiptRows;
    const values = [];
    for (let i = start; i <= end; i++) values.push(emptyRow());

    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Spending Tracker!A${start}:M${end}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values }
      });
      bot.sendMessage(chatId, `↩️ ${end - start + 1} item dari struk terakhir berhasil dihapus`);
      lastReceiptRows = null;
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, '❌ Gagal undo');
    }
    return;
  }

  if (!lastInsertedRow) {
    bot.sendMessage(chatId, '❌ Belum ada data buat di-undo');
    return;
  }

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Spending Tracker!A${lastInsertedRow}:M${lastInsertedRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [emptyRow()] }
    });

    bot.sendMessage(chatId, '↩️ Last input berhasil dihapus');

    lastInsertedRow = null;

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '❌ Gagal undo');
  }
});

// ===== EDIT =====
bot.onText(/\/edit (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const text = match[1];

  if (!lastInsertedRow) {
    bot.sendMessage(chatId, '❌ Ga ada data buat diedit');
    return;
  }

  try {
    const data = parseExpense(text);

    if (data.error) {
      bot.sendMessage(chatId, '❌ ' + data.error);
      return;
    }

    await insertOrUpdateRow(lastInsertedRow, data);

    bot.sendMessage(chatId,
`✏️ Updated!

📝 ${capitalize(data.item)}
💰 ${data.amount} ${data.currency}
💳 Dibayar: ${capitalize(data.paidBy)}
👥 Split: ${data.splitTo.join(', ')}`
    );

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '❌ Gagal edit');
  }
});

// ===== RECEIPT MODE (V2: GEMINI VISION + INLINE KEYBOARD) =====

const PEOPLE_KEYS = ['putri', 'kyne', 'ayu_a', 'ayu'];
const PEOPLE_LABELS = {
  putri: 'Putri🐬',
  kyne: 'Kyne🍊',
  ayu_a: 'Ayu A🌸',
  ayu: 'Ayu🌿'
};
const VALID_CURRENCIES = ['IDR', 'USD', 'EUR', 'KZT', 'KGS', 'UZS'];

const receiptSessions = {};

function fmtMoney(n, currency = 'IDR') {
  const rounded = Math.round(n);
  if (currency === 'IDR') return 'Rp ' + rounded.toLocaleString('id-ID');
  return rounded.toLocaleString('en-US') + ' ' + currency;
}

async function ocrReceipt(imageBuffer, mimeType) {
  const prompt = `Lo OCR struk makanan/minuman/belanja. Balikin HANYA JSON valid (no markdown, no backtick), schema:
{
  "items": [{"name": "string", "price": number}],
  "subtotal": number,
  "discount": number,
  "tax": number,
  "service": number,
  "total": number,
  "currency": "IDR" | "USD" | "EUR" | "KZT" | "KGS" | "UZS"
}

Aturan:
- name: nama item, hilangin angka qty/kode produk
- price: harga total per item (kalo qty>1, multiply qty x harga satuan)
- discount: nilai positif (potongan harga)
- tax: PB1/VAT/pajak
- service: service charge
- total: grand total final yang harus dibayar
- Field yg ga ada di struk, isi 0
- Currency default "IDR" kalo ga ketahuan`;

  const result = await callVisionWithRetry([
    { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
    prompt
  ]);
  const text = result.response.text();
  const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

function buildEditScreen(session) {
  const { items, discount, tax, service, currency } = session;
  const subtotal = items.reduce((a, i) => a + i.price, 0);
  const total = subtotal - discount + tax + service;

  let txt = '🧾 Hasil baca struk:\n\n';
  if (items.length === 0) {
    txt += '_(Belum ada item — tap ➕ Tambah)_\n\n';
  } else {
    items.forEach((it, i) => {
      txt += `${i + 1}. ${it.name} — ${fmtMoney(it.price, currency)}\n`;
    });
    txt += `\nSubtotal: ${fmtMoney(subtotal, currency)}\n`;
  }
  if (discount) txt += `Diskon: -${fmtMoney(discount, currency)}\n`;
  if (tax)     txt += `Pajak: ${fmtMoney(tax, currency)}\n`;
  if (service) txt += `Service: ${fmtMoney(service, currency)}\n`;
  txt += `*Total: ${fmtMoney(total, currency)}*\n\n`;
  txt += '_Cek ya, edit kalo OCR salah. Tap ✅ kalo udah benar._';

  const rows = [];
  items.forEach((it, i) => {
    const label = it.name.length > 18 ? it.name.slice(0, 18) + '…' : it.name;
    rows.push([
      { text: `✏️ ${i + 1}. ${label}`, callback_data: `r:edit:${i}` },
      { text: '🗑', callback_data: `r:del:${i}` }
    ]);
  });
  rows.push([{ text: '➕ Tambah item', callback_data: 'r:add' }]);
  rows.push([
    { text: `💸 Diskon`, callback_data: 'r:meta:discount' },
    { text: `📊 Pajak`, callback_data: 'r:meta:tax' }
  ]);
  rows.push([
    { text: `☕ Service`, callback_data: 'r:meta:service' },
    { text: `💱 ${currency}`, callback_data: 'r:meta:currency' }
  ]);
  if (items.length > 0) {
    rows.push([{ text: '✅ Lanjut pilih payer', callback_data: 'r:next' }]);
  }
  rows.push([{ text: '❌ Batal', callback_data: 'r:cancel' }]);

  return { text: txt, keyboard: { inline_keyboard: rows } };
}

function buildPayerScreen() {
  const txt = '💳 Siapa yang bayar struk ini?\n\n_Pilih satu:_';
  const rows = PEOPLE_KEYS.map(k => [{
    text: PEOPLE_LABELS[k],
    callback_data: `r:payer:${k}`
  }]);
  rows.push([{ text: '⬅️ Kembali edit item', callback_data: 'r:back_edit' }]);
  return { text: txt, keyboard: { inline_keyboard: rows } };
}

function buildAssignScreen(session) {
  const idx = session.currentItemIdx;
  const item = session.items[idx];
  const total = session.items.length;
  const assigned = item.assigned;

  let txt = `👥 Assign item ${idx + 1}/${total}:\n\n`;
  txt += `🍴 *${item.name}* — ${fmtMoney(item.price, session.currency)}\n\n`;

  if (assigned.size === 0) {
    txt += '_Belum dipilih siapapun. Tap nama yg makan/minum item ini._';
  } else {
    const names = [...assigned].map(k => PEOPLE_LABELS[k]).join(', ');
    txt += `Dishare: *${names}*`;
    if (assigned.size > 1) {
      txt += `\n→ ${fmtMoney(item.price / assigned.size, session.currency)}/orang`;
    }
  }

  const personRow = PEOPLE_KEYS.map(k => ({
    text: (assigned.has(k) ? '✓ ' : '') + PEOPLE_LABELS[k],
    callback_data: `r:tog:${k}`
  }));

  const rows = [
    personRow.slice(0, 2),
    personRow.slice(2, 4),
    [
      { text: '👥 All', callback_data: 'r:all' },
      { text: '🚫 Clear', callback_data: 'r:clear' }
    ]
  ];

  const navRow = [];
  if (idx > 0) navRow.push({ text: '⬅️ Prev', callback_data: 'r:prev' });
  if (idx < total - 1) {
    navRow.push({ text: 'Next ➡️', callback_data: 'r:nextItem' });
  } else {
    navRow.push({ text: '✅ Selesai assign', callback_data: 'r:doneAssign' });
  }
  rows.push(navRow);
  rows.push([{ text: '❌ Batal', callback_data: 'r:cancel' }]);

  return { text: txt, keyboard: { inline_keyboard: rows } };
}

function calculatePerPerson(session) {
  const { items, discount, tax, service } = session;
  const subtotal = items.reduce((a, i) => a + i.price, 0);
  const adjustedTotal = subtotal - discount + tax + service;
  const factor = subtotal > 0 ? adjustedTotal / subtotal : 1;

  const perPerson = {};
  PEOPLE_KEYS.forEach(k => perPerson[k] = 0);
  let unassigned = 0;

  items.forEach(it => {
    const adj = it.price * factor;
    if (it.assigned.size === 0) {
      unassigned += adj;
    } else {
      const share = adj / it.assigned.size;
      it.assigned.forEach(k => perPerson[k] += share);
    }
  });

  return { perPerson, unassigned, subtotal, adjustedTotal, factor };
}

function buildConfirmScreen(session) {
  const { perPerson, unassigned, adjustedTotal } = calculatePerPerson(session);
  const cur = session.currency;

  let txt = '✅ *Konfirmasi pembagian:*\n\n';
  session.items.forEach((it, i) => {
    const names = it.assigned.size === 0
      ? '⚠️ belum di-assign'
      : [...it.assigned].map(k => PEOPLE_LABELS[k]).join(', ');
    txt += `${i + 1}. ${it.name} — ${fmtMoney(it.price, cur)}\n   → ${names}\n`;
  });

  txt += `\n💸 _Diskon/pajak/service di-prorate proporsional_\n\n`;
  txt += '*Total per orang (sudah include pajak/diskon):*\n';
  PEOPLE_KEYS.forEach(k => {
    if (perPerson[k] > 0) {
      txt += `• ${PEOPLE_LABELS[k]}: ${fmtMoney(perPerson[k], cur)}\n`;
    }
  });

  if (unassigned > 0) {
    txt += `\n⚠️ Belum di-assign: ${fmtMoney(unassigned, cur)}`;
  }

  txt += `\n\n💳 Dibayar oleh: *${PEOPLE_LABELS[session.payer]}*`;
  txt += `\n🧾 Total struk: ${fmtMoney(adjustedTotal, cur)}`;

  const rows = [
    [{ text: '💾 Save ke Sheet', callback_data: 'r:save' }],
    [{ text: '⬅️ Kembali assign', callback_data: 'r:back_assign' }],
    [{ text: '❌ Batal', callback_data: 'r:cancel' }]
  ];

  return { text: txt, keyboard: { inline_keyboard: rows } };
}

async function renderScreen(chatId, session) {
  let screen;
  if (session.step === 'editing') screen = buildEditScreen(session);
  else if (session.step === 'choose_payer') screen = buildPayerScreen();
  else if (session.step === 'assigning') screen = buildAssignScreen(session);
  else if (session.step === 'confirming') screen = buildConfirmScreen(session);
  else return;

  const opts = { parse_mode: 'Markdown', reply_markup: screen.keyboard };

  if (session.editMessageId) {
    try {
      await bot.editMessageText(screen.text, {
        chat_id: chatId,
        message_id: session.editMessageId,
        ...opts
      });
      return;
    } catch (_) { /* fallthrough — kirim baru */ }
  }
  const sent = await bot.sendMessage(chatId, screen.text, opts);
  session.editMessageId = sent.message_id;
}

async function saveReceiptToSheet(chatId, session) {
  const { factor, perPerson, adjustedTotal } = calculatePerPerson(session);
  const date = getFormattedDate();
  const payerLabel = PEOPLE_LABELS[session.payer];

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Spending Tracker!A:A',
  });
  const startRow = (res.data.values || []).length + 1;

  const rows = session.items.map(it => {
    const adjPrice = Math.round(it.price * factor);
    return [
      date,
      it.name,
      adjPrice,
      session.currency,
      null,
      payerLabel,
      it.assigned.has('putri'),
      it.assigned.has('ayu_a'),
      it.assigned.has('kyne'),
      it.assigned.has('ayu'),
      null,
      '',
      false
    ];
  });

  const endRow = startRow + rows.length - 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Spending Tracker!A${startRow}:M${endRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows }
  });

  lastReceiptRows = [startRow, endRow];
  lastInsertedRow = null;

  let summary = `✅ ${rows.length} item dari struk masuk Sheet!\n\n`;
  summary += '*Total per orang:*\n';
  PEOPLE_KEYS.forEach(k => {
    if (perPerson[k] > 0) {
      summary += `• ${PEOPLE_LABELS[k]}: ${fmtMoney(perPerson[k], session.currency)}\n`;
    }
  });
  summary += `\n💳 Dibayar: ${payerLabel}\n`;
  summary += `🧾 Total: ${fmtMoney(adjustedTotal, session.currency)}\n\n`;
  summary += `_Ketik /undo kalo mau cancel semua._`;

  bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
}

// ===== RECEIPT HANDLERS =====

bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  if (receiptSessions[chatId]) {
    delete receiptSessions[chatId];
    bot.sendMessage(chatId, '❌ Receipt session dibatalkan');
  } else {
    bot.sendMessage(chatId, 'Ga ada session aktif');
  }
});

bot.onText(/\/receipt/, (msg) => {
  const chatId = msg.chat.id;
  receiptSessions[chatId] = {
    step: 'waiting_image',
    items: [],
    discount: 0, tax: 0, service: 0,
    currency: 'IDR',
    payer: null,
    currentItemIdx: 0,
    editMessageId: null,
    awaitingInput: null
  };
  bot.sendMessage(chatId, '📸 Kirim foto struk ya');
});

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const session = receiptSessions[chatId];
  if (!session || session.step !== 'waiting_image') return;

  bot.sendMessage(chatId, '⏳ Lagi baca struk pake AI...');

  try {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const fileLink = await bot.getFileLink(fileId);
    const res = await fetch(fileLink);
    const buf = Buffer.from(await res.arrayBuffer());

    const parsed = await ocrReceipt(buf, 'image/jpeg');

    session.items = (parsed.items || []).map(it => ({
      name: String(it.name || 'Item').trim(),
      price: Number(it.price) || 0,
      assigned: new Set()
    }));
    session.discount = Number(parsed.discount) || 0;
    session.tax = Number(parsed.tax) || 0;
    session.service = Number(parsed.service) || 0;
    session.currency = parsed.currency || 'IDR';
    session.step = 'editing';
    session.editMessageId = null;

    await renderScreen(chatId, session);
  } catch (err) {
    console.error('OCR error:', err);
    delete receiptSessions[chatId]; // bersihin session biar main handler ga ke-block
    bot.sendMessage(chatId, '❌ Gagal baca struk: ' + err.message + '\n\nKetik /receipt buat coba lagi.');
  }
});

// HANDLE TEXT REPLY untuk awaitingInput (edit/add/meta)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const session = receiptSessions[chatId];

  if (!session) return;
  if (!text || text.startsWith('/')) return;
  if (!session.awaitingInput) return;

  const ai = session.awaitingInput;

  try {
    if (ai.type === 'edit_item' || ai.type === 'add_item') {
      const parts = text.split('|').map(s => s.trim());
      if (parts.length !== 2) {
        bot.sendMessage(chatId, '❌ Format salah. Contoh: `Nasi Goreng | 45000`', { parse_mode: 'Markdown' });
        return;
      }
      const name = parts[0];
      const price = parseInt(parts[1].replace(/[^0-9]/g, ''));
      if (!name || isNaN(price)) {
        bot.sendMessage(chatId, '❌ Nama atau harga ga valid');
        return;
      }
      if (ai.type === 'edit_item') {
        session.items[ai.idx].name = name;
        session.items[ai.idx].price = price;
      } else {
        session.items.push({ name, price, assigned: new Set() });
      }
    } else if (ai.type === 'edit_meta') {
      if (ai.field === 'currency') {
        const cur = text.trim().toUpperCase();
        if (!VALID_CURRENCIES.includes(cur)) {
          bot.sendMessage(chatId, `❌ Currency ga valid. Pilih: ${VALID_CURRENCIES.join(', ')}`);
          return;
        }
        session.currency = cur;
      } else {
        const v = parseInt(text.replace(/[^0-9]/g, ''));
        if (isNaN(v)) {
          bot.sendMessage(chatId, '❌ Harus angka');
          return;
        }
        session[ai.field] = v;
      }
    }
    session.awaitingInput = null;
    session.editMessageId = null; // resend biar ke posisi terbaru
    await renderScreen(chatId, session);
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '❌ Error: ' + err.message);
  }
});

bot.on('callback_query', async (cbq) => {
  const chatId = cbq.message.chat.id;
  const data = cbq.data || '';
  if (!data.startsWith('r:')) return;

  const session = receiptSessions[chatId];
  if (!session) {
    bot.answerCallbackQuery(cbq.id, { text: 'Session expired, ketik /receipt lagi' });
    return;
  }

  const parts = data.split(':');
  const action = parts[1];

  try {
    // EDIT screen actions
    if (action === 'edit') {
      const idx = parseInt(parts[2]);
      session.awaitingInput = { type: 'edit_item', idx };
      bot.answerCallbackQuery(cbq.id);
      bot.sendMessage(chatId,
        `✏️ Ketik nama & harga baru utk item ${idx + 1}:\nFormat: \`nama | harga\`\nContoh: \`Nasi Goreng | 45000\``,
        { parse_mode: 'Markdown' });
      return;
    }
    if (action === 'del') {
      session.items.splice(parseInt(parts[2]), 1);
      await renderScreen(chatId, session);
      bot.answerCallbackQuery(cbq.id, { text: 'Item dihapus' });
      return;
    }
    if (action === 'add') {
      session.awaitingInput = { type: 'add_item' };
      bot.answerCallbackQuery(cbq.id);
      bot.sendMessage(chatId,
        `➕ Ketik item baru:\nFormat: \`nama | harga\`\nContoh: \`Es Teh | 8000\``,
        { parse_mode: 'Markdown' });
      return;
    }
    if (action === 'meta') {
      const field = parts[2];
      session.awaitingInput = { type: 'edit_meta', field };
      bot.answerCallbackQuery(cbq.id);
      const labels = {
        discount: 'diskon (angka, contoh: 10000)',
        tax: 'pajak (angka)',
        service: 'service charge (angka)',
        currency: `currency (${VALID_CURRENCIES.join('/')})`
      };
      bot.sendMessage(chatId, `✏️ Ketik nilai ${labels[field]} baru:`);
      return;
    }
    if (action === 'next') {
      if (session.items.length === 0) {
        bot.answerCallbackQuery(cbq.id, { text: 'Belum ada item', show_alert: true });
        return;
      }
      session.step = 'choose_payer';
      session.editMessageId = null;
      await renderScreen(chatId, session);
      bot.answerCallbackQuery(cbq.id);
      return;
    }
    if (action === 'cancel') {
      delete receiptSessions[chatId];
      bot.answerCallbackQuery(cbq.id, { text: 'Dibatalkan' });
      bot.sendMessage(chatId, '❌ Receipt dibatalkan');
      return;
    }

    // PAYER actions
    if (action === 'payer') {
      session.payer = parts[2];
      session.step = 'assigning';
      session.currentItemIdx = 0;
      session.editMessageId = null;
      await renderScreen(chatId, session);
      bot.answerCallbackQuery(cbq.id, { text: `Payer: ${PEOPLE_LABELS[session.payer]}` });
      return;
    }
    if (action === 'back_edit') {
      session.step = 'editing';
      session.editMessageId = null;
      await renderScreen(chatId, session);
      bot.answerCallbackQuery(cbq.id);
      return;
    }

    // ASSIGN actions
    if (action === 'tog') {
      const k = parts[2];
      const item = session.items[session.currentItemIdx];
      if (item.assigned.has(k)) item.assigned.delete(k);
      else item.assigned.add(k);
      await renderScreen(chatId, session);
      bot.answerCallbackQuery(cbq.id);
      return;
    }
    if (action === 'all') {
      const item = session.items[session.currentItemIdx];
      PEOPLE_KEYS.forEach(k => item.assigned.add(k));
      await renderScreen(chatId, session);
      bot.answerCallbackQuery(cbq.id, { text: 'Di-share semua' });
      return;
    }
    if (action === 'clear') {
      session.items[session.currentItemIdx].assigned.clear();
      await renderScreen(chatId, session);
      bot.answerCallbackQuery(cbq.id);
      return;
    }
    if (action === 'prev') {
      if (session.currentItemIdx > 0) session.currentItemIdx--;
      await renderScreen(chatId, session);
      bot.answerCallbackQuery(cbq.id);
      return;
    }
    if (action === 'nextItem') {
      if (session.currentItemIdx < session.items.length - 1) session.currentItemIdx++;
      await renderScreen(chatId, session);
      bot.answerCallbackQuery(cbq.id);
      return;
    }
    if (action === 'doneAssign') {
      const unassigned = session.items.filter(it => it.assigned.size === 0);
      if (unassigned.length > 0) {
        bot.answerCallbackQuery(cbq.id, {
          text: `⚠️ ${unassigned.length} item belum di-assign`,
          show_alert: true
        });
        return;
      }
      session.step = 'confirming';
      session.editMessageId = null;
      await renderScreen(chatId, session);
      bot.answerCallbackQuery(cbq.id);
      return;
    }

    // CONFIRM actions
    if (action === 'back_assign') {
      session.step = 'assigning';
      session.editMessageId = null;
      await renderScreen(chatId, session);
      bot.answerCallbackQuery(cbq.id);
      return;
    }
    if (action === 'save') {
      bot.answerCallbackQuery(cbq.id, { text: 'Saving...' });
      await saveReceiptToSheet(chatId, session);
      delete receiptSessions[chatId];
      return;
    }
  } catch (err) {
    console.error('callback err:', err);
    bot.answerCallbackQuery(cbq.id, { text: 'Error: ' + err.message });
  }
});
