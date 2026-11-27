// 本地模拟模型服务（OpenAI 兼容 /v1/chat/completions + SSE），用于不花钱地自测对话和一句话操作。
// 它不是真的模型：只按几条固定的中文规则决定要不要调用工具，用来检验本地链路和界面，
// 不能代替真实服务的评估（tests/eval/live.test.ts）。
//
//   node scripts/mock-model-server.mjs            # 默认端口 18081
//   PORT=18081 MOCK_DELAY_MS=30 node scripts/mock-model-server.mjs
//   MOCK_REJECT_TOOLS=1 node scripts/mock-model-server.mjs   # 模拟不支持工具调用的服务（带 tools 时返回 400）
//
// 在小窝“设置”里选“自定义”，地址填 http://127.0.0.1:18081/v1，模型名随意（例如 mock），密钥留空。

import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 18081);
const DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? 30);
const REJECT_TOOLS = process.env.MOCK_REJECT_TOOLS === '1';

const DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** “十二”“二十”“3” → 数字 */
function num(text) {
  if (/^\d+$/.test(text)) return Number(text);
  if (text === '十') return 10;
  const ten = text.indexOf('十');
  if (ten < 0) return DIGITS[text] ?? null;
  const tens = ten === 0 ? 1 : DIGITS[text[0]];
  const ones = text.length > ten + 1 ? DIGITS[text[ten + 1]] : 0;
  return tens * 10 + ones;
}

const N = '(\\d+|[零一二两三四五六七八九十]+)';

/** 粗略提取时间语义：只为模拟，不追求完整 */
function parseWhen(text) {
  const when = {};
  if (/今天|今晚/.test(text)) when.relativeDays = 0;
  if (/明天|明早|明晚/.test(text)) when.relativeDays = 1;
  if (/后天/.test(text)) when.relativeDays = 2;
  const week = new RegExp(`(下)?(周|星期|礼拜)([一二三四五六日天])`).exec(text);
  if (week && !/每/.test(text)) {
    when.weekday = '一二三四五六'.indexOf(week[3]) + 1 || 7;
    if (week[1]) when.weekOffset = 1;
  }
  if (/凌晨/.test(text)) when.period = 'early_morning';
  else if (/早上|上午|明早|早晨/.test(text)) when.period = 'morning';
  else if (/中午/.test(text)) when.period = 'noon';
  else if (/下午/.test(text)) when.period = 'afternoon';
  else if (/晚上|今晚|明晚|傍晚/.test(text)) when.period = 'evening';
  else if (/半夜|深夜/.test(text)) when.period = 'night';
  const later = new RegExp(`${N}\\s*(分钟|个?小时)后`).exec(text);
  if (later) when.inMinutes = num(later[1]) * (later[2] === '分钟' ? 1 : 60);
  const clock = new RegExp(`${N}\\s*[点:：]\\s*(半|${N}分?)?`).exec(text);
  if (clock && !later) {
    when.hour = num(clock[1]);
    if (clock[2] === '半') when.minute = 30;
    else if (clock[3]) when.minute = num(clock[3]);
  }
  if (/每天|每日|天天|每晚/.test(text)) when.recurrence = 'daily';
  return when;
}

function reminderContent(text) {
  const after = /提醒我(.*)$/.exec(text)?.[1] ?? '';
  return after.replace(/[。！!～~，,]+$/, '').trim();
}

