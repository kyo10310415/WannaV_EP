const axios = require('axios');
const { JWT } = require('google-auth-library');
const { getServiceAccountCredentials } = require('./googleDriveCharacters');
const { todayInJapan: japanDate } = require('./recurringDates');

function previousMonth(now = new Date()) {
  const [year, month] = japanDate(now).split('-').map(Number);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
}

function normalizeMonth(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 2958466) {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000).toISOString().slice(0, 7) + '-01';
  }
  const match = String(value ?? '').trim().match(/^(\d{4})[\/-](\d{1,2})(?:[\/-]\d{1,2})?$/);
  if (!match || +match[2] < 1 || +match[2] > 12) return null;
  return match[1] + '-' + match[2].padStart(2, '0') + '-01';
}

function parsePaymentRows(rows, month) {
  // rows begins at sheet row 13, column A. Monthly columns begin at O (index 14).
  const columns = (rows[0] || []).map((value, index) =>
    index >= 14 && normalizeMonth(value) === month ? index : -1).filter(index => index >= 0);
  if (columns.length !== 1) throw new Error(columns.length ? 'duplicate_month_header' : 'missing_month_header');
  const records = new Map();
  const duplicates = new Set();
  rows.slice(1).forEach((row, index) => {
    const number = String(row[3] ?? '').trim();
    if (!number) return;
    if (records.has(number)) duplicates.add(number);
    const status = String(row[columns[0]] ?? '').trim();
    records.set(number, { student_number: number, payment_status: status,
      is_paid: status === '支払い完了', source_row: index + 14 });
  });
  if (!records.size) throw new Error('empty_payment_sheet');
  for (const number of duplicates) records.delete(number);
  return { records, duplicates };
}

function sourceKey() {
  return JSON.stringify([process.env.GOOGLE_PAYMENT_SPREADSHEET_ID || '',
    process.env.GOOGLE_PAYMENT_SHEET_NAME || 'RAW_支払い状況']);
}

let client;
async function fetchPaymentRows() {
  const id = process.env.GOOGLE_PAYMENT_SPREADSHEET_ID;
  if (!id) throw new Error('payment_spreadsheet_not_configured');
  if (!client) {
    const { clientEmail, privateKey } = getServiceAccountCredentials();
    client = new JWT({ email: clientEmail, key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  }
  const token = await client.getAccessToken();
  const sheet = (process.env.GOOGLE_PAYMENT_SHEET_NAME || 'RAW_支払い状況').replace(/'/g, "''");
  const response = await axios.get(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(id) +
    '/values/' + encodeURIComponent("'" + sheet + "'!A13:ZZ"),
    { headers: { Authorization: 'Bearer ' + (typeof token === 'string' ? token : token.token) },
      params: { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' },
      timeout: 30000 });
  return response.data.values || [];
}

module.exports = { japanDate, previousMonth, normalizeMonth, parsePaymentRows, fetchPaymentRows, sourceKey };
