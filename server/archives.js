// 归档：按许可年或月份封存数据。归档前出检查清单并冻结口径版本；
// 归档后该时段只读；确需修改走解档，修改留痕，再归档版本往前推一格。
const store = require('./store');
const { AppError } = require('./errors');

const MAIN_METRICS = ['COD', '氨氮'];
const CALIBER_KEYS = Object.keys(store.DEFAULT_SETTINGS).filter((k) => k !== 'caliberVersion');

function pad2(n) { return String(n).padStart(2, '0'); }

function validMonth(v) { return /^\d{4}-\d{2}$/.test(String(v || '')); }
function validYear(v) { return /^\d{4}$/.test(String(v || '')); }

function shiftMonth(month, delta) {
  const [y, m] = String(month).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + delta, 1));
  return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1);
}

// 某排污单位某个许可年标签覆盖的自然月（许可年起始日决定边界）
function permitYearMonths(plant, year) {
  const anchor = String(plant.permitYearStart || '2026-01-01').slice(5, 10); // MM-DD
  const startMonth = year + '-' + anchor.slice(0, 2);
  const endMonth = shiftMonth(startMonth, 12); // 不含
  const months = [];
  for (let m = startMonth; m !== endMonth; m = shiftMonth(m, 1)) months.push(m);
  return months;
}

// 归档区间覆盖的月份（许可年按各单位许可年起始日取并集）
function monthsOfScope(data, scopeType, scopeValue) {
  if (scopeType === 'month') {
    if (!validMonth(scopeValue)) throw new AppError(400, 'VALIDATION_FAILED', '月份要像 2026-09', { scopeValue: '月份要像 2026-09' });
    return [String(scopeValue)];
  }
  if (scopeType === 'permitYear') {
    if (!validYear(scopeValue)) throw new AppError(400, 'VALIDATION_FAILED', '许可年要像 2026', { scopeValue: '许可年要像 2026' });
    const months = new Set();
    for (const p of data.plants) permitYearMonths(p, String(scopeValue)).forEach((m) => months.add(m));
    const list = Array.from(months).sort();
    if (!list.length) throw new AppError(400, 'VALIDATION_FAILED', '还没有排污单位，算不出许可年区间', { scopeValue: '先建排污单位再归档许可年' });
    return list;
  }
  throw new AppError(400, 'VALIDATION_FAILED', '归档粒度只能是 month 或 permitYear', { scopeType: '归档粒度只能是 month 或 permitYear' });
}

function scopeLabel(scopeType, scopeValue) {
  return scopeType === 'month' ? String(scopeValue) : String(scopeValue) + ' 许可年';
}

// 找到覆盖某个月的归档（任何状态；正常数据保证一月最多一条）
function archiveForMonth(data, month) {
  return (data.archives || []).find((a) => a.months.indexOf(month) >= 0) || null;
}

// 归档状态徽标用：已归档 / 解档中 / 未归档
function statusForMonth(data, month) {
  const a = archiveForMonth(data, month);
  if (!a) return null;
  return {
    archiveId: a.id,
    archiveLabel: a.label,
    version: a.version,
    archived: a.status === 'archived',
    unsealed: a.status === 'unarchived',
    statusText: a.status === 'archived' ? '已归档 v' + a.version : '解档中 v' + a.version,
  };
}

/* ---------------- 口径版本 ---------------- */

function caliberSnapshot(settings) {
  const out = {};
  for (const key of CALIBER_KEYS) out[key] = settings[key];
  out.caliberVersion = Number(settings.caliberVersion || 1);
  return out;
}

// 算出口径字段差异（设置落库前调用）
function caliberChanges(data, patch) {
  const changes = {};
  for (const key of CALIBER_KEYS) {
    if (patch[key] !== undefined && String(patch[key]) !== String(data.settings[key])) {
      changes[key] = { before: data.settings[key], after: patch[key] };
    }
  }
  return changes;
}

