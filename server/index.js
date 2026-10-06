const path = require('path');
const express = require('express');
const api = require('./api');
const store = require('./store');

const app = express();
const port = Number(Number(process.env.PORT || 5264));

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', api);

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || '服务端出错了',
      details: err.details || null,
    },
  });
});

app.listen(port, () => {
  let info = '';
  try {
    const data = store.load();
    info = '排污单位 ' + data.plants.length + ' 家、排放口 ' + data.outlets.length + ' 个、设备 ' + data.devices.length + ' 台、监测数据 ' + data.readings.length + ' 条';
  } catch (err) {
    info = '数据文件还没准备好：' + err.message;
  }
  console.log('污染源在线监测与排污总量核算台已启动：http://localhost:' + port + '（' + info + '）');
});
