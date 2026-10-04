import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const userRoot = process.argv[2];
if (!userRoot) throw new Error('请提供酒馆用户数据目录。');
const directory = resolve(userRoot, '.st-bainiaodata/storage-v1/records/qianqianjie/private-diagnostics');
const anonymize = value => value ? createHash('sha256').update(value).digest('hex').slice(0, 10) : null;
let files;
try { files = await readdir(directory); }
catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
const rows = [];
for (const file of files.filter(value => /^recall-live-[0-7]\.json$/u.test(value))) {
  const record = JSON.parse(await readFile(resolve(directory, file), 'utf8'));
  if (record.data?.kind !== 'qqj-private-recall-diagnostic') continue;
  for (const event of record.data.events.slice(-8)) {
    const data = event.data, last = data.last;
    rows.push({ at: event.capturedAt, bundle: record.data.bundleVersion, chat: anonymize(data.chatId),
      status: data.status, pageVisibility: data.pageVisibility, phase: data.active?.phase ?? last?.diagnosticPhase, floor: data.active?.userMessageIndex ?? last?.userMessageIndex,
      error: last?.error?.code, reasons: last?.skipReasons,
      timings: last?.timings, injectionTokens: last?.stages?.estimatedTokenCount, injectionBudget: last?.stages?.estimatedTokenBudget,
      injected: last?.injected, persistence: last?.receiptPersistence, http: data.requests?.entries });
  }
}
console.log(JSON.stringify({ status: rows.length ? 'available' : 'waitingForBrowser', events: rows.sort((a, b) => a.at.localeCompare(b.at)).slice(-16) }, null, 2));
