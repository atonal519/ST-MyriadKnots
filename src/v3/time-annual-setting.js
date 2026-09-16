const clean = (value, maximum = 4000) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum);
const ANNUAL_WORDS = /生日|诞辰|誕辰|忌日|周年|週年|纪念日|紀念日|每年|每逢|年年/u;
const DATE_CONTEXT = /(?:年|月|日|号|號|初[一二三四五六七八九十]|\d{1,2}[/.~-]\d{1,2})/u;
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const ANNUAL_SETTING_SYSTEM_PROMPT = `你是“千千结”的年度日期设定整理器。输入仅含人物基础资料或用户人设中与年度日期有关的小段。
逐个 sourceId 返回且只能返回一次；即使没有合格事项也返回空 items。只提取明确生日、诞辰、忌日、周年、纪念日或明确“每年此日”行动。普通历史事件只有一次日期时不创建年度事项，也不提取身体恢复、生理周期或普通承诺。
输出浅层 JSON：{"sources":[{"sourceId":"S1","items":[{"category":"birthday|anniversary|memorial","label":"简短名称","originalDate":"原设定日期文本","calendar":"gregorian|special|unknown","month":1,"day":1,"note":"简短年度含义"}]}]}。
公历且月日明确才填写 month/day；特殊历法保留 originalDate，month/day 用 null。不得创造数据库 ID、日期、仪式、已庆祝或已履约事实。`;

function fragments(value, always = false) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const pieces = text.split(/\n+|(?<=[。！？!?；;])\s*/u).map(part => clean(part, 1000000)).filter(Boolean);
  if (always) return [...new Set(pieces)].join('\n');
  const relevant = new Set();
  pieces.forEach((part, index) => {
    if (!ANNUAL_WORDS.test(part)) return;
    relevant.add(part);
    for (const nearby of [pieces[index - 1], pieces[index + 1]]) if (nearby && DATE_CONTEXT.test(nearby)) relevant.add(nearby);
  });
  return [...relevant].join('\n');
}

export function buildAnnualSettingSources({ people = [], userPersona = null } = {}) {
  const sources = [];
  const add = (owner, field, value, always = false) => {
    const content = fragments(value, always);
    if (!content || !owner?.entityId) return;
    sources.push({ sourceKey: `${owner.kind}:${owner.entityId}:${field}`, subjectEntityId: owner.entityId,
      subjectName: clean(owner.name, 100) || '人物未提供', field, content });
  };
  for (const person of people) {
    const profile = person?.profile;
    if (!profile || !person.entityId) continue;
    const owner = { kind: 'person', entityId: person.entityId, name: profile.name || person.displayName };
    add(owner, 'birthday', profile.birthday, true);
    for (const field of ['notes', 'background', 'identityRelations']) add(owner, field, profile[field]);
  }
  if (userPersona?.entityId) add({ kind: 'user', entityId: userPersona.entityId, name: userPersona.name }, 'description', userPersona.description);
  return sources;
}

const validMonthDay = (month, day) => Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(day) && day >= 1 && day <= DAYS[month - 1];