// 设置落库后调用：真有口径字段变化才把口径版本往前推一格并留痕
function commitCaliberChange(data, changes, actor) {
  if (!changes || !Object.keys(changes).length) return { changed: false, version: Number(data.settings.caliberVersion || 1) };
  data.settings.caliberVersion = Number(data.settings.caliberVersion || 1) + 1;
  data.caliberHistory = data.caliberHistory || [];
  data.caliberHistory.push({
    at: store.nowText(),
    by: String(actor || '').trim(),
    version: data.settings.caliberVersion,
    changes,
  });
  return { changed: true, version: data.settings.caliberVersion, changes, after: caliberSnapshot(data.settings) };
}

/* ---------------- 有效性判定（按 README 口径 1） ---------------- */

// 有效性判定（按 README 口径 1）。量程是浓度量程，只对 COD/氨氮这类浓度指标检查；
// 流量（m³/h）、氧含量只看数据标记与设备状态。
function validityOf(data, row) {
  const device = data.devices.find((d) => d.id === row.deviceId);
  const s = data.settings;
  const reasons = [];
  if (row.flag !== '有效') reasons.push('标记为' + row.flag);
  if (!device) reasons.push('设备已不存在');
  else if (device.status !== '正常') reasons.push('设备' + device.status);
  const v = Number(row.value);
  if (!Number.isFinite(v)) reasons.push('数值不是数字');
  else if (MAIN_METRICS.includes(row.metric)) {
    if (v < Number(s.rangeMin)) reasons.push('数值低于量程下限 ' + s.rangeMin);
    if (v > Number(s.rangeMax)) reasons.push('数值高于量程上限 ' + s.rangeMax);
  }
  return { valid: reasons.length === 0, reasons };
}

/* ---------------- 检查清单 ---------------- */

