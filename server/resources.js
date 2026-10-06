const { AppError } = require('./errors');
const store = require('./store');
const monitor = require('./monitor');

const PLANT_STATUS = ['生产', '停产', '调试'];
const OUTLET_STATUS = ['运行', '停用'];
const OUTLET_TYPE = ['主要排放口', '一般排放口'];
const DEVICE_STATUS = ['正常', '校准', '维护', '故障'];
const METRICS = ['COD', '氨氮', '流量', '氧含量'];
const FLAGS = ['有效', '无效'];
const SOURCES = ['自动', '补录'];
const REPORT_STATUS = ['草稿', '已上报', '退回'];

function decoratePlant(data, plant, month) {
  const outlets = monitor.outletsOf(data, plant.id);
  return Object.assign({}, plant, {
    outletCount: outlets.length,
    deviceCount: data.devices.filter((d) => outlets.some((o) => o.id === d.outletId)).length,
    readingCount: data.readings.filter((r) => outlets.some((o) => o.id === r.outletId)).length,
    reportCount: data.reports.filter((r) => r.plantId === plant.id).length,
    outletList: outlets.map((o) => Object.assign({}, o, {
      deviceCount: data.devices.filter((d) => d.outletId === o.id).length,
      readingCount: data.readings.filter((r) => r.outletId === o.id).length,
    })),
  });
}

