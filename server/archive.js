// 归档：按许可年或按月归档；归档前出检查清单，归档后只读，改数必须先解档并全程留痕
const store = require('./store');
const monitor = require('./monitor');
const { AppError } = require('./errors');

const MONTH_RE = /^\d{4}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;
const DAY_MS = 24 * 3600 * 1000;

function pad2(n) { return String(n).padStart(2, '0'); }
function dateText(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
function fmtUTC(ms) {
  const d = new Date(ms);
  return dateText(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
function daysBetween(start, end) {
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / DAY_MS) + 1;
}
function eachDay(start, end) {
  const out = [];
  const total = daysBetween(start, end);
  const base = Date.parse(start + 'T00:00:00Z');
  for (let i = 0; i < total; i += 1) out.push(fmtUTC(base + i * DAY_MS));
  return out;
}
function eachMonth(start, end) {
  const out = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const endY = Number(end.slice(0, 4));
  const endM = Number(end.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(y + '-' + pad2(m));
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// 解析归档时段：按月（YYYY-MM）或按许可年（取设置里许可年起始日的月-日，到下一年起始日前一天）
function periodBounds(scope, value, settings) {
  if (scope === 'month') {
    if (!MONTH_RE.test(String(value || ''))) {
      throw new AppError(400, 'VALIDATION_FAILED', '归档月份要像 2026-09', { period: '月份格式应为 YYYY-MM' });
    }
    const [y, m] = String(value).split('-').map(Number);
    const last = store.daysInMonth(value);
    return { scope, key: value, label: value + '（按月归档）', start: dateText(y, m, 1), end: dateText(y, m, last) };
  }
  if (scope === 'permitYear') {
    if (!YEAR_RE.test(String(value || ''))) {
      throw new AppError(400, 'VALIDATION_FAILED', '许可年要像 2026', { year: '年份格式应为四位数字 YYYY' });
    }
    const year = Number(value);
    const md = String((settings && settings.permitYearStart) || '2026-01-01').slice(5, 10).split('-').map(Number);
    const startMs = Date.UTC(year, (md[0] || 1) - 1, md[1] || 1);
    const endMs = Date.UTC(year + 1, (md[0] || 1) - 1, md[1] || 1) - DAY_MS;
    const start = fmtUTC(startMs);
    const end = fmtUTC(endMs);
    return { scope, key: 'Y' + year, label: year + ' 许可年（' + start + ' 至 ' + end + '）', start, end };
  }
  throw new AppError(400, 'VALIDATION_FAILED', '归档粒度只能是 month（按月）或 permitYear（按许可年）', { scope: '不支持的归档粒度' });
}

function readingsInPeriod(data, start, end) {
  return data.readings.filter((r) => {
    const day = store.dayOf(r.at);
    return day >= start && day <= end;
  });
}

// 在产且排放口运行的对象，才要求数据齐全（停产/停用时段按口径不计入统计）
function activeOutletPairs(data) {
  const out = [];
  for (const outlet of data.outlets) {
    if (outlet.status !== '运行') continue;
    const plant = monitor.plantOf(data, outlet.plantId);
    if (!plant || plant.status !== '生产') continue;
    out.push({ outlet, plant });
  }
  return out;
}

// 检查清单①：该时段数据是否齐全（在产单位的运行排放口，每一天都应有读数）
function checkCompleteness(data, bounds, readings) {
  const pairs = activeOutletPairs(data);
  const days = eachDay(bounds.start, bounds.end);
  const outlets = pairs.map((pair) => {
    const own = readings.filter((r) => r.outletId === pair.outlet.id);
    const daySet = new Set(own.map((r) => store.dayOf(r.at)));
    const missingDates = days.filter((d) => !daySet.has(d));
    return {
      outletId: pair.outlet.id,
      code: pair.outlet.code,
      name: pair.outlet.name,
      plantName: pair.plant.name,
      daysExpected: days.length,
      daysWithData: daySet.size,
      missingDays: missingDates.length,
      missingDatesPreview: missingDates.slice(0, 10),
      missingTruncated: missingDates.length > 10,
    };
  });
  const missingTotal = outlets.reduce((acc, o) => acc + o.missingDays, 0);
  return {
    key: 'dataComplete',
    name: '该时段数据是否齐全',
    pass: pairs.length === 0 ? true : missingTotal === 0,
    readingCount: readings.length,
    outletCount: pairs.length,
    daysExpected: days.length,
    missingDayTotal: missingTotal,
    outlets,
    note: pairs.length === 0 ? '该时段没有在产单位的运行排放口，无需核对齐全性' : '在产单位的运行排放口每天都应有监测读数；停产单位与停用排放口不要求',
  };
}

// 检查清单②：有没有未处理的无效应答（无效标记且没有填写处理说明的，视为未处理）
function checkInvalid(data, bounds, readings) {
  const invalid = readings.filter((r) => r.flag !== '有效');
  const unhandled = invalid.filter((r) => !String(r.remark || '').trim());
  return {
    key: 'invalidHandled',
    name: '无效应答是否都已处理',
    pass: unhandled.length === 0,
    invalidCount: invalid.length,
    unhandledCount: unhandled.length,
    note: '标记为「无效」的小时值必须填写处理说明（备注）才算处理完；未处理的不能归档',
    rows: unhandled.slice(0, 50).map((r) => {
      const outlet = monitor.outletOf(data, r.outletId);
      return { id: r.id, at: r.at, metric: r.metric, outletCode: outlet ? outlet.code : '', value: r.value, remark: r.remark || '' };
    }),
    rowsTruncated: unhandled.length > 50,
  };
}

// 检查清单③：报表是否都已上报（该时段有数据的在产单位，每个月都要有「已上报」报表）
function checkReports(data, bounds, readings) {
  const months = eachMonth(bounds.start, bounds.end);
  const plantIds = new Set();
  for (const r of readings) {
    const outlet = monitor.outletOf(data, r.outletId);
    const plant = outlet ? monitor.plantOf(data, outlet.plantId) : null;
    if (plant && plant.status === '生产') plantIds.add(plant.id);
  }
  const pending = [];
  let reportCount = 0;
  Array.from(plantIds).forEach((plantId) => {
    const plant = monitor.plantOf(data, plantId);
    months.forEach((month) => {
      const report = data.reports.find((rp) => rp.plantId === plantId && rp.period === month);
      if (report) reportCount += 1;
      if (!report || report.status !== '已上报') {
        pending.push({ plantId, plantCode: plant.code, plantName: plant.name, month, status: report ? report.status : '未建报表' });
      }
    });
  });
  return {
    key: 'reportsSubmitted',
    name: '报表是否都已上报',
    pass: pending.length === 0,
    months: months.length,
    plantCount: plantIds.size,
    reportCount,
    pendingCount: pending.length,
    pending,
    note: '该时段有监测数据的在产单位，每个月都要有状态为「已上报」的报表；草稿、退回与未建报表都算未完成',
  };
}

// 生成归档检查清单（不落库）
function buildChecklist(data, bounds) {
  const readings = readingsInPeriod(data, bounds.start, bounds.end);
  const items = [
    checkCompleteness(data, bounds, readings),
    checkInvalid(data, bounds, readings),
    checkReports(data, bounds, readings),
  ];
  const pass = items.every((it) => it.pass);
  return {
    scope: bounds.scope,
    period: bounds.key,
    label: bounds.label,
    start: bounds.start,
    end: bounds.end,
    generatedAt: store.nowText(),
    pass,
    items,
  };
}

// 时段统计快照（归档时定格）
function periodStats(data, bounds, readings) {
  const months = eachMonth(bounds.start, bounds.end);
  const reports = data.reports.filter((rp) => months.includes(String(rp.period)));
  return {
    readingCount: readings.length,
    invalidCount: readings.filter((r) => r.flag !== '有效').length,
    reportCount: reports.length,
    submittedReportCount: reports.filter((rp) => rp.status === '已上报').length,
  };
}

function findOverlap(data, bounds, excludeId) {
  return data.archives.find((a) => a.id !== excludeId && a.start <= bounds.end && bounds.start <= a.end) || null;
}

// 找到某天处于「已归档」状态的归档记录
function activeArchiveAt(data, day) {
  return data.archives.find((a) => a.status === 'archived' && a.start <= day && day <= a.end) || null;
}
function openArchiveAt(data, day) {
  return data.archives.find((a) => a.status === 'unarchived' && a.start <= day && day <= a.end) || null;
}

function archiveBrief(a) {
  return { id: a.id, scope: a.scope, period: a.period, label: a.label, version: a.version, criteriaVersion: a.criteriaVersion };
}

// 只读守卫：已归档时段一律拒绝修改，明确报错，不静默失败
function guardReading(data, reading, nextAt) {
  const day = store.dayOf(nextAt || reading.at);
  const hit = activeArchiveAt(data, day);
  if (hit) {
    throw new AppError(409, 'ARCHIVED_READ_ONLY',
      '该监测数据属于已归档时段「' + hit.label + '」（归档版本 v' + hit.version + '），数据只读，页面与接口都不接受修改。确需修改请先在「归档管理」里申请解档。',
      { archiveId: hit.id, period: hit.label, version: hit.version, lockedDay: day });
  }
  return hit;
}
function guardReport(data, report) {
  const day = String(report.period).slice(0, 7) + '-01';
  const hit = activeArchiveAt(data, day);
  if (hit) {
    throw new AppError(409, 'ARCHIVED_READ_ONLY',
      '这张报表的期间 ' + report.period + ' 已归档（「' + hit.label + '」v' + hit.version + '），报表只读不能改状态或备注。确需修改请先申请解档。',
      { archiveId: hit.id, period: hit.label, version: hit.version, lockedPeriod: report.period });
  }
  return hit;
}

function changedFields(before, after, labels) {
  const parts = [];
  Object.keys(labels).forEach((k) => {
    const nv = after[k];
    const ov = before[k];
    if (String(ov) !== String(nv)) parts.push(labels[k] + '：' + textVal(ov) + ' → ' + textVal(nv));
  });
  return parts;
}
function textVal(v) { return v === undefined || v === null || v === '' ? '空' : String(v); }

// 解档期间的修改留痕
function logReadingChange(data, action, before, after) {
  const day = store.dayOf((after && after.at) || (before && before.at));
  const arc = openArchiveAt(data, day);
  if (!arc) return null;
  let summary;
  const metric = (after && after.metric) || (before && before.metric) || '';
  const at = (after && after.at) || (before && before.at) || '';
  if (action === 'create') {
    summary = '新增 ' + metric + ' ' + at + '，数值 ' + textVal(after.value) + '，' + after.flag + '/' + after.source;
  } else if (action === 'delete') {
    summary = '删除 ' + metric + ' ' + at + '（原数值 ' + textVal(before.value) + '，' + before.flag + '/' + before.source + '）';
  } else {
    const parts = changedFields(before, after, { at: '时刻', value: '数值', flag: '标记', source: '来源', remark: '备注' });
    summary = '修改 ' + metric + ' ' + at + (parts.length ? '：' + parts.join('；') : '（无实际变化）');
  }
  const entry = { at: store.nowText(), by: String((after && after.operator) || ''), action, entity: 'reading', entityId: (after && after.id) || (before && before.id) || '', summary };
  arc.changeLog.push(entry);
  return entry;
}
function logReportChange(data, action, before, after) {
  const day = String((before && before.period) || (after && after.period) || '').slice(0, 7) + '-01';
  const arc = openArchiveAt(data, day);
  if (!arc) return null;
  let summary;
  if (action === 'create') {
    summary = '新建报表 ' + after.period + '，状态 ' + after.status;
  } else {
    const parts = changedFields(before, after, { status: '状态', submittedAt: '上报时刻', submittedBy: '上报人', remark: '备注' });
    summary = '修改报表 ' + before.period + (parts.length ? '：' + parts.join('；') : '（无实际变化）');
  }
  const entry = { at: store.nowText(), by: String((after && (after.submittedBy || after.operator)) || ''), action, entity: 'report', entityId: (after && after.id) || (before && before.id) || '', summary };
  arc.changeLog.push(entry);
  return entry;
}

function requireText(payload, key, label) {
  const v = String((payload || {})[key] || '').trim();
  if (!v) throw new AppError(400, 'VALIDATION_FAILED', label + '不能为空', (function () { const e = {}; e[key] = label + '必填'; return e; })());
  return v;
}

function createArchive(data, payload) {
  const body = payload || {};
  const scope = body.scope === 'permitYear' ? 'permitYear' : (body.scope === 'month' ? 'month' : '');
  if (!scope) throw new AppError(400, 'VALIDATION_FAILED', '归档粒度只能是 month（按月）或 permitYear（按许可年）', { scope: '请选择按月或按许可年' });
  const bounds = periodBounds(scope, scope === 'month' ? body.period : body.year, data.settings);

  const overlap = findOverlap(data, bounds, null);
  if (overlap) {
    if (overlap.status === 'archived') {
      throw new AppError(409, 'ARCHIVE_EXISTS', '时段 ' + bounds.start + ' 至 ' + bounds.end + ' 与已归档时段「' + overlap.label + '」重叠，不能重复归档', { archiveId: overlap.id, overlap: overlap.label });
    }
    throw new AppError(409, 'ARCHIVE_OPEN', '该时段存在已解档记录「' + overlap.label + '」，修改完请走「重新归档」把版本往前推，不能新建归档', { archiveId: overlap.id, overlap: overlap.label });
  }

  const checklist = buildChecklist(data, bounds);
  if (!checklist.pass && body.force !== true) {
    throw new AppError(422, 'ARCHIVE_CHECKLIST_FAILED', '归档检查清单有未通过项，暂不能归档；逐项处理完，或勾选「已知晓并强制归档」后再提交', { checklist });
  }

  const readings = readingsInPeriod(data, bounds.start, bounds.end);
  const now = store.nowText();
  const record = {
    id: store.nextId('ar', data.archives),
    scope: bounds.scope,
    period: bounds.key,
    label: bounds.label,
    start: bounds.start,
    end: bounds.end,
    status: 'archived',
    version: 1,
    createdAt: now,
    createdBy: String(body.by || '').trim(),
    note: String(body.note || '').trim(),
    criteriaVersion: data.criteriaVersion,
    criteriaSnapshot: Object.assign({}, data.settings),
    checklist,
    stats: periodStats(data, bounds, readings),
    versions: [{
      version: 1,
      action: 'archive',
      at: now,
      by: String(body.by || '').trim(),
      note: String(body.note || '').trim(),
      criteriaVersion: data.criteriaVersion,
      forced: !checklist.pass,
      checklistPass: checklist.pass,
    }],
    unarchives: [],
    changeLog: [],
  };
  data.archives.push(record);
  return record;
}

function listArchives(data) {
  return data.archives.slice().sort((a, b) => (a.start < b.start ? 1 : -1)).map((a) => ({
    id: a.id,
    scope: a.scope,
    period: a.period,
    label: a.label,
    start: a.start,
    end: a.end,
    status: a.status,
    version: a.version,
    createdAt: a.createdAt,
    createdBy: a.createdBy,
    note: a.note,
    criteriaVersion: a.criteriaVersion,
    stats: a.stats,
    unarchiveCount: a.unarchives.length,
    changeCount: a.changeLog.length,
    lastUnarchive: a.unarchives.length ? a.unarchives[a.unarchives.length - 1] : null,
  }));
}

function archiveDetail(data, id) {
  const a = data.archives.find((x) => x.id === id);
  if (!a) throw new AppError(404, 'ARCHIVE_NOT_FOUND', '这条归档记录不存在');
  return a;
}

function getArchive(data, id) {
  return archiveDetail(data, id);
}

// 解档：必须写明原因、影响范围、审批人
function unarchiveArchive(data, id, payload) {
  const a = archiveDetail(data, id);
  if (a.status !== 'archived') throw new AppError(409, 'ARCHIVE_ALREADY_OPEN', '「' + a.label + '」当前已是解档状态，不用重复解档');
  const reason = requireText(payload, 'reason', '解档原因');
  const impactScope = requireText(payload, 'impactScope', '影响范围');
  const approver = requireText(payload, 'approver', '审批人');
  const by = String((payload || {}).by || '').trim();
  const now = store.nowText();
  a.status = 'unarchived';
  a.unarchives.push({
    at: now,
    by,
    reason,
    impactScope,
    approver,
    startAt: now,
    endAt: null,
    changeLogFrom: a.changeLog.length,
    changeCount: null,
    rearchiveVersion: null,
  });
  return a;
}

// 重新归档：再次出清单，版本往前推一格，并闭合本次解档窗口
function rearchiveArchive(data, id, payload) {
  const a = archiveDetail(data, id);
  if (a.status !== 'unarchived') throw new AppError(409, 'ARCHIVE_NOT_OPEN', '「' + a.label + '」没有处于解档状态，不能重新归档');
  const body = payload || {};
  const bounds = { scope: a.scope, key: a.period, label: a.label, start: a.start, end: a.end };
  const checklist = buildChecklist(data, bounds);
  if (!checklist.pass && body.force !== true) {
    throw new AppError(422, 'ARCHIVE_CHECKLIST_FAILED', '重新归档检查清单有未通过项；处理完或勾选「已知晓并强制归档」后再提交', { checklist });
  }
  const readings = readingsInPeriod(data, a.start, a.end);
  const now = store.nowText();
  a.version += 1;
  a.status = 'archived';
  a.checklist = checklist;
  a.stats = periodStats(data, bounds, readings);
  a.criteriaVersion = data.criteriaVersion;
  a.criteriaSnapshot = Object.assign({}, data.settings);
  if (body.note !== undefined) a.note = String(body.note).trim();
  const window = a.unarchives[a.unarchives.length - 1];
  if (window) {
    window.endAt = now;
    window.changeCount = a.changeLog.length - window.changeLogFrom;
    window.rearchiveVersion = a.version;
  }
  a.versions.push({
    version: a.version,
    action: 'rearchive',
    at: now,
    by: String(body.by || '').trim(),
    note: String(body.note || '').trim(),
    criteriaVersion: data.criteriaVersion,
    forced: !checklist.pass,
    checklistPass: checklist.pass,
  });
  return a;
}

module.exports = {
  periodBounds, buildChecklist, createArchive, listArchives, getArchive, archiveDetail,
  unarchiveArchive, rearchiveArchive,
  activeArchiveAt, openArchiveAt, archiveBrief,
  guardReading, guardReport, logReadingChange, logReportChange,
  readingsInPeriod, eachMonth,
};
