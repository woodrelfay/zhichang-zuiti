'use strict';
// llm.js — 托管版大模型接入 (OpenAI 兼容 /chat/completions)
// 无配置 / 任何调用失败 -> 回退规则引擎 (source='rules', 带 llmError), 文本路径永不抛错。
// 关键差异化: 大模型返回的每条回复都必须再过一遍 risk.js 的确定性风险校验,
// 校验结果覆盖 LLM 自带的 riskNote —— 模型说"安全"不算数, 规则说了算。

const fs = require('fs');
const path = require('path');
const { analyze, RELATIONS, INTENTS, SCENARIO_NAMES } = require('./analyze');
const risk = require('./risk');

const TIMEOUT_MS = Number(process.env.ZUITI_LLM_TIMEOUT_MS) > 0 ? Number(process.env.ZUITI_LLM_TIMEOUT_MS) : 60000;

const FALLBACK_SYSTEM_PROMPT = [
  '你是一名专为中国 22-28 岁初入职场年轻人服务的「职场沟通风险顾问」。',
  '你的工作不是生成"高情商话术", 而是按固定顺序处理一条工作消息:',
  '1. 潜台词翻译: 用一句话说清对方真正想确认什么, 并引用原文关键词作为依据, 不许臆测原文没有的信息。',
  '2. 风险标注: 标注没有明确截止时间、把工作量说小、模糊授权、拿同事对比施压等陷阱, 逐条给出踩了会怎样。',
  '3. 承诺抽取: 输出 task 与 deadlineText (原文时间表达, 没有就填 null); deadlineText 为 null 时 needsConfirm 必须为 true。',
  '4. 三版回复: 固定标签「稳妥版 / 不卑不亢版 / 推进版」, 不许打包票、不许过度道歉、不许谄媚与顶撞、不许只回"收到/好的"。',
  '5. 反面教材: 给一条「千万别这样回」的示例并说明它具体坏在哪一条。',
  '场景只允许: criticism | added_work | chasing | bad_news | after_hours | confirm_task。',
  '只输出严格 JSON, 不要输出 JSON 之外的文字。输出结构: {scenario, scenarioName, subtext:{line,evidence}, risks:[{type,level,detail}], commitment:{task,deadlineText,needsConfirm}, replies:[{label,text,riskNote} x3], antiExample:{text,reason}}。',
].join('\n');