function buildChecklist(data, scopeType, scopeValue) {
  const months = monthsOfScope(data, scopeType, scopeValue);
  const monthSet = new Set(months);
  const generatedAt = store.nowText();

  /* 检查一：该时段数据是否齐全
     口径：生产中单位的运行排放口，对其名下设备涉及的每个指标，
     区间内每个自然日 00–23 时都要有读数（重复时刻只算一次，重复数另计）。 */
  const completenessDetails = [];
  let complete = true;
  for (const plant of data.plants) {
    const plantMonths = scopeType === 'permitYear' ? permitYearMonths(plant, String(scopeValue)) : months;
    if (plant.status !== '生产') continue;
    for (const outlet of data.outlets.filter((o) => o.plantId === plant.id && o.status === '运行')) {
      const metrics = Array.from(new Set(data.devices.filter((d) => d.outletId === outlet.id).map((d) => d.metric)));
      for (const month of plantMonths) {
        if (!monthSet.has(month)) continue;
        const days = store.daysInMonth(month);
        for (const metric of metrics) {
          let missingHours = 0;
          let duplicateHours = 0;
          let shortDays = 0;
          const missingDaySamples = [];
          for (let dayIdx = 1; dayIdx <= days; dayIdx += 1) {
            const day = month + '-' + pad2(dayIdx);
            const rows = data.readings.filter((r) => r.outletId === outlet.id && r.metric === metric && store.dayOf(r.at) === day);
            const hours = new Set();
            rows.forEach((r) => hours.add(String(r.at).slice(11, 13)));
            const miss = 24 - hours.size;
            if (hours.size > 0 && miss > 0) shortDays += 1; // 完全无数据的天不计入「当天缺小时」
            missingHours += miss;
            duplicateHours += rows.length - hours.size;
            if (miss > 0 && missingDaySamples.length < 5) missingDaySamples.push(day + '（缺 ' + miss + ' 时）');
          }
          const presentDays = new Set(data.readings
            .filter((r) => r.outletId === outlet.id && r.metric === metric && monthSet.has(store.monthOf(r.at)) && store.monthOf(r.at) === month)
            .map((r) => store.dayOf(r.at))).size;
          const item = {
            plant: plant.code + ' ' + plant.name,
            outlet: outlet.code + ' ' + outlet.name,
            month, metric,
            expectedDays: days,
            presentDays,
            missingDays: days - presentDays,
            missingHours,
            duplicateHours,
            shortDays,
            missingDaySamples,
          };
          if (presentDays < days || missingHours > 0) {
            complete = false;
            completenessDetails.push(item);
          }
        }
      }
    }
  }

  /* 检查二：有没有未处理的无效应答
     无效应答按口径 1 判定；备注为空视为未处理，写了说明视为已处理。 */
  const scopeReadings = data.readings.filter((r) => monthSet.has(store.monthOf(r.at)));
  const invalidRows = [];
  for (const r of scopeReadings) {
    const v = validityOf(data, r);
    if (!v.valid) invalidRows.push({ reading: r, validity: v });
  }
  const unhandled = invalidRows.filter((x) => !String(x.reading.remark || '').trim());
  const invalidDetail = invalidRows.slice(0, 50).map((x) => ({
    id: x.reading.id,
    at: x.reading.at,
    outletId: x.reading.outletId,
    metric: x.reading.metric,
    value: x.reading.value,
    reasons: x.validity.reasons,
    handled: !!String(x.reading.remark || '').trim(),
    remark: x.reading.remark || '',
  }));

  /* 检查三：报表是否都已上报（每个单位 × 区间内每个月要有一张「已上报」报表） */
  const reportMissing = [];
  for (const plant of data.plants) {
    const plantMonths = scopeType === 'permitYear' ? permitYearMonths(plant, String(scopeValue)) : months;
    for (const month of plantMonths) {
      if (!monthSet.has(month)) continue;
      const rep = data.reports.find((r) => r.plantId === plant.id && String(r.period) === month);
      if (!rep) reportMissing.push({ plant: plant.code + ' ' + plant.name, month, problem: '没有报表' });
      else if (rep.status !== '已上报') reportMissing.push({ plant: plant.code + ' ' + plant.name, month, problem: '报表状态为「' + rep.status + '」', reportId: rep.id });
    }
  }

  const checks = [
    {
      key: 'completeness',
      label: '该时段数据是否齐全',
      passed: complete,
      summary: complete
        ? '区间内所有运行排放口的监测指标逐日 24 小时读数齐全'
        : '有 ' + completenessDetails.length + ' 个「排放口 × 指标 × 月份」存在缺天或缺小时（详见明细）',
      detailCount: completenessDetails.length,
      details: completenessDetails.slice(0, 100),
      truncated: completenessDetails.length > 100,
    },
    {
      key: 'invalidReadings',
      label: '有没有未处理的无效应答',
      passed: unhandled.length === 0,
      summary: '区间内监测数据 ' + scopeReadings.length + ' 条；无效应答 ' + invalidRows.length + ' 条，其中未处理 ' + unhandled.length + ' 条（写了备注视为已处理）',
      scopeReadingCount: scopeReadings.length,
      invalidCount: invalidRows.length,
      unhandledCount: unhandled.length,
      details: invalidDetail,
      truncated: invalidRows.length > 50,
    },
    {
      key: 'reportsSubmitted',
      label: '报表是否都已上报',
      passed: reportMissing.length === 0,
      summary: reportMissing.length === 0
        ? '区间内各单位各月报表均已上报'
        : '有 ' + reportMissing.length + ' 个「单位 × 月份」缺少已上报报表',
      details: reportMissing,
    },
  ];

  return {
    generatedAt,
    scope: { scopeType, scopeValue, label: scopeLabel(scopeType, scopeValue), months },
    checks,
    allPassed: checks.every((c) => c.passed),
  };
}

/* ---------------- 归档 / 解档 / 再归档 ---------------- */

function findArchive(data, id) {
  const a = (data.archives || []).find((x) => x.id === id);
  if (!a) throw new AppError(404, 'ARCHIVE_NOT_FOUND', '这条归档记录不存在');
  return a;
}

