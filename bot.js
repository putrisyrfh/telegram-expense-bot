const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(TOKEN, { polling: true });

// ===== GOOGLE AUTH (BASE64) =====
const credentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString()
);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

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

// mapping dropdown EXACT
function normalizePayer(name) {
  const n = name.toLowerCase();

  if (n.includes('putri')) return 'Putri🐬';
  if (n.includes('kyne')) return 'Kyne🍊';
  if (n.includes('ayu a')) return 'Ayu A🌸';
  if (n.includes('ayu')) return 'Ayu🌿';

  return 'Putri🐬';
}

// convert currency
function convertToIDR(amount, currency) {
  if (currency === 'USD') return Math.round(amount * 15500);
  return amount;
}

// format date (BIAR SAMA KAYAK MANUAL)
function getFormattedDate() {
  return new Date().toLocaleDateString('en-GB');
}

// ===== PARSER (FORMAT LO — KEEP) =====
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

// ===== MAIN =====
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  try {
    const data = parseExpense(text);

    if (data.error) {
      bot.sendMessage(chatId, '❌ ' + data.error);
      return;
    }

    const date = getFormattedDate();
    const amountIDR = convertToIDR(data.amount, data.currency);
    const paidBy = normalizePayer(data.paidBy);

    // split mapping
    const splitPutri = data.splitTo.includes('putri');
    const splitAyuA = data.splitTo.includes('ayu a');
    const splitKyne = data.splitTo.includes('kyne');
    const splitAyu = data.splitTo.includes('ayu');

    // ===== FIX ROW POSITION =====
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Spending Tracker!A:A',
    });

    const nextRow = (res.data.values || []).length + 1;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Spending Tracker!A${nextRow}:M${nextRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          date,
          data.item,
          data.amount,
          data.currency,
          amountIDR,
          paidBy,
          splitPutri,
          splitAyuA,
          splitKyne,
          splitAyu,
          '',
          '',
          false
        ]]
      }
    });

    // ===== RESPONSE (FORMAT LO — KEEP) =====
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

// ===== HELPER =====
function capitalize(str) {
  return str.replace(/\b\w/g, l => l.toUpperCase());
}
