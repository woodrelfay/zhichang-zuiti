'use strict';
// risk.js — 可复用的风险规则库
// 同时用于: (a) 解读收到的消息 (b) 检查候选回复
// 规则均为确定性正则/词表, 不依赖任何外部服务。

// ---- 时间/截止表达 ----
const DEADLINE_PATTERNS = [
  /(周[一二三四五六日天](?:上午|下午|晚上)?下班前)/,
  /((?:今天|明天|今晚|明早)下班前)/,
  /(今天|今晚|明早|明天|后天)/,
  /(下班前|下班之前|上班前|午饭前|吃午饭前)/,
  /(周[一二三四五六日天](?:上午|下午|晚上|之前|前)?)/,
  /(下周[一二三四五六日天]?)/,
  /(\d{1,2}\s*[:：点]\s*\d{0,2}\s*(?:之前|前)?)/,
  /(\d{1,2}\s*月\s*\d{1,2}\s*[日号])/,
  /(尽快|马上|立刻|抓紧|加急)/,
];

// 取"位置最早"的命中; 同位置取更长的 ("周五下班前" 优先于 "下班前")
function extractDeadline(text) {
  if (!text) return null;
  let best = null;
  for (const re of DEADLINE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const cand = { value: m[1], index: m.index };
    if (!best || cand.index < best.index || (cand.index === best.index && cand.value.length > best.value.length)) {
      best = cand;
    }
  }
  return best ? best.value : null;
}

// ---- 承诺类措辞 (回复里出现 = 可能把自己钉死) ----
const PROMISE_WORDS = ['保证', '一定', '没问题', '肯定', '包在我身上', '绝对', '放心', '必须'];
// ---- 过度道歉 ----
const OVER_APOLOGY_WORDS = ['对不起对不起', '非常抱歉', '万分抱歉', '都是我的错', '全是我的问题', '我太笨了', '对不起', '实在抱歉', '深感抱歉'];
// ---- 谄媚/卑微 ----
const SERVILE_WORDS = ['好的好的好的', '您说的都对', '全听您的', '我马上改，马上', '给您添麻烦了', '辛苦您了辛苦您了', '领导您辛苦了', '是是是', '好好好，我错了'];
// ---- 过硬/顶撞 ----
const BLUNT_WORDS = ['这不合理', '做不了', '不可能', '没时间', '不归我管', '你自己看吧', '随便', '我不管', '爱咋咋', '下班了别找我', '这不是我的事'];

function hitWords(text, words) {
  return words.filter((w) => text && text.includes(w));
}

/**
 * 检查一段"候选回复"文本的风险。
 * @returns {Array<{type:string, level:'high'|'medium', detail:string}>}
 */
function checkReplyRisks(replyText, context = {}) {
  const risks = [];
  if (!replyText) return risks;

  const deadline = extractDeadline(replyText);
  const promises = hitWords(replyText, PROMISE_WORDS);
  if (promises.length && deadline) {
    risks.push({
      type: 'deadline_promise',
      level: 'high',
      detail: `出现「${promises[0]}」+ 时间点「${deadline}」, 等于当场承诺了交付时间, 做不到会被截图追责`,
    });
  } else if (promises.length) {
    risks.push({
      type: 'over_promise',
      level: 'medium',
      detail: `出现「${promises[0]}」这类打包票措辞, 建议换成带进度节点的说法, 给自己留余地`,
    });
  }

  const apologies = hitWords(replyText, OVER_APOLOGY_WORDS);
  if (apologies.length) {
    risks.push({
      type: 'over_apology',
      level: apologies.length >= 2 || apologies.includes('都是我的错') || apologies.includes('全是我的问题') ? 'high' : 'medium',
      detail: `道歉措辞偏重 (${apologies.join('、')}), 容易把不属于你的责任也揽下来`,
    });
  }

  const servile = hitWords(replyText, SERVILE_WORDS);
  if (servile.length) {
    risks.push({
      type: 'servile',
      level: 'medium',
      detail: `出现「${servile[0]}」, 语气过卑, 长期会让对方默认你可以无限加活`,
    });
  }

  const blunt = hitWords(replyText, BLUNT_WORDS);
  if (blunt.length) {
    risks.push({
      type: 'blunt',
      level: 'high',
      detail: `出现「${blunt[0]}」, 在文字里会被读成顶撞/甩锅, 截图传播时更吃亏`,
    });
  }

  // 含糊确认: 只说"好的/收到"但对方布置了明确任务时, 后续容易背锅
  if (/^(好的|收到|嗯|ok|OK)[。!！\s]*$/.test(replyText.trim()) && context.hasTask) {
    risks.push({
      type: 'vague_ack',
      level: 'medium',
      detail: '只回「好的/收到」没有复述任务和时间点, 事后对方说"我当时说的是另一个"时你没证据',
    });
  }

  return risks;
}

/**
 * 解读"收到的消息"里的施压/甩责信号。
 */
function analyzeIncomingSignals(text) {
  const signals = [];
  if (!text) return signals;
  if (/(怎么还没|为什么还没|还没好|又拖|每次都)/.test(text)) {
    signals.push({ type: 'blame_pressure', detail: '对方在强调"你慢了/你又出问题", 情绪大于信息' });
  }
  if (/(简单|随便弄一下|很简单|顺手|几分钟的事)/.test(text)) {
    signals.push({ type: 'scope_minimizer', detail: '对方在把工作量说小 ("简单/顺手"), 实际工时往往被低估, 回复时要把步骤说清' });
  }
  if (/(别人都|其他组都|人家)/.test(text)) {
    signals.push({ type: 'comparison_pressure', detail: '对方在拿别人做对比施压, 不要顺势承诺超过别人的进度' });
  }
  if (/(先这样|看着办|你决定|自己想办法)/.test(text)) {
    signals.push({ type: 'vague_delegation', detail: '对方给的是模糊授权, 做错了容易背锅, 回复里必须请示确认关键点' });
  }
  return signals;
}

function isAfterHoursHint(text, hour) {
  // hour 可由调用方传入 (0-23); 未传入时只看文本线索
  if (typeof hour === 'number' && (hour >= 21 || hour < 8)) return true;
  return /(睡了吗|在吗|明天上班|周末|休息|假期|下班)/.test(text || '');
}

module.exports = {
  DEADLINE_PATTERNS,
  PROMISE_WORDS,
  OVER_APOLOGY_WORDS,
  SERVILE_WORDS,
  BLUNT_WORDS,
  extractDeadline,
  hitWords,
  checkReplyRisks,
  analyzeIncomingSignals,
  isAfterHoursHint,
};