export function compileAnnualSettingResponse(response, prepared) {
  let data = response?.jsonData ?? response?.textData ?? response;
  if (typeof data === 'string') data = JSON.parse(data.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
  if (!data || !Array.isArray(data.sources)) throw new Error('年度设定结果格式无效。');
  const byId = new Map(), duplicated = new Set();
  for (const row of data.sources) {
    if (byId.has(row?.sourceId)) duplicated.add(row?.sourceId);
    else byId.set(row?.sourceId, row);
  }
  const succeeded = [], errors = [];
  for (const source of prepared.sources) {
    const row = byId.get(source.id);
    try {
      if (!row || duplicated.has(source.id) || !Array.isArray(row.items) || row.items.length > 20) throw new Error('来源缺失、重复或 items 无效。');
      const items = row.items.map((item, index) => {
        const category = item?.category, calendar = item?.calendar;
        const label = clean(item?.label, 150), originalDate = clean(item?.originalDate, 300), note = clean(item?.note, 500);
        if (!['birthday', 'anniversary', 'memorial'].includes(category) || !['gregorian', 'special', 'unknown'].includes(calendar) || !label || !originalDate) throw new Error(`第${index + 1}项字段无效。`);
        const month = item.month == null ? null : Number(item.month), day = item.day == null ? null : Number(item.day);
        if (calendar === 'gregorian' ? !validMonthDay(month, day) : month !== null || day !== null) throw new Error(`第${index + 1}项日期无效。`);
        return { category, label, originalDate, calendar, month, day, note };
      });
      succeeded.push({ sourceKey: source.sourceKey, fingerprint: source.fingerprint, subjectEntityId: source.subjectEntityId,
        subjectName: source.subjectName, field: source.field, items });
    } catch (error) { errors.push({ sourceKey: source.sourceKey, reason: error.message }); }
  }
  if (!succeeded.length && prepared.sources.length) throw Object.assign(new Error('年度设定结果没有可保存的来源。'), { annualErrors: errors });
  return { succeeded, errors };
}

function occurrence(item, currentTime) {
  if (item.calendar !== 'gregorian' || !validMonthDay(item.month, item.day)) return null;
  if (!Number.isInteger(currentTime?.year) || !Number.isInteger(currentTime?.day)) {
    const distance = currentTime?.month === item.month && Number.isInteger(currentTime?.monthDay) && item.day >= currentTime.monthDay ? item.day - currentTime.monthDay : null;
    return { year: null, day: null, date: `${item.month}月${item.day}日（年份未明）`, distance };
  }
  for (let year = currentTime.year; year <= currentTime.year + 8; year += 1) {
    const stamp = Date.UTC(year, item.month - 1, item.day), date = new Date(stamp);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== item.month - 1 || date.getUTCDate() !== item.day) continue;
    const day = stamp / 86400000;
    if (day >= currentTime.day) return { year, day, date: date.toISOString().slice(0, 10), distance: day - currentTime.day };
  }
  return null;
}

export function projectAnnualSettings(records = [], currentTime = null, bodyReminders = []) {
  const items = [], reminders = [];
  for (const record of records) for (const [index, item] of (record.items ?? []).entries()) {
    const next = occurrence(item, currentTime);
    const duplicate = next && bodyReminders.some(body => body.type === 'deadline' && body.subjectEntityId === record.subjectEntityId
      && (Number.isInteger(next.day) ? Number.isInteger(body.dueTime?.day) && body.dueTime.day === next.day
        : next.year === null && body.dueTime?.year == null && body.dueTime?.month === item.month && body.dueTime?.monthDay === item.day)
      && (item.category === 'birthday' ? /生日|诞辰|誕辰/u : /周年|週年|纪念|紀念|忌日/u).test(`${body.label ?? ''} ${body.observation ?? ''}`));
    const id = `annual:${record.sourceKey}:${index}`;
    const status = !next ? '日期待明确' : Number.isInteger(next.distance) && next.distance <= 7 ? next.distance === 0 ? '今天' : `临近（${next.distance}天后）` : '休眠';
    items.push({ id, sourceKey: record.sourceKey, subjectEntityId: record.subjectEntityId, person: record.subjectName,
      ...item, nextDate: next?.date ?? null, distance: next?.distance ?? null, status });
    if (next && Number.isInteger(next.distance) && next.distance <= 7 && !duplicate) reminders.push({ itemId: id, type: 'annual', subjectEntityId: record.subjectEntityId,
      rankText: `${record.subjectName} ${item.label} ${item.note}`, distance: next.distance, sourceSignature: JSON.stringify([record.sourceKey, record.fingerprint, item]),
      text: `${record.subjectName} / ${item.label}：原日期 ${item.originalDate}；下次日期 ${next.date}，${next.distance ? `还有${next.distance}天` : '已到本日'}。${item.note ? `年度含义：${item.note}；` : ''}尚未确认庆祝、纪念或履约。` });
  }
  return { items, reminders };
}
