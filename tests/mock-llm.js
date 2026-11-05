'use strict';
// mock-llm.js — 零依赖的 OpenAI 兼容假 LLM 服务, 供测试/本地联调使用。
// 用法:
//   node tests/mock-llm.js            # 在 MOCK_PORT||8899 上启动 (mode=good)
//   const { startMockLLM } = require('./mock-llm');
//   const server = startMockLLM({ port: 0, mode: 'good' }); // 返回正在监听的 http.Server
// 模式:
//   good    (默认) 返回结构合法的分析 JSON; 其中「稳妥版」故意带打包票+明确时间点,
//           用来证明调用方会用 risk.js 复检并把 riskNote 标为未通过。
//           请求里带 image_url / 提到截图/transcript 时返回带 transcript 的视觉版 JSON。
//   badjson 返回 content = 'this is not json', 用来验证调用方回退规则引擎。
// 运行时切换模式: 请求头 x-mock-mode: good|badjson, 或 GET /__mode?m=badjson

const http = require('http');

function makeAnalysis(isVision) {
  const analysis = {
    scenario: 'added_work',
    scenarioName: '被加活/临时加任务',
    relation: '直属领导',
    intent: '确认任务',
    subtext: {
      line: '对方在给你加一件新活, 而且心里已经默认了时间点: 周五下班前。先确认优先级再接, 别默认你手头的事可以让路',
      evidence: '原文依据: 「顺便」',
    },
    risks: [
      { type: 'scope_minimizer', level: 'medium', detail: '对方用“顺便”把工作量说小, 实际整理数据前要先确认口径和范围' },
    ],
    commitment: { task: '把数据整理成表', deadlineText: '周五下班前', needsConfirm: false },
    replies: [
      // 故意写成高风险: 「没问题」+「肯定」+ 明确时间点, 复检必须拦下
      { label: '稳妥版', text: '收到, 没问题, 周五下班前肯定给您, 我这就把数据整理成表。', riskNote: '模型自检: 无风险 (此结论应被确定性复检覆盖)' },
      { label: '不卑不亢版', text: '收到, 我先对齐一下优先级: 这个和我手头正在做的相比哪个更靠前? 确认顺序后我再排期, 排好同步您。', riskNote: '模型自检: 无风险' },
      { label: '推进版', text: '好的, 我先拆两步: 第一步确认数据口径和范围, 第二步整理成表先给您看第一版, 方向对了再补完整版。', riskNote: '模型自检: 无风险' },
    ],
    antiExample: {
      text: '没问题, 包在我身上, 周五前肯定给您',
      reason: '没对齐优先级和范围就打包票, 还钉死了时间点; 做不到时这张截图就是追责证据',
    },
  };
  if (isVision) {
    analysis.transcript = '领导: 顺便把数据整理一下，周五下班前给我\n我: 好的';
  }
  return analysis;
}

function requestIsVision(body) {
  const messages = (body && body.messages) || [];
  for (const msg of messages) {
    const content = msg && msg.content;
    if (typeof content === 'string') {
      if (/截图|transcript/.test(content)) return true;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part) continue;
        if (part.type === 'image_url' || part.image_url) return true;
        if (typeof part.text === 'string' && /截图|transcript/.test(part.text)) return true;
      }
    }
  }
  return false;
}

function sendJSON(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function startMockLLM({ port, mode } = {}) {
  let currentMode = mode || 'good';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/__mode') {
      const m = url.searchParams.get('m');
      if (m) currentMode = m;
      sendJSON(res, 200, { mode: currentMode });
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/chat/completions') {
      sendJSON(res, 404, { error: { message: 'not found' } });
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { body = {}; }
      const effectiveMode = req.headers['x-mock-mode'] || currentMode;
      let content;
      if (effectiveMode === 'badjson') {
        content = 'this is not json';
      } else {
        content = JSON.stringify(makeAnalysis(requestIsVision(body)));
      }
      sendJSON(res, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: (body && body.model) || 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      });
    });
    req.on('error', () => {
      try { sendJSON(res, 400, { error: { message: 'bad request' } }); } catch (_) { /* ignore */ }
    });
  });
  server.listen(typeof port === 'number' ? port : 0);
  // 允许测试里临时切换模式
  server.setMockMode = (m) => { currentMode = m; };
  server.getMockMode = () => currentMode;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.MOCK_PORT) || 8899;
  const server = startMockLLM({ port, mode: process.env.MOCK_MODE || 'good' });
  server.on('listening', () => {
    console.log(`mock-llm listening on http://127.0.0.1:${server.address().port} (mode=${server.getMockMode()})`);
  });
}

module.exports = { startMockLLM, makeAnalysis };
