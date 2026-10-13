import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Browser harness helper; no SQL/application endpoint or business implementation here.
export async function control(directory, input, timeoutMs = 5000) {
  const id = randomUUID(), file = join(directory, 'request-' + id);
  writeFileSync(file + '.tmp', JSON.stringify({ ...input, id })); renameSync(file + '.tmp', file + '.json');
  const ack = join(directory, 'response-' + id + '.json'), deadline = Date.now() + timeoutMs;
  while (!existsSync(ack) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(existsSync(ack), 'isolated SQL IPC timed out');
  const response = JSON.parse(readFileSync(ack)); assert.equal(response.ok, true, response.error); return response.result;
}