function decorateArchive(data, a) {
  const months = new Set(a.months);
  const readingCount = data.readings.filter((r) => months.has(store.monthOf(r.at))).length;
  const reportCount = data.reports.filter((r) => months.has(String(r.period))).length;
  const invalidCount = data.readings.filter((r) => months.has(store.monthOf(r.at)) && !validityOf(data, r).valid).length;
  return Object.assign({}, a, {
    readingCount,
    reportCount,
    invalidCount,
    statusText: a.status === 'archived' ? '已归档' : '解档中',
  });
}

function listArchives(data) {
  return (data.archives || []).slice().sort((x, y) => (x.id < y.id ? 1 : -1)).map((a) => {
    const d = decorateArchive(data, a);
    return {
      id: d.id, label: d.label, scopeType: d.scopeType, scopeValue: d.scopeValue,
      months: d.months, status: d.status, statusText: d.statusText, version: d.version,
      caliberVersion: d.caliberVersion, createdAt: d.createdAt, createdBy: d.createdBy,
      archivedAt: d.archivedAt, readingCount: d.readingCount, reportCount: d.reportCount,
      invalidCount: d.invalidCount, unarchive: d.unarchive || null,
      checklistAllPassed: d.checklist ? d.checklist.allPassed : null,
      eventCount: (d.events || []).length,
    };
  });
}

function archiveDetail(data, id) {
  return decorateArchive(data, findArchive(data, id));
}

function assertNoOverlap(data, months, exceptId) {
  for (const a of data.archives || []) {
    if (exceptId && a.id === exceptId) continue;
    const hit = a.months.filter((m) => months.indexOf(m) >= 0);
    if (hit.length) {
      const text = a.status === 'archived' ? '已归档' : '解档中';
      throw new AppError(409, 'ARCHIVE_SCOPE_OVERLAP',
        '区间与' + a.label + '（' + text + ' v' + a.version + '）重叠，重叠月份：' + hit.join('、'),
        { conflictArchiveId: a.id, conflictLabel: a.label, months: hit });
    }
  }
}

function freezeVersion(data, a, version, checklist, by, at, note) {
  return {
    version,
    at,
    by: String(by || '').trim(),
    note: String(note || ''),
    caliberVersion: Number(data.settings.caliberVersion || 1),
    caliberSnapshot: caliberSnapshot(data.settings),
    checklist,
  };
}

function createArchive(data, payload) {
  const scopeType = payload.scopeType === 'permitYear' ? 'permitYear' : 'month';
  const scopeValue = String(payload.scopeValue || '').trim();
  const months = monthsOfScope(data, scopeType, scopeValue);
  assertNoOverlap(data, months, null);

  const checklist = buildChecklist(data, scopeType, scopeValue);
  checklist.forced = false;
  if (!checklist.allPassed && !payload.force) {
    throw new AppError(409, 'ARCHIVE_CHECKLIST_FAILED',
      '检查清单没全部通过，暂不能归档；处理完问题再来，或勾选「我已知晓，强制归档」',
      { checklist });
  }
  if (!checklist.allPassed) checklist.forced = true;

  const at = store.nowText();
  const by = String(payload.by || '').trim();
  const a = {
    id: store.nextId('ar', data.archives || []),
    scopeType,
    scopeValue,
    label: scopeLabel(scopeType, scopeValue),
    months,
    status: 'archived',
    version: 1,
    createdAt: at,
    createdBy: by,
    archivedAt: at,
    archivedBy: by,
    caliberVersion: Number(data.settings.caliberVersion || 1),
    caliberSnapshot: caliberSnapshot(data.settings),
    checklist,
    versions: [],
    events: [],
    unarchive: null,
  };
  a.versions.push(freezeVersion(data, a, 1, checklist, by, at, checklist.forced ? '清单未全通过，强制归档' : '首次归档'));
  data.archives = data.archives || [];
  data.archives.push(a);
  a.events.push({ at, by, type: 'archive', version: 1, message: '归档封存（口径 v' + a.caliberVersion + '）' + (checklist.forced ? '；清单未全通过，强制归档' : '') });
  return decorateArchive(data, a);
}