function loadSystemPrompt() {
  try {
    const file = path.join(__dirname, '..', 'prompts', 'system.md');
    const md = fs.readFileSync(file, 'utf8');
    const m = md.match(/##\s*System Prompt\s*\n([\s\S]*?)(?:\n##\s|\n#\s|$)/);
    if (m && m[1] && m[1].trim().length > 20) {
      // 系统提示词正文 + 输出结构提醒 (schema 段落不在 System Prompt 小节内, 这里补齐)
      return m[1].trim() + '\n\n输出 (严格 JSON, 不要输出 JSON 之外的文字): '
        + '{"scenario":"criticism | added_work | chasing | bad_news | after_hours | confirm_task",'
        + '"scenarioName":"中文场景名",'
        + '"subtext":{"line":"一句话潜台词","evidence":"原文依据"},'
        + '"risks":[{"type":"string","level":"high | medium","detail":"风险说明"}],'
        + '"commitment":{"task":"任务本体或 null","deadlineText":"时间表达或 null","needsConfirm":true},'
        + '"replies":[{"label":"稳妥版","text":"...","riskNote":"自检结论"},'
        + '{"label":"不卑不亢版","text":"...","riskNote":"自检结论"},'
        + '{"label":"推进版","text":"...","riskNote":"自检结论"}],'
        + '"antiExample":{"text":"千万别这样回的示例","reason":"坏在哪"}}';
    }
  } catch (_) {
    // 读不到文件就用内置兜底提示词
  }
  return FALLBACK_SYSTEM_PROMPT;
}

function getConfig() {
  const baseUrlRaw = (process.env.ZUITI_LLM_BASE_URL || 'https://api.openai.com/v1').trim();
  const baseUrl = baseUrlRaw.replace(/\/+$/, '');
  const apiKey = (process.env.ZUITI_LLM_API_KEY || '').trim();
  const model = (process.env.ZUITI_LLM_MODEL || '').trim();
  const visionModel = (process.env.ZUITI_VISION_MODEL || '').trim() || model;
  return {
    baseUrl,
    apiKey,
    model,
    visionModel,
    configured: !!(baseUrl && apiKey && model),
  };
}

function shortReason(e) {
  let msg = '';
  if (!e) msg = 'unknown error';
  else if (typeof e === 'string') msg = e;
  else msg = e.message || String(e);
  msg = String(msg).replace(/\s+/g, ' ').trim();
  return msg.length > 200 ? msg.slice(0, 200) : msg;
}

function validateAnalysis(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('LLM response schema invalid: not an object');
  }
  if (typeof obj.scenario !== 'string' || !obj.scenario) {
    throw new Error('LLM response schema invalid: scenario must be a string');
  }
  if (!obj.subtext || typeof obj.subtext.line !== 'string' || !obj.subtext.line) {
    throw new Error('LLM response schema invalid: subtext.line must be a string');
  }
  if (!Array.isArray(obj.risks)) {
    throw new Error('LLM response schema invalid: risks must be an array');
  }
  if (!obj.commitment || typeof obj.commitment !== 'object' || Array.isArray(obj.commitment)) {
    throw new Error('LLM response schema invalid: commitment must be an object');
  }
  if (!Array.isArray(obj.replies) || obj.replies.length !== 3) {
    throw new Error('LLM response schema invalid: replies must be an array of length 3');
  }
  for (const rep of obj.replies) {
    if (!rep || typeof rep.label !== 'string' || !rep.label || typeof rep.text !== 'string' || !rep.text) {
      throw new Error('LLM response schema invalid: each reply needs label and text strings');
    }
  }
  if (!obj.antiExample || typeof obj.antiExample.text !== 'string' || !obj.antiExample.text) {
    throw new Error('LLM response schema invalid: antiExample.text must be a string');
  }
  return obj;
}

function parseContentJSON(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('LLM returned empty content');
  }
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // 容忍 ```json 代码块 / 前后杂文字: 截取首尾大括号再试一次
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch (_) { /* fall through */ }
    }
    throw new Error('LLM returned invalid JSON');
  }
}

// 用确定性风险校验覆盖每条回复的 riskNote, 并补齐 relation/intent 等字段
function finalizeLLMResult(obj, input) {
  const result = { ...obj };
  if (typeof result.scenarioName !== 'string' || !result.scenarioName) {
    result.scenarioName = (SCENARIO_NAMES && SCENARIO_NAMES[result.scenario]) || result.scenario;
  }
  if (!result.subtext || typeof result.subtext !== 'object') result.subtext = { line: '', evidence: '' };
  if (typeof result.subtext.evidence !== 'string') result.subtext.evidence = '';
  // relation / intent: LLM 省略时用输入值 (再不行用规则引擎的默认值口径)
  const fallbackRelation = input && RELATIONS.includes(input.relation) ? input.relation : '直属领导';
  const fallbackIntent = input && INTENTS.includes(input.intent) ? input.intent : '确认任务';
  result.relation = typeof result.relation === 'string' && result.relation ? result.relation : fallbackRelation;
  result.intent = typeof result.intent === 'string' && result.intent ? result.intent : fallbackIntent;

  const commitment = { ...(result.commitment || {}) };
  if (!('task' in commitment)) commitment.task = null;
  if (!('deadlineText' in commitment)) commitment.deadlineText = null;
  if (typeof commitment.needsConfirm !== 'boolean') commitment.needsConfirm = !commitment.deadlineText;
  result.commitment = commitment;

  if (!result.antiExample || typeof result.antiExample !== 'object') result.antiExample = { text: '', reason: '' };
  if (typeof result.antiExample.reason !== 'string') result.antiExample.reason = '';

  const hasTask = !!commitment.task;
  result.replies = result.replies.map((rep) => {
    const found = risk.checkReplyRisks(rep.text, { hasTask });
    return {
      ...rep,
      riskNote: found.length
        ? '风险自检未通过: ' + found.map((r) => r.detail).join('; ')
        : '风险自检: 通过确定性风险校验（无打包票/过度道歉/谄媚/顶撞）',
    };
  });
  result.source = 'llm';
  return result;
}

