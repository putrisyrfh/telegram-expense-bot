const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const bot = new TelegramBot(TOKEN, { polling: true });

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const visionModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

async function callVisionWithRetry(parts, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await visionModel.generateContent(parts);
    } catch (err) {
      const msg = err.message || '';
      const transient =
        msg.includes('503') ||
        msg.includes('overload') ||
        msg.includes('Service Unavailable') ||
        msg.includes('429');

      if (!transient || attempt === maxRetries) throw err;

      const waitMs = 2000 * attempt;
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
let lastInsertedRow = null;
let lastReceiptRows = null;

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
    return { error: 'Tambahin "split"' };
  }

  const before = parts[0];
  const after = parts[1];

  const words = before.split(' ');
  const amount = parseFloat(words[words.length - 3]);
  const currency = words[words.length - 2].toUpperCase();
  const paidBy = words[words.length - 1];
  const item = words.slice(0, words.length - 3).join(' ');

  const isOwnSplit =
    after.includes('own') ||
    after.includes('sendiri');

  let splitTo = [];
  let payers = [];

  if (isOwnSplit) {
    payers = after
      .replace('own', '')
      .replace('sendiri', '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);

    splitTo = payers;
  } else {
    if (after === 'all' || after === 'semua') {
      splitTo = ['putri', 'ayu a', 'kyne', 'ayu'];
    } else {
      splitTo = after.split(',').map(x => x.trim());
    }
    payers = [paidBy];
  }

  return { item, amount, currency, paidBy, splitTo, payers, isOwnSplit };
}

function capitalize(str) {
  return str.replace(/\b\w/g, l => l.toUpperCase());
}

async function insertOrUpdateRow(rowNumber, data) {
  const date = getFormattedDate();
  const paidBy = normalizePayer(data.paidBy);

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
        null,
        paidBy,
        data.splitTo.includes('putri'),
        data.splitTo.includes('ayu a'),
        data.splitTo.includes('kyne'),
        data.splitTo.includes('ayu'),
        null,
        '🥘 Food',
        false
      ]]
    }
  });
}

// ===== MAIN INPUT =====
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

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Spending Tracker!A:A',
    });

    if (data.isOwnSplit) {
      let firstRow = null;
      let lastRow = null;

      for (const person of data.payers) {
        const resLoop = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Spending Tracker!A:A',
        });

        const row = (resLoop.data.values || []).length + 1;

        if (!firstRow) firstRow = row;
        lastRow = row;

        await insertOrUpdateRow(row, {
          ...data,
          paidBy: person,
          splitTo: [person]
        });
      }

      lastReceiptRows = [firstRow, lastRow];
      lastInsertedRow = null;

    } else {
      const nextRow = (res.data.values || []).length + 1;
      lastInsertedRow = nextRow;

      await insertOrUpdateRow(nextRow, data);
    }

    const payerText = data.isOwnSplit
      ? data.payers.map(capitalize).join(', ')
      : capitalize(data.paidBy);

    bot.sendMessage(chatId,
`✅ Tercatat!

📝 ${capitalize(data.item)}
💰 ${data.amount} ${data.currency}
💳 Dibayar: ${payerText}
👥 Split: ${data.isOwnSplit
  ? 'Own — ' + data.splitTo.map(capitalize).join(', ')
  : data.splitTo.map(capitalize).join(', ')
}`
    );

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '❌ Error: ' + err.message);
  }
});