function unsealArchive(data, id, payload) {
  const a = findArchive(data, id);
  if (a.status !== 'archived') throw new AppError(409, 'ARCHIVE_NOT_ARCHIVED', a.label + ' 现在是解档中状态，不用再解档');
  const errors = {};
  for (const field of ['reason', 'impactScope', 'approver']) {
    if (!String(payload[field] || '').trim()) errors[field] = '这项必须填写';
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '解档申请有几项没填', errors);
  const at = store.nowText();
  const by = String(payload.by || '').trim();
  a.status = 'unarchived';
  a.unsealedAt = at;
  a.unsealedBy = by;
  a.unarchive = {
    at,
    by,
    reason: String(payload.reason).trim(),
    impactScope: String(payload.impactScope).trim(),
    approver: String(payload.approver).trim(),
    rearchivedAt: '',
    rearchiveBy: '',
  };
  a.events.push({
    at, by, type: 'unseal',
    message: '解档：' + a.unarchive.reason + '；影响范围：' + a.unarchive.impactScope + '；审批人：' + a.unarchive.approver,
  });
  return decorateArchive(data, a);
}

function rearchiveArchive(data, id, payload) {
  const a = findArchive(data, id);
  if (a.status !== 'unarchived') throw new AppError(409, 'ARCHIVE_ALREADY_ARCHIVED', a.label + ' 已是归档状态，不能再归档');
  const checklist = buildChecklist(data, a.scopeType, a.scopeValue);
  checklist.forced = false;
  if (!checklist.allPassed && !payload.force) {
    throw new AppError(409, 'ARCHIVE_CHECKLIST_FAILED',
      '再归档前的检查清单没全部通过；处理完再来，或勾选强制归档',
      { checklist });
  }
  if (!checklist.allPassed) checklist.forced = true;

  const at = store.nowText();
  const by = String(payload.by || '').trim();
  a.version += 1;
  a.status = 'archived';
  a.archivedAt = at;
  a.archivedBy = by;
  a.caliberVersion = Number(data.settings.caliberVersion || 1);
  a.caliberSnapshot = caliberSnapshot(data.settings);
  a.checklist = checklist;
  if (a.unarchive) {
    a.unarchive.rearchivedAt = at;
    a.unarchive.rearchiveBy = by;
  }
  a.versions.push(freezeVersion(data, a, a.version, checklist, by, at,
    '解档修改后再归档' + (checklist.forced ? '；清单未全通过，强制归档' : '')));
  a.events.push({
    at, by, type: 'rearchive', version: a.version,
    message: '修改完成重新归档，版本推进到 v' + a.version + '（口径 v' + a.caliberVersion + '）',
  });
  return decorateArchive(data, a);
}

/* ---------------- 只读守卫与解档期留痕 ---------------- */

function ensureReadingWritable(data, reading) {
  const month = store.monthOf(reading.at);
  const a = archiveForMonth(data, month);
  if (a && a.status === 'archived') {
    throw new AppError(409, 'PERIOD_ARCHIVED',
      month + ' 属于已归档时段「' + a.label + '」（v' + a.version + '），数据只读，不能改；确实要改请先走解档',
      { month, archiveId: a.id, archiveLabel: a.label, version: a.version });
  }
  return a; // 解档中返回归档记录用于留痕，否则 null
}

function ensureReportWritable(data, report) {
  const month = String(report.period).slice(0, 7);
  const a = archiveForMonth(data, month);
  if (a && a.status === 'archived') {
    throw new AppError(409, 'PERIOD_ARCHIVED',
      month + ' 属于已归档时段「' + a.label + '」（v' + a.version + '），报表只读，不能改；确实要改请先走解档',
      { month, archiveId: a.id, archiveLabel: a.label, version: a.version });
  }
  return a;
}