/** 决定阶段：根据最后一条用户消息决定调用哪些工具；不调用时返回 null */
function decide(userText, system) {
  const draftId = /draftId=([\w-]+)/.exec(system)?.[1];
  if (draftId && /只设|就设|设一次|下一次|今晚的|好的?，?那就/.test(userText)) {
    return [{ name: 'reminders_create', args: { draftId, onceOnly: true } }];
  }
  if (draftId && !/提醒/.test(userText) && new RegExp(`${N}\\s*[点:：]|分钟后|小时后`).test(userText)) {
    return [{ name: 'reminders_create', args: { draftId, when: parseWhen(userText) } }];
  }
  if (/别再?叫我|不要叫我|不用叫我/.test(userText)) return [{ name: 'preferences_setNickname', args: { nickname: null } }];
  const nick = /(?:以后|就)?叫我(.{1,10}?)(?:吧|就好|就行)?[。！!～]*$/.exec(userText);
  if (nick && !/提醒/.test(userText)) return [{ name: 'preferences_setNickname', args: { nickname: nick[1] } }];
  // M7：事项、进展、完成、跟进、记忆、忘记、说话方式（只认几种固定说法）
  const topicId = /id=([\w-]+)，“/.exec(system)?.[1];
  const memoryId = /与这句话相关的[\s\S]*?- id=([\w-]+)，/.exec(system)?.[1];
  if (/说话简短/.test(userText)) return [{ name: 'preferences_setStyle', args: { style: 'brief' } }];
  if (/忘掉|忘了吧|别再提/.test(userText)) {
    if (memoryId && !/事项|那件事|面试/.test(userText)) return [{ name: 'memories_forget', args: { id: memoryId } }];
    if (topicId) return [{ name: 'topics_forget', args: { id: topicId } }];
  }
  const topic = /^记住我(?:在|正在)(.+?)[。！!～]*$/.exec(userText);
  if (topic) return [{ name: 'topics_create', args: { title: topic[1] } }];
  const memo = /^记住我(.+?)[。！!～]*$/.exec(userText);
  if (memo) {
    const validFor = /这周/.test(memo[1]) ? { until: 'this_week' } : /今天/.test(memo[1]) ? { until: 'today' } : null;
    return [{ name: 'memories_create', args: { content: memo[1], ...(validFor ? { validFor } : {}) } }];
  }
  const prog = /^(.+?)，?帮?我?记一下进展/.exec(userText);
  if (prog && topicId) return [{ name: 'topics_recordProgress', args: { id: topicId, note: prog[1] } }];
  if (/完成了|结束了/.test(userText) && topicId) return [{ name: 'topics_setStatus', args: { id: topicId, status: 'done' } }];
  const ask = /问问我(.+?)[。！!～]*$/.exec(userText);
  if (ask) {
    return [
      {
        name: 'followUps_create',
        args: { purpose: ask[1], topicId: topicId ?? null, when: parseWhen(userText), reviewAfterDone: /复盘/.test(userText) },
      },
    ];
  }
  const note = /^(?:帮我)?(?:记一下|记下|记住)(?:这段话|这句话)?[：:，,\s]*(.+)$/.exec(userText);
  if (note) return [{ name: 'notes_create', args: { body: note[1] } }];
  if (/提醒我/.test(userText) && !/不用|别|算了/.test(userText)) {
    return [{ name: 'reminders_create', args: { content: reminderContent(userText), when: parseWhen(userText) } }];
  }
  return null;
}

/** 表达阶段：根据本地执行结果说一句话 */
function express(messages, userText) {
  const results = [...messages].reverse().find((m) => m.role === 'system' && m.content.startsWith('【系统】本轮的本地执行结果'));
  if (results) {
    const ask = /需要用户补充：(.+)/.exec(results.content)?.[1];
    if (ask) return ask;
    if (/已完成/.test(results.content)) return '好嘞，办好啦，看看下面的卡片～';
    return '这件事我现在还做不到，可以去小窝里操作哦。';
  }
  const system = messages[0]?.content ?? '';
  const nickname = /称呼对方为“(.+?)”/.exec(system)?.[1];
  // 回答“还记得吗”：只复述系统提示里列出的事项和记忆
  if (/记得|过敏|有什么事/.test(userText)) {
    const topic = /id=[\w-]+，“(.+?)”，(.+)/.exec(system);
    const memo = /与这句话相关的[\s\S]*?- id=[\w-]+，(.+)/.exec(system);
    const parts = [topic ? `记得“${topic[1]}”，${topic[2]}` : '', memo ? `记得你说过：${memo[1]}` : ''].filter(Boolean);
    return `${nickname ? `${nickname}，` : ''}${parts.length ? parts.join('；') : '这个我不记得了'}`;
  }
  return `${nickname ? `${nickname}，` : ''}（模拟回复）我听到你说：“${userText.slice(0, 30)}”`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end('{"error":{"message":"bad json"}}');
      return;
    }
    const messages = body.messages ?? [];
    const userText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const system = messages[0]?.content ?? '';
    const isRepair = messages.some((m) => m.role === 'system' && m.content.startsWith('【系统】你刚才的工具调用'));
    if (body.tools && REJECT_TOOLS) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":{"message":"this model does not support tools"}}');
      return;
    }
    console.log(`[mock] ${body.tools ? '决定' : '表达'}：${userText.slice(0, 40)}`);
    // 回流检查用：记录每次请求的全部消息（不含工具定义）
    if (process.env.MOCK_LOG) appendFileSync(process.env.MOCK_LOG, `${JSON.stringify(messages)}\n`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
    const calls = body.tools && !isRepair ? decide(userText, system) : null;
    if (calls) {
      // 先说一句“已经设置好了”再调用工具：两段式下不显示；单次流式下会被收起
      for (const ch of '好的，已经设置好了') {
        send({ content: ch });
        await sleep(DELAY_MS);
      }
      calls.forEach((call, index) => {
        const args = JSON.stringify(call.args);
        send({ tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: call.name, arguments: args.slice(0, 10) } }] });
        send({ tool_calls: [{ index, function: { arguments: args.slice(10) } }] });
      });
      send({}, 'tool_calls');
    } else {
      const text = body.tools && isRepair ? '' : express(messages, userText);
      for (const ch of text) {
        if (res.destroyed) return;
        send({ content: ch });
        await sleep(DELAY_MS);
      }
      send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock] 模拟模型服务：http://127.0.0.1:${PORT}/v1${REJECT_TOOLS ? '（不支持工具）' : ''}`));
