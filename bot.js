const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const TOKEN = process.env.TELEGRAM_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const bot = new TelegramBot(TOKEN, { polling: true });

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
bot.onText(/\/undo/, async (msg) => {
  const chatId = msg.chat.id;

  if (!lastInsertedRow) {
    bot.sendMessage(chatId, '❌ Belum ada data buat di-undo');
    return;
  }

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Spending Tracker!A${lastInsertedRow}:M${lastInsertedRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          '',  // date
          '',  // item
          '',  // price
          '',  // currency

          null, // amount IDR (biar formula balik)

          '',  // paid by

          false, // putri
          false, // ayu a
          false, // kyne
          false, // ayu

          null, // amount per person (formula balik)
          '',   // category
          false // settled
        ]]
      }
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

// ===== RECEIPT MODE (ADD-ON) =====
const Tesseract = require('tesseract.js');

let receiptSessions = {};

// START RECEIPT
bot.onText(/\/receipt/, (msg) => {
  const chatId = msg.chat.id;

  receiptSessions[chatId] = {
    step: 'waiting_image',
    items: [],
    assignments: {}
  };

  bot.sendMessage(chatId, '📸 Kirim foto struk ya');
});


// HANDLE IMAGE
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;

  if (!receiptSessions[chatId]) return;

  const fileId = msg.photo[msg.photo.length - 1].file_id;

  const fileLink = await bot.getFileLink(fileId);

  bot.sendMessage(chatId, '⏳ Lagi baca struk...');

  try {
    const result = await Tesseract.recognize(fileLink, 'eng');
    const text = result.data.text;

    // PARSE SIMPLE (ITEM + PRICE)
    const lines = text.split('\n').filter(l => l.trim());

    const items = [];

    lines.forEach(line => {
      const match = line.match(/(.+)\s+(\d+[.,]?\d*)$/);
      if (match) {
        items.push({
          name: match[1].trim(),
          price: parseInt(match[2].replace(/[^0-9]/g, ''))
        });
      }
    });

    receiptSessions[chatId].items = items;

    let reply = '🧾 Gue baca ini (cek ya):\n\n';

    items.forEach((item, i) => {
      reply += `${i + 1}. ${item.name} - ${item.price}\n`;
    });

    reply += `
    
Reply:
edit 1 nasi goreng 30000
delete 2
1 putri
done
`;

    receiptSessions[chatId].step = 'editing';

    bot.sendMessage(chatId, reply);

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '❌ Gagal baca struk');
  }
});


// HANDLE RECEIPT TEXT COMMAND
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!receiptSessions[chatId]) return;
  if (!text || text.startsWith('/')) return;

  const session = receiptSessions[chatId];

  // EDIT
  if (text.startsWith('edit')) {
    const parts = text.split(' ');
    const index = parseInt(parts[1]) - 1;

    const newName = parts.slice(2, -1).join(' ');
    const newPrice = parseInt(parts[parts.length - 1]);

    if (session.items[index]) {
      session.items[index] = { name: newName, price: newPrice };
      bot.sendMessage(chatId, `✏️ Item ${index + 1} diupdate`);
    }

    return;
  }

  // DELETE
  if (text.startsWith('delete')) {
    const index = parseInt(text.split(' ')[1]) - 1;

    session.items.splice(index, 1);

    bot.sendMessage(chatId, '🗑️ Item dihapus');
    return;
  }

  // DONE → INSERT TO SHEET
  if (text === 'done') {
    const date = getFormattedDate();

    for (let i = 0; i < session.items.length; i++) {
      const item = session.items[i];
      const assigned = session.assignments[i] || ['putri'];

      const splitPutri = assigned.includes('putri');
      const splitAyuA = assigned.includes('ayu a');
      const splitKyne = assigned.includes('kyne');
      const splitAyu = assigned.includes('ayu');

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
            item.name,
            item.price,
            'IDR',
            '',
            normalizePayer('putri'),
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
    }

    bot.sendMessage(chatId, '✅ Semua item berhasil masuk!');

    delete receiptSessions[chatId];
    return;
  }

  // ASSIGN (ex: "1 putri")
  const match = text.match(/^(\d+)\s+(.+)/);
  if (match) {
    const index = parseInt(match[1]) - 1;
    const people = match[2].split(',').map(x => x.trim());

    session.assignments[index] = people;

    bot.sendMessage(chatId, `👥 Item ${index + 1} di-assign`);
    return;
  }
});