function listPlants(data, query) {
  const q = query || {};
  let rows = data.plants.slice();
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((p) => [p.code, p.name, p.industry].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  return rows.map((p) => decoratePlant(data, p)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function plantDetail(data, id) {
  const plant = data.plants.find((p) => p.id === id);
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  const outlets = monitor.outletsOf(data, plant.id);
  return Object.assign({}, decoratePlant(data, plant), {
    outlets: outlets.map((o) => Object.assign({}, o, {
      devices: data.devices.filter((d) => d.outletId === o.id),
      deviceCount: data.devices.filter((d) => d.outletId === o.id).length,
      readingCount: data.readings.filter((r) => r.outletId === o.id).length,
    })),
    reports: data.reports.filter((r) => r.plantId === plant.id).sort((a, b) => (a.period < b.period ? 1 : -1)),
    findings: (data.findings || []).filter((f) => f.plantId === plant.id),
  });
}

function validatePlant(payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!String(merged.name || '').trim()) errors.name = '名称不能为空';
  if (!PLANT_STATUS.includes(merged.status)) errors.status = '状态只能是：' + PLANT_STATUS.join('、');
  if (!String(merged.permitNo || '').trim()) errors.permitNo = '排污许可证号不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createPlant(data, payload) {
  validatePlant(payload, null);
  const plant = {
    id: store.nextId('pt', data.plants),
    code: String(payload.code).trim(),
    name: String(payload.name).trim(),
    industry: String(payload.industry || '').trim(),
    status: payload.status,
    permitNo: String(payload.permitNo).trim(),
    permitYearStart: String(payload.permitYearStart || data.settings.permitYearStart),
    remark: String(payload.remark || ''),
  };
  data.plants.push(plant);
  return decoratePlant(data, plant);
}

function updatePlant(data, id, payload) {
  const plant = data.plants.find((p) => p.id === id);
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  validatePlant(payload, plant);
  const merged = Object.assign({}, plant, payload);
  Object.assign(plant, {
    name: String(merged.name).trim(),
    industry: String(merged.industry || '').trim(),
    status: merged.status,
    permitNo: String(merged.permitNo).trim(),
    permitYearStart: String(merged.permitYearStart || plant.permitYearStart),
    remark: String(merged.remark || ''),
  });
  return decoratePlant(data, plant);
}

function removePlant(data, id) {
  const plant = data.plants.find((p) => p.id === id);
  if (!plant) throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  const outlets = monitor.outletsOf(data, plant.id);
  const used = outlets.length + data.readings.filter((r) => outlets.some((o) => o.id === r.outletId)).length;
  if (used > 0) throw new AppError(409, 'PLANT_IN_USE', '名下还有排放口与监测数据，不能删除', { count: used });
  data.plants = data.plants.filter((p) => p.id !== id);
  return { removed: id };
}

function listOutlets(data, query) {
  const q = query || {};
  let rows = data.outlets.slice();
  if (q.plantId) rows = rows.filter((o) => o.plantId === q.plantId);
  if (q.status) rows = rows.filter((o) => o.status === q.status);
  return rows.map((o) => {
    const plant = monitor.plantOf(data, o.plantId);
    return Object.assign({}, o, {
      plantCode: plant ? plant.code : '',
      plantName: plant ? plant.name : '',
      deviceCount: data.devices.filter((d) => d.outletId === o.id).length,
      readingCount: data.readings.filter((r) => r.outletId === o.id).length,
    });
  }).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateOutlet(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!data.plants.some((p) => p.id === merged.plantId)) errors.plantId = '排污单位不存在';
  if (!OUTLET_TYPE.includes(merged.type)) errors.type = '类型只能是：' + OUTLET_TYPE.join('、');
  if (!OUTLET_STATUS.includes(merged.status)) errors.status = '状态只能是：' + OUTLET_STATUS.join('、');
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createOutlet(data, payload) {
  validateOutlet(data, payload, null);
  const outlet = {
    id: store.nextId('ol', data.outlets),
    code: String(payload.code).trim(),
    name: String(payload.name || '').trim(),
    plantId: payload.plantId,
    type: payload.type,
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.outlets.push(outlet);
  return outlet;
}

function updateOutlet(data, id, payload) {
  const outlet = data.outlets.find((o) => o.id === id);
  if (!outlet) throw new AppError(404, 'OUTLET_NOT_FOUND', '这个排放口不存在');
  validateOutlet(data, payload, outlet);
  const merged = Object.assign({}, outlet, payload);
  Object.assign(outlet, {
    name: String(merged.name || '').trim(),
    plantId: merged.plantId,
    type: merged.type,
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return outlet;
}

function removeOutlet(data, id) {
  const outlet = data.outlets.find((o) => o.id === id);
  if (!outlet) throw new AppError(404, 'OUTLET_NOT_FOUND', '这个排放口不存在');
  const used = data.readings.filter((r) => r.outletId === id).length;
  if (used > 0) throw new AppError(409, 'OUTLET_IN_USE', '这个排放口名下还有 ' + used + ' 条监测数据，不能删除', { count: used });
  data.devices = data.devices.filter((d) => d.outletId !== id);
  data.outlets = data.outlets.filter((o) => o.id !== id);
  return { removed: id };
}

function listDevices(data, query) {
  const q = query || {};
  let rows = data.devices.slice();
  if (q.outletId) rows = rows.filter((d) => d.outletId === q.outletId);
  if (q.metric) rows = rows.filter((d) => d.metric === q.metric);
  if (q.status) rows = rows.filter((d) => d.status === q.status);
  return rows.map((d) => {
    const outlet = monitor.outletOf(data, d.outletId);
    return Object.assign({}, d, {
      outletCode: outlet ? outlet.code : '',
      readingCount: data.readings.filter((r) => r.deviceId === d.id).length,
      invalidCount: data.readings.filter((r) => r.deviceId === d.id && r.flag !== '有效').length,
    });
  }).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateDevice(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编号不能为空';
  if (!data.outlets.some((o) => o.id === merged.outletId)) errors.outletId = '排放口不存在';
  if (!METRICS.includes(merged.metric)) errors.metric = '监测指标只能是：' + METRICS.join('、');
  if (!DEVICE_STATUS.includes(merged.status)) errors.status = '设备状态只能是：' + DEVICE_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.calibratedUntil || ''))) errors.calibratedUntil = '校准有效期要像 2026-12-31';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createDevice(data, payload) {
  validateDevice(data, payload, null);
  const device = {
    id: store.nextId('dv', data.devices),
    code: String(payload.code).trim(),
    outletId: payload.outletId,
    metric: payload.metric,
    model: String(payload.model || '').trim(),
    status: payload.status,
    calibratedUntil: String(payload.calibratedUntil),
    remark: String(payload.remark || ''),
  };
  data.devices.push(device);
  return device;
}

function updateDevice(data, id, payload) {
  const device = data.devices.find((d) => d.id === id);
  if (!device) throw new AppError(404, 'DEVICE_NOT_FOUND', '这个监测设备不存在');
  validateDevice(data, payload, device);
  const merged = Object.assign({}, device, payload);
  Object.assign(device, {
    outletId: merged.outletId,
    metric: merged.metric,
    model: String(merged.model || '').trim(),
    status: merged.status,
    calibratedUntil: String(merged.calibratedUntil),
    remark: String(merged.remark || ''),
  });
  return device;
}

function removeDevice(data, id) {
  const device = data.devices.find((d) => d.id === id);
  if (!device) throw new AppError(404, 'DEVICE_NOT_FOUND', '这个监测设备不存在');
  const used = data.readings.filter((r) => r.deviceId === id).length;
  if (used > 0) throw new AppError(409, 'DEVICE_IN_USE', '这台设备名下还有 ' + used + ' 条监测数据，不能删除', { count: used });
  data.devices = data.devices.filter((d) => d.id !== id);
  return { removed: id };
}

function listReadings(data, query) {
  const q = query || {};
  const rows = monitor.readingsOf(data, q);
  const limit = Number(q.limit) > 0 ? Number(q.limit) : 500;
  return {
    total: rows.length,
    returned: Math.min(rows.length, limit),
    rows: rows.slice(0, limit).map((r) => decorateReading(data, r)),
  };
}

function decorateReading(data, row) {
  const device = monitor.deviceOf(data, row.deviceId);
  const outlet = monitor.outletOf(data, row.outletId);
  return Object.assign({}, row, {
    deviceCode: device ? device.code : '',
    deviceStatus: device ? device.status : '',
    outletCode: outlet ? outlet.code : '',
    counted: monitor.isCounted(row, device, data.settings),
    concentration: monitor.effectiveConcentration(row, data.settings),
    oxygen: monitor.oxygenAt(data, row),
    flow: monitor.flowAt(data, row),
  });
}

function validateReading(data, payload) {
  const errors = {};
  if (!data.outlets.some((o) => o.id === payload.outletId)) errors.outletId = '排放口不存在';
  if (!data.devices.some((d) => d.id === payload.deviceId)) errors.deviceId = '监测设备不存在';
  if (!METRICS.includes(payload.metric)) errors.metric = '监测指标只能是：' + METRICS.join('、');
  if (!FLAGS.includes(payload.flag)) errors.flag = '数据标记只能是：' + FLAGS.join('、');
  if (!SOURCES.includes(payload.source)) errors.source = '来源只能是：' + SOURCES.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/.test(String(payload.at || ''))) errors.at = '时刻要像 2026-09-01 08:00:00';
  if (payload.value === undefined || payload.value === '') errors.value = '数值不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条监测数据没通过校验', errors);
}

function createReading(data, payload) {
  validateReading(data, payload);
  const reading = {
    id: store.nextId('rd', data.readings),
    outletId: payload.outletId,
    deviceId: payload.deviceId,
    metric: payload.metric,
    at: String(payload.at),
    value: Number(payload.value),
    flag: payload.flag,
    source: payload.source,
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.readings.push(reading);
  return decorateReading(data, reading);
}

function updateReading(data, id, payload) {
  const reading = data.readings.find((r) => r.id === id);
  if (!reading) throw new AppError(404, 'READING_NOT_FOUND', '这条监测数据不存在');
  validateReading(data, Object.assign({}, reading, payload));
  Object.assign(reading, {
    at: String(payload.at || reading.at),
    value: payload.value === undefined ? reading.value : Number(payload.value),
    flag: payload.flag || reading.flag,
    source: payload.source || reading.source,
    remark: payload.remark === undefined ? reading.remark : String(payload.remark),
  });
  return decorateReading(data, reading);
}

function removeReading(data, id) {
  const reading = data.readings.find((r) => r.id === id);
  if (!reading) throw new AppError(404, 'READING_NOT_FOUND', '这条监测数据不存在');
  data.readings = data.readings.filter((r) => r.id !== id);
  return { removed: id };
}

function listReports(data, query) {
  const q = query || {};
  let rows = data.reports.slice();
  if (q.plantId) rows = rows.filter((r) => r.plantId === q.plantId);
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  return rows.map((r) => {
    const plant = monitor.plantOf(data, r.plantId);
    return Object.assign({}, r, { plantCode: plant ? plant.code : '', plantName: plant ? plant.name : '' });
  }).sort((a, b) => (a.period < b.period ? 1 : -1));
}

function reportDetail(data, id) {
  const report = data.reports.find((r) => r.id === id);
  if (!report) throw new AppError(404, 'REPORT_NOT_FOUND', '这张报表不存在');
  const plant = monitor.plantOf(data, report.plantId);
  const month = String(report.period).slice(0, 7);
  const outlets = monitor.outletsOf(data, report.plantId).map((o) => monitor.outletSummary(data, o.id, month));
  return Object.assign({}, report, { plant, month, outlets });
}

function createReport(data, payload) {
  const errors = {};
  if (!data.plants.some((p) => p.id === payload.plantId)) errors.plantId = '排污单位不存在';
  if (!/^\d{4}-\d{2}$/.test(String(payload.period || ''))) errors.period = '期间要像 2026-09';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这张报表没通过校验', errors);
  const report = {
    id: store.nextId('rp', data.reports),
    plantId: payload.plantId,
    period: String(payload.period),
    status: payload.status || '草稿',
    submittedAt: payload.submittedAt || '',
    submittedBy: String(payload.submittedBy || ''),
    remark: String(payload.remark || ''),
  };
  data.reports.push(report);
  return report;
}

function updateReport(data, id, payload) {
  const report = data.reports.find((r) => r.id === id);
  if (!report) throw new AppError(404, 'REPORT_NOT_FOUND', '这张报表不存在');
  if (payload.status && !REPORT_STATUS.includes(payload.status)) {
    throw new AppError(400, 'VALIDATION_FAILED', '状态只能是：' + REPORT_STATUS.join('、'), { status: '状态取值不对' });
  }
  if (payload.status) report.status = payload.status;
  if (payload.submittedAt !== undefined) report.submittedAt = String(payload.submittedAt);
  if (payload.submittedBy !== undefined) report.submittedBy = String(payload.submittedBy);
  if (payload.remark !== undefined) report.remark = String(payload.remark);
  return report;
}

module.exports = {
  listPlants, plantDetail, createPlant, updatePlant, removePlant,
  listOutlets, createOutlet, updateOutlet, removeOutlet,
  listDevices, createDevice, updateDevice, removeDevice,
  listReadings, createReading, updateReading, removeReading, decorateReading,
  listReports, reportDetail, createReport, updateReport,
  PLANT_STATUS, OUTLET_STATUS, OUTLET_TYPE, DEVICE_STATUS, METRICS, FLAGS, SOURCES, REPORT_STATUS,
};
