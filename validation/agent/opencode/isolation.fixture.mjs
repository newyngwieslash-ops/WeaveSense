// Test-only bridge: never included in the production runtime target.
import { createServer } from 'node:http';
let modelCalls = 0, toolCalls = 0;
const grant = 'opaque-run-grant-fixture';
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
createServer(async (req, res) => {
  if (req.url === '/fixture/counts') return json(res, { modelCalls, toolCalls });
  if (req.headers.authorization !== `Bearer ${grant}`) return json(res, { error: 'invalid_grant' }, 401);
  if (req.method !== 'POST') return res.writeHead(405).end();
  req.setEncoding('utf8');
  let text = ''; for await (const chunk of req) text += chunk;
  const input = JSON.parse(text);
  if (req.url === '/mcp') {
    if (input.id === undefined) return res.writeHead(202).end();
    let result;
    if (input.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'isolated-test-corpus', version: '1.0.0' } };
    else if (input.method === 'tools/list') result = { tools: [
      { name: 'search_items', description: 'Search approved fixture sources', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'get_item', description: 'Read approved fixture source', inputSchema: { type: 'object', properties: { item_id: { type: 'string' } }, required: ['item_id'] } }
    ] };
    else if (input.method === 'tools/call') { toolCalls++; result = { content: [{ type: 'text', text: JSON.stringify({ item_id: 'fixture-item', evidence_id: 'fixture-evidence', text: 'The fixture corpus supports cotton conductivity.' }) }] }; }
    else result = {};
    return json(res, { jsonrpc: '2.0', id: input.id, result });
  }
  if (req.url !== '/v1/chat/completions') return json(res, { error: 'forbidden_path' }, 404);
  modelCalls++;
  const count = input.messages.filter((m) => m.role === 'tool').length;
  const call = count === 0 ? { id: 'call_search', type: 'function', function: { name: 'corpus_search_items', arguments: JSON.stringify({ query: 'cotton' }) } }
    : count === 1 ? { id: 'call_read', type: 'function', function: { name: 'corpus_get_item', arguments: JSON.stringify({ item_id: 'fixture-item' }) } } : null;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, ...call }] } : { role: 'assistant', content: JSON.stringify({ title: 'Isolated fixture report', body: 'Cotton conductivity is supported by the approved corpus.', citations: [{ item_id: 'fixture-item', evidence_id: 'fixture-evidence' }] }) };
  for (const [part, finish] of [[delta, null], [{}, call ? 'tool_calls' : 'stop']]) {
    res.write(`data: ${JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}).listen(8792, '0.0.0.0');
