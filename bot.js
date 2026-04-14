const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(TOKEN, { polling: true });

// ===== GOOGLE SHEETS AUTH (FIX RAILWAY) =====
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// ===== START COMMAND =====
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  const text = `🏔️ Central Asia Expense Bot

Kirim expense ke sini, otomatis masuk Google Sheets!

📝 Format:
[item] [jumlah] [currency] [yg bayar] split [siapa]

✏️ Contoh:
• makan 10 usd putri split all
• taxi 15000 kzt kyne split putri, kyne
• hotel 500000 idr ayu a split semua

💱 Currency: IDR, USD, EUR, KZT, KGS, UZS
👥 Orang: putri, ayu a, kyne, ayu`;

  bot.sendMessage(chatId, text);
});

// ===== PARSER =====
function parseExpense(text) {
  text = text.toLowerCase().trim();

  const parts = text.split(' split ');
  if (parts.length !== 2) {
    return { error: 'Format salah. Contoh: makan 10000 idr putri split all' };
  }

  const before = parts[0];
  const splitPart = parts[1];

  const words = before.split(' ');
  const amount = parseFloat(words[words.length - 3]);
  const currency = words[words.length - 2].toUpperCase();
  const paidBy = words[words.length - 1];

  const item = words.slice(0, words.length - 3).join(' ');

  let splitTo = [];
  if (splitPart === 'all' || splitPart === 'semua') {
    splitTo = ['putri', 'ayu a', 'kyne', 'ayu'];
  } else {
    splitTo = splitPart.split(',').map(x => x.trim());
  }

  return { item, amount, currency, paidBy, splitTo };
}

// ===== MAIN HANDLER =====
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

    // ===== INSERT TO SHEET =====
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Spending Tracker!A3',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          new Date(),
          data.item,
          data.amount,
          data.currency,
          '',
          capitalize(data.paidBy),
          data.splitTo.includes('putri'),
          data.splitTo.includes('ayu a'),
          data.splitTo.includes('kyne'),
          data.splitTo.includes('ayu'),
          false
        ]]
      }
    });

    // ===== RESPONSE =====
    bot.sendMessage(chatId,
`✅ Tercatat!

📝 ${capitalize(data.item)}
💰 ${data.amount} ${data.currency}
💳 Dibayar: ${capitalize(data.paidBy)}
👥 Split: ${data.splitTo.join(', ')}`
    );

  } catch (err) {
    bot.sendMessage(chatId, '❌ Error: ' + err.message);
  }
});

// ===== HELPER =====
function capitalize(str) {
  return str.replace(/\b\w/g, l => l.toUpperCase());
}
