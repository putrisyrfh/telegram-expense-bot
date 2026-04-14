const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(TOKEN, { polling: true });

// ===== GOOGLE AUTH =====
if (!process.env.GOOGLE_CREDENTIALS_BASE64) {
  throw new Error("GOOGLE_CREDENTIALS_BASE64 belum diset");
}

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(
    Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString()
  ),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// ===== START =====
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

// ===== PARSER =====
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

// ===== GET NEXT ROW (FIX UTAMA) =====
async function getNextRow() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Spending Tracker!A:A',
  });

  const rows = res.data.values || [];
  return rows.length + 1;
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

    const nextRow = await getNextRow();

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Spending Tracker!A${nextRow}:K${nextRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          new Date(),
          data.item,
          data.amount,
          data.currency,
          '',
          data.paidBy,
          data.splitTo.includes('putri'),
          data.splitTo.includes('ayu a'),
          data.splitTo.includes('kyne'),
          data.splitTo.includes('ayu'),
          false
        ]]
      }
    });

    bot.sendMessage(chatId,
`✅ Tercatat!

📝 ${data.item}
💰 ${data.amount} ${data.currency}
💳 Dibayar: ${data.paidBy}
👥 Split: ${data.splitTo.join(', ')}`
    );

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '❌ Error: ' + err.message);
  }
});
