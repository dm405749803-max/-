const RELATION_ALIASES = new Map([
  ['self', ['self', '本人', '自己', '客户', '咨询人']],
  ['daughter', ['daughter', '女儿', '闺女']],
  ['son', ['son', '儿子']],
  ['child', ['child', '孩子', '子女']],
  ['father', ['father', '父亲', '爸爸']],
  ['mother', ['mother', '母亲', '妈妈']],
  ['spouse', ['spouse', '爱人', '配偶', '丈夫', '妻子']]
]);

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizedRelation(value) {
  const source = text(value, 80).toLowerCase();
  for (const [relation, aliases] of RELATION_ALIASES) {
    if (aliases.some(alias => source === alias || source.includes(alias))) return relation;
  }
  return null;
}

function personRelation(person) {
  if (person?.is_customer === true || person?.is_contact === true) return 'self';
  return normalizedRelation(person?.relationship_to_customer || person?.relationship || person?.relation || person?.role || person?.label);
}

function findPerson(persons, relation) {
  const exact = persons.filter(person => personRelation(person) === relation);
  if (exact.length === 1) return exact[0];
  if (relation === 'daughter' || relation === 'son') {
    const generic = persons.filter(person => personRelation(person) === 'child');
    if (!exact.length && generic.length === 1) return generic[0];
  }
  return null;
}

function relationFromLabel(label) {
  if (/^我|本人/.test(label)) return 'self';
  if (/女儿|闺女/.test(label)) return 'daughter';
  if (/儿子/.test(label)) return 'son';
  if (/孩子|子女/.test(label)) return 'child';
  if (/父亲|爸爸/.test(label)) return 'father';
  if (/母亲|妈妈/.test(label)) return 'mother';
  if (/爱人|配偶|丈夫|妻子/.test(label)) return 'spouse';
  return null;
}

function ageMentions(message) {
  const mentions = [];
  const seen = new Set();
  const add = (age, label, evidence) => {
    const numeric = Number(age);
    const relation = relationFromLabel(label);
    const key = `${numeric}:${relation}:${evidence}`;
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 120 || !relation || seen.has(key)) return;
    seen.add(key);
    mentions.push({ age: numeric, relation, label, evidence });
  };

  for (const match of message.matchAll(/(我|本人)\s*(?:今年)?\s*(\d{1,3})\s*岁/g)) add(match[2], match[1], match[0]);
  for (const match of message.matchAll(/(\d{1,3})\s*岁的?\s*(女儿|闺女|儿子|孩子|子女|父亲|爸爸|母亲|妈妈|爱人|配偶|丈夫|妻子)/g)) add(match[1], match[2], match[0]);
  for (const match of message.matchAll(/(女儿|闺女|儿子|孩子|子女|父亲|爸爸|母亲|妈妈|爱人|配偶|丈夫|妻子)\s*(?:今年)?\s*(\d{1,3})\s*岁/g)) add(match[2], match[1], match[0]);
  return mentions;
}

function paymentTermMentions(message) {
  const result = [];
  for (const match of message.matchAll(/趸交|\d{1,2}\s*年\s*(?:交|缴)/g)) {
    const start = Math.max(0, match.index - 10);
    const end = Math.min(message.length, match.index + match[0].length + 8);
    const window = message.slice(start, end);
    const negated = /(?:不想|不要|不按|不考虑|不选|别|排除)[^\uff0c。；;]{0,8}$/.test(message.slice(start, match.index));
    const comparison = /(?:只是|先)?(?:比较|对比|看看|了解)[^\uff0c。；;]{0,8}$/.test(message.slice(start, match.index));
    const affirmative = /(?:想按|就按|确定|选择|决定|打算按)[^\uff0c。；;]{0,8}$/.test(message.slice(start, match.index));
    result.push({
      value: /趸/.test(match[0]) ? '趸交' : `${Number(match[0].match(/\d+/)?.[0])} 年交`,
      evidence: match[0],
      negated,
      comparison: comparison && !affirmative,
      window
    });
  }
  return result;
}

export function analyzeContext(context, recordedAt = new Date().toISOString()) {
  const message = text(context?.latest_message, 5000);
  const persons = Array.isArray(context?.persons) ? context.persons : [];
  const messageId = text(context?.latest_message_id, 160) || null;
  const opportunityId = text(context?.opportunity_id, 160) || null;
  const proposed = [];
  const riskFlags = [];
  const missingEvidence = [];
  let nextQuestion = null;

  for (const mention of ageMentions(message)) {
    const person = findPerson(persons, mention.relation);
    if (!person?.person_id) {
      missingEvidence.push(`person_identity_unresolved:${mention.relation}`);
      nextQuestion ||= `您提到的${mention.label}对应档案里哪一位人物？确认后我再记录年龄。`;
      continue;
    }
    proposed.push({
      field: 'age',
      value: mention.age,
      person_id: person.person_id,
      opportunity_id: null,
      evidence_message_ids: messageId ? [messageId] : [],
      status: 'proposed',
      recorded_at: recordedAt,
      evidence_excerpt: mention.evidence
    });
  }

  for (const mention of paymentTermMentions(message)) {
    if (mention.negated || mention.comparison) {
      riskFlags.push('negated_or_comparison_payment_term_not_persisted');
      continue;
    }
    proposed.push({
      field: 'payment_term',
      value: mention.value,
      person_id: null,
      opportunity_id: opportunityId,
      evidence_message_ids: messageId ? [messageId] : [],
      status: 'proposed',
      recorded_at: recordedAt,
      evidence_excerpt: mention.evidence
    });
  }

  return {
    proposed_fact_changes: proposed,
    risk_flags: [...new Set(riskFlags)],
    missing_evidence: [...new Set(missingEvidence)],
    next_question: nextQuestion
  };
}

export const __test = { normalizedRelation, personRelation, ageMentions, paymentTermMentions };