function ensureOutletDeletable(data, outletId) {
  const hit = (data.archives || []).filter((a) => a.status === 'archived' &&
    data.readings.some((r) => r.outletId === outletId && a.months.indexOf(store.monthOf(r.at)) >= 0));
  if (hit.length) {
    throw new AppError(409, 'PERIOD_ARCHIVED',
      '这个排放口在已归档时段（' + hit.map((a) => a.label).join('、') + '）里有监测数据，不能删除',
      { archiveIds: hit.map((a) => a.id) });
  }
}

function ensureDeviceDeletable(data, deviceId) {
  const hit = (data.archives || []).filter((a) => a.status === 'archived' &&
    data.readings.some((r) => r.deviceId === deviceId && a.months.indexOf(store.monthOf(r.at)) >= 0));
  if (hit.length) {
    throw new AppError(409, 'PERIOD_ARCHIVED',
      '这台设备在已归档时段（' + hit.map((a) => a.label).join('、') + '）里有监测数据，不能删除',
      { archiveIds: hit.map((a) => a.id) });
  }
}

function ensurePlantDeletable(data, plantId) {
  const outletIds = new Set(data.outlets.filter((o) => o.plantId === plantId).map((o) => o.id));
  const hit = (data.archives || []).filter((a) => a.status === 'archived' &&
    data.readings.some((r) => outletIds.has(r.outletId) && a.months.indexOf(store.monthOf(r.at)) >= 0));
  if (hit.length) {
    throw new AppError(409, 'PERIOD_ARCHIVED',
      '这家单位在已归档时段（' + hit.map((a) => a.label).join('、') + '）里有监测数据，不能删除',
      { archiveIds: hit.map((a) => a.id) });
  }
}

function diffFields(before, after, fields) {
  const out = {};
  for (const f of fields) {
    if (after[f] !== undefined && String(before[f]) !== String(after[f])) {
      out[f] = { before: before[f], after: after[f] };
    }
  }
  return out;
}

function logReadingEvent(a, type, reading, extra) {
  if (!a || a.status !== 'unarchived') return;
  const titles = { created: '解档期补录监测数据', updated: '解档期修改监测数据', deleted: '解档期删除监测数据' };
  a.events = a.events || [];
  a.events.push(Object.assign({
    at: store.nowText(),
    by: String((reading && reading.operator) || (extra && extra.actor) || '').trim(),
    type: 'reading.' + type,
    readingId: reading ? reading.id : (extra && extra.readingId) || '',
    message: titles[type] + ' ' + (reading ? reading.id : (extra && extra.readingId) || '') +
      '（' + (reading ? reading.at : (extra && extra.at) || '') + '，' + (reading ? reading.metric : (extra && extra.metric) || '') + '）',
  }, extra || {}));
}

function logReportEvent(a, type, report, extra) {
  if (!a || a.status !== 'unarchived') return;
  const titles = { created: '解档期新建报表', updated: '解档期修改报表' };
  a.events = a.events || [];
  a.events.push(Object.assign({
    at: store.nowText(),
    by: String((report && (report.submittedBy || '')) || (extra && extra.actor) || '').trim(),
    type: 'report.' + type,
    reportId: report ? report.id : (extra && extra.reportId) || '',
    message: titles[type] + ' ' + (report ? report.id : '') + '（' + (report ? report.period : '') + '）',
  }, extra || {}));
}

module.exports = {
  monthsOfScope,
  buildChecklist,
  archiveForMonth,
  statusForMonth,
  caliberSnapshot,
  caliberChanges,
  commitCaliberChange,
  listArchives,
  archiveDetail,
  createArchive,
  unsealArchive,
  rearchiveArchive,
  ensureReadingWritable,
  ensureReportWritable,
  ensureOutletDeletable,
  ensureDeviceDeletable,
  ensurePlantDeletable,
  diffFields,
  logReadingEvent,
  logReportEvent,
  CALIBER_KEYS,
};