function rulesFallback(input, reason) {
  const result = analyze(input);
  result.source = 'rules';
  result.llmError = reason;
  return result;
}

async function postChatCompletions(cfg, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
      throw new Error(`LLM request timeout after ${TIMEOUT_MS}ms`);
    }
    throw new Error(`LLM network error: ${shortReason(e)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch (_) { /* ignore */ }
    throw new Error(`LLM HTTP ${res.status}${bodyText ? ': ' + shortReason(bodyText) : ''}`);
  }
  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error('LLM returned invalid JSON (response body)');
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : undefined;
  if (typeof content !== 'string') {
    throw new Error('LLM response schema invalid: missing choices[0].message.content');
  }
  return parseContentJSON(content);
}

/**
 * 文本分析: 配置了大模型就用大模型, 否则/失败时回退规则引擎。
 * @param {{text:string, relation?:string, intent?:string, hour?:number}} input
 * @returns {Promise<object>} analyze() 的结果结构 + {source:'llm'|'rules', llmError?:string}
 */
async function analyzeWithLLM(input) {
  const cfg = getConfig();
  if (!cfg.configured) {
    return rulesFallback(input, 'LLM not configured: set ZUITI_LLM_API_KEY / ZUITI_LLM_MODEL (and optionally ZUITI_LLM_BASE_URL)');
  }
  try {
    const parsed = await postChatCompletions(cfg, {
      model: cfg.model,
      messages: [
        { role: 'system', content: loadSystemPrompt() },
        { role: 'user', content: JSON.stringify(input || {}) },
      ],
      response_format: { type: 'json_object' },
    });
    const validated = validateAnalysis(parsed);
    return finalizeLLMResult(validated, input || {});
  } catch (e) {
    return rulesFallback(input, shortReason(e));
  }
}

/**
 * 截图分析: 只有视觉大模型能做, 未配置/失败时如实报错, 绝不编造结果。
 * @param {string} base64 图片的 base64 (不带 data: 前缀)
 * @param {string} mime 如 image/png
 * @param {{relation?:string, intent?:string, hour?:number}} [opts]
 * @returns {Promise<object>} 成功时为分析结果 + {source:'llm', transcript:string};
 *   失败时为 {error:'vision_not_configured'|'vision_failed', message:string}
 */
async function analyzeImageWithLLM(base64, mime, opts = {}) {
  const cfg = getConfig();
  if (!cfg.configured) {
    return {
      error: 'vision_not_configured',
      message: '截图识别需要先配置大模型（设置 ZUITI_LLM_API_KEY 等环境变量）；规则引擎无法读取图片，未做任何猜测。',
    };
  }
  const options = opts || {};
  const hint = {
    relation: options.relation,
    intent: options.intent,
    hour: options.hour,
  };
  const instruction = [
    '这是一张聊天截图。请先逐字转录截图中的聊天记录 (谁说了什么, 一行一条, 格式如「领导: ...」/「我: ...」), 放进输出 JSON 的 transcript 字段 (string, 多条用 \\n 分隔)。',
    '然后把转录出的对方消息当作待分析的工作消息, 按系统提示词的固定顺序完成潜台词翻译、风险标注、承诺抽取、三版回复与反面教材, 输出同一个分析 JSON (结构与文本分析完全一致, 额外带 transcript 字段)。',
    '只输出严格 JSON, 不要输出 JSON 之外的文字。',
    `已知上下文 (可能为空): ${JSON.stringify(hint)}`,
  ].join('\n');
  try {
    const parsed = await postChatCompletions(cfg, {
      model: cfg.visionModel,
      messages: [
        { role: 'system', content: loadSystemPrompt() },
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
    });
    const validated = validateAnalysis(parsed);
    const result = finalizeLLMResult(validated, hint);
    result.transcript = typeof validated.transcript === 'string' ? validated.transcript : '';
    result.source = 'llm';
    return result;
  } catch (e) {
    return { error: 'vision_failed', message: shortReason(e) };
  }
}

module.exports = { getConfig, analyzeWithLLM, analyzeImageWithLLM };
