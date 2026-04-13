const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

// ================= CONFIG =================
const token = '8684209053:AAGsLOS5KOln17RPIluzEXrMT2chLYbyy7U';
const SHEET_ID = '1OVob-6KYBxFXmGgxuiG4bF9lt-SXcNDHVDkdUmrBbik';

// ================= GOOGLE AUTH =================
const auth = new google.auth.GoogleAuth({
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
}); 
 scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// ================= BOT =================
const bot = new TelegramBot(token, { polling: true });

// ================= HELPER =================
function capitalize(str) {
  return str.replace(/\b\w/g, l => l.toUpperCase());
}

// ================= START COMMAND =================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  const message = `🏔️ Central Asia Expense Bot

Kirim expense ke sini, otomatis masuk Google Sheets!

📝 Format:
[item] [jumlah] [currency] [yg bayar] split [siapa]

✏️ Contoh:
• makan 10 usd putri split all
• taxi 15000 kzt kyne split putri, kyne
• hotel 500000 idr ayu a split semua

💱 Currency: IDR, USD, EUR, KZT, KGS, UZS
👥 Orang: putri, ayu a, kyne, ayu`;

  bot.sendMessage(chatId, message);
});

// ================= PARSER =================
function parseExpense(text) {
  text = text.toLowerCase().trim();

  const parts = text.split(' split ');
  if (parts.length !== 2) {
    return { error: 'Format salah. Contoh: makan 100000 idr putri split all' };
  }

  const before = parts[0].trim();
  const after = parts[1].trim();

  const tokens = before.split(' ');
  const currencies = ['idr', 'usd', 'eur', 'kzt', 'kgs', 'uzs'];

  const currency = tokens.find(t => currencies.includes(t));
  if (!currency) return { error: 'Currency ga ketemu' };

  const currencyIndex = tokens.indexOf(currency);

  const amount = parseFloat(tokens[currencyIndex - 1].replace(/,/g, ''));
  if (!amount) return { error: 'Amount ga valid' };

  // handle nama (termasuk "ayu a")
  let paidByRaw = tokens.slice(currencyIndex + 1).join(' ');
  const validNames = ['putri', 'ayu a', 'kyne', 'ayu'];

  const paidBy = validNames.find(name => paidByRaw.includes(name));
  if (!paidBy) return { error: 'Nama yg bayar ga valid' };

  const item = tokens.slice(0, currencyIndex - 1).join(' ');

  let splitTo = [];
  if (after === 'all' || after === 'semua') {
    splitTo = validNames;
  } else {
    splitTo = after.split(',').map(s => s.trim());
  }

  return {
    item,
    amount,
    currency: currency.toUpperCase(),
    paidBy,
    splitTo
  };
}

// ================= NAME MAP =================
async function getNameMap(authClient) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Config!E2:E5',
    auth: authClient
  });

  const names = res.data.values.flat();

  return {
    'putri': names[0],
    'ayu a': names[1],
    'kyne': names[2],
    'ayu': names[3],
  };
}

// ================= SAVE TO SHEET =================
async function saveToSheet(data) {
  const client = await auth.getClient();
  const nameMap = await getNameMap(client);

  // cari row kosong
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Spending Tracker!A3:A1000',
    auth: client
  });

  const rows = res.data.values || [];

  let newRow = 3;
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i] || !rows[i][0]) {
      newRow = i + 3;
      break;
    }
    newRow = i + 4;
  }

  // A-D
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Spending Tracker!A${newRow}:D${newRow}`,
    valueInputOption: 'USER_ENTERED',
    auth: client,
    requestBody: {
      values: [[
        new Date().toLocaleDateString(),
        capitalize(data.item),
        data.amount,
        data.currency
      ]]
    }
  });

  // Paid by (dropdown valid)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Spending Tracker!F${newRow}`,
    valueInputOption: 'USER_ENTERED',
    auth: client,
    requestBody: {
      values: [[nameMap[data.paidBy]]]
    }
  });

  // checkbox
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Spending Tracker!G${newRow}:J${newRow}`,
    valueInputOption: 'USER_ENTERED',
    auth: client,
    requestBody: {
      values: [[
        data.splitTo.includes('putri'),
        data.splitTo.includes('ayu a'),
        data.splitTo.includes('kyne'),
        data.splitTo.includes('ayu')
      ]]
    }
  });

  // settled
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Spending Tracker!M${newRow}`,
    valueInputOption: 'USER_ENTERED',
    auth: client,
    requestBody: {
      values: [[false]]
    }
  });

  return nameMap;
}

// ================= HANDLE MESSAGE =================
bot.on('message', async (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text;

  // skip command biar ga double trigger
  if (text.startsWith('/')) return;

  try {
    const parsed = parseExpense(text);

    if (parsed.error) {
      bot.sendMessage(chatId, '❌ ' + parsed.error);
      return;
    }

    const nameMap = await saveToSheet(parsed);

    const message = `✅ Tercatat!

📝 ${capitalize(parsed.item)}
💰 ${parsed.amount} ${parsed.currency}
💳 Dibayar: ${nameMap[parsed.paidBy]}
👥 Split: ${parsed.splitTo.join(', ')}`;

    bot.sendMessage(chatId, message);

  } catch (err) {
    console.log(err);
    bot.sendMessage(chatId, '❌ Error: ' + err.message);
  }
});
