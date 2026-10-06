const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULT_SETTINGS = {
  oxygenBaseline: 8,
  rangeMin: 0,
  rangeMax: 500,
  maxImputeHoursPerDay: 6,
  flowWeighted: true,
  hourlyExceedCountLimit: 3,
  codDailyLimit: 100,
  ammoniaDailyLimit: 15,
  annualPermitCodTons: 12,
  annualPermitAmmoniaTons: 1.8,
  permitYearStart: '2026-01-01',
  tonsDivisor: 1000000000,
};

function normalize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  for (const key of ['plants', 'outlets', 'devices', 'readings', 'reports']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  return data;
}

function load() {
  let text;
  try {
    text = fs.readFileSync(dataFile, 'utf8');
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件读不出来，请检查 data/db.json 是否还在');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件解析失败，请检查 data/db.json 的内容');
  }
  return normalize(raw);
}

function save(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
}

function nextId(prefix, list) {
  let max = 0;
  for (const item of list || []) {
    const matched = String(item.id || '').match(/(\d+)$/);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

function round(n, digits) {
  const d = digits == null ? 2 : digits;
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(d));
}

function daysInMonth(month) {
  const [y, m] = String(month).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function daysInQuarter(quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  let total = 0;
  for (const m of [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3]) {
    total += daysInMonth(y + '-' + String(m).padStart(2, '0'));
  }
  return total;
}

function monthOf(at) {
  return String(at).slice(0, 7);
}

function dayOf(at) {
  return String(at).slice(0, 10);
}

function quarterOf(month) {
  const [y, m] = String(month).split('-').map(Number);
  return y + '-Q' + Math.floor((m - 1) / 3 + 1);
}

function nowText() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return now.getUTCFullYear() + '-' + p(now.getUTCMonth() + 1) + '-' + p(now.getUTCDate()) + ' ' + p(now.getUTCHours()) + ':' + p(now.getUTCMinutes()) + ':' + p(now.getUTCSeconds());
}

module.exports = {
  load, save, nextId, normalize, round, daysInMonth, daysInQuarter, monthOf, dayOf, quarterOf, nowText,
  DEFAULT_SETTINGS, dataFile,
};
