import { createInterface } from 'node:readline';
let id = 0;
const active = new Map();
const requests = new Map();
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const reply = (id, result) => send({ id, result });
const finish = (threadId, turnId, status = 'completed') => notify('turn/completed', { threadId, turn: { id: turnId, status } });
const ask = (method, params) => new Promise(resolve => {
  const requestId = `server-${++id}`;
  requests.set(requestId, resolve);
  send({ id: requestId, method, params });
});
createInterface({ input: process.stdin }).on('line', async line => {
  const m = JSON.parse(line);
  if (!m.method) { requests.get(m.id)?.(m.result); requests.delete(m.id); return; }
  const p = m.params ?? {};
  if (m.method === 'initialize') return reply(m.id, { userAgent: 'codex/0.162.0' });
  if (m.method === 'initialized') return;
  if (m.method === 'thread/start') return reply(m.id, { thread: { id: `thread-${++id}` } });
  if (m.method === 'thread/resume') {
    if (p.threadId === 'missing') return send({ id: m.id, error: { code: -32000, message: 'session unavailable' } });
    return reply(m.id, { thread: { id: p.threadId } });
  }
  if (m.method === 'turn/interrupt') { reply(m.id, {}); return finish(p.threadId, p.turnId, 'interrupted'); }
  if (m.method === 'turn/steer') return reply(m.id, { turnId: p.expectedTurnId });
  if (m.method !== 'turn/start' && m.method !== 'thread/compact/start') return reply(m.id, {});
  const threadId = p.threadId;
  const turnId = `turn-${++id}`;
  const input = p.input?.map(i => i.text ?? '').join('\n') ?? 'compact';
  active.set(threadId, turnId);
  if (input === 'lose-producer') { reply(m.id, { turn: { id: turnId } }); setTimeout(() => process.exit(3), 10); return; }
  if (input === 'never-acknowledge') return;
  if (input === 'wait') return reply(m.id, { turn: { id: turnId } });
  if (input === 'tool' || input === 'duplicate-tool') {
    reply(m.id, { turn: { id: turnId } });
    const params = { threadId, turnId, callId: 'call-1', tool: 'edit_document', arguments: { text: 'Updated by Agent' } };
    const responses = await Promise.all(Array.from({ length: input === 'duplicate-tool' ? 2 : 1 }, () => ask('item/tool/call', params)));
    notify('item/completed', { threadId, turnId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(responses) } });
    finish(threadId, turnId); return;
  }
  if (input === 'approval' || input === 'question') {
    reply(m.id, { turn: { id: turnId } });
    const result = await ask(input === 'approval' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput', {
      threadId, turnId, itemId: 'item-1', questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Blue', description: 'Blue' }] }],
    });
    notify('item/completed', { threadId, turnId, item: { id: 'answer', type: 'agentMessage', text: JSON.stringify(result) } });
    finish(threadId, turnId); return;
  }
  // Deliberately send notifications before the start response.
  notify('item/started', { threadId, turnId, item: { id: 'commentary', type: 'agentMessage', phase: 'commentary' } });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'commentary', delta: 'Working...' });
  notify('item/started', { threadId, turnId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer' } });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: input });
  notify('item/completed', { threadId, turnId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: input } });
  finish(threadId, turnId);
  reply(m.id, { turn: { id: turnId } });
});
