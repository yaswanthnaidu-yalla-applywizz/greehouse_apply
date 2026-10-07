const affirmativeTokens = [
  'yes',
  'agree',
  'accept',
  'authorized',
  'eligible',
  'willing',
  'consent',
  'true',
];

const negativeTokens = [
  'no',
  'not',
  'never',
  'decline',
  'prefer not',
  'ineligible',
  'unauthorized',
  'false',
];

const countryAliases = [
  'United States',
  'United States of America',
  'US',
  'USA',
  'U.S.',
];

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function editSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function fuzzySimilarity(answer: string, option: string): number {
  const editScore = editSimilarity(answer, option);
  const answerWords = answer.split(' ').filter(Boolean);
  const optionWords = new Set(option.split(' ').filter(Boolean));
  if (answerWords.length < 2) return editScore;
  const matchedWords = answerWords.filter((word) => optionWords.has(word)).length;
  const tokenCoverage = matchedWords / answerWords.length;
  return Math.max(editScore, tokenCoverage >= 0.8 ? tokenCoverage : 0);
}

function semanticPolarity(value: string): 'affirmative' | 'negative' | null {
  const normalized = normalize(value);
  if (!normalized) return null;
  if (/^(no|false)\b/.test(normalized) || negativeTokens.some((token) => normalized === token)) {
    return 'negative';
  }
  if (/^(yes|true)\b/.test(normalized) || affirmativeTokens.some((token) => normalized === token)) {
    return 'affirmative';
  }
  return null;
}

function optionPolarity(option: string): 'affirmative' | 'negative' | null {
  const normalized = normalize(option);
  if (!normalized) return null;
  if (negativeTokens.some((token) => normalized === token) || /^(no|not|false|decline)\b/.test(normalized)) {
    return 'negative';
  }
  if (
    affirmativeTokens.some((token) => normalized === token) ||
    /^(yes|true|agree|accept)\b/.test(normalized) ||
    affirmativeTokens.some((token) => normalized.includes(` ${token} `))
  ) {
    return 'affirmative';
  }
  return null;
}

function canonicalAlias(value: string): string | null {
  const normalized = normalize(value);
  if (countryAliases.some((alias) => normalize(alias) === normalized)) return 'united states';
  if (/^asian(?: not hispanic or latino)?$|^asian or pacific islander$/.test(normalized)) return 'asian';
  if (/^black(?: or african american| not hispanic or latino)?$/.test(normalized)) return 'black';
  if (/^white(?: not hispanic or latino)?$|^caucasian$/.test(normalized)) return 'white';
  if (/^hispanic(?: or latino| latino)?$|^latino$/.test(normalized)) return 'hispanic';
  if (/^two or more(?: races)?$|^multiracial$/.test(normalized)) return 'two or more';
  if (/^female$|^woman$|^she her$/.test(normalized)) return 'female';
  if (/^male$|^man$|^he him$/.test(normalized)) return 'male';
  if (/^no disability$|^i dont have a disability(?: and have not had one in the past)?$/.test(normalized)) {
    return 'no disability';
  }
  if (/^not a veteran$|^i am not a protected veteran$|^none of the above$/.test(normalized)) {
    return 'not veteran';
  }
  if (/^decline(?: to self identify)?$|^prefer not to (?:say|answer)$|^i dont wish to answer$|^choose not to disclose$/.test(normalized)) {
    return 'decline';
  }
  return null;
}

/**
 * Maps a semantic/profile/LLM answer to one safe option label.
 * Returns null when the answer cannot be mapped without guessing.
 */
export function matchChoiceOption(answer: string, options?: string[]): string | null {
  if (!options?.length) return null;
  const normalizedAnswer = normalize(answer);
  if (!normalizedAnswer) return null;

  const exact = options.filter((option) => normalize(option) === normalizedAnswer);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const alias = canonicalAlias(answer);
  if (alias) {
    const aliasMatches = options.filter((option) => {
      const optionAlias = canonicalAlias(option);
      return optionAlias === alias || normalize(option) === alias;
    });
    if (aliasMatches.length === 1) return aliasMatches[0];
  }

  const polarity = semanticPolarity(answer);
  if (polarity) {
    const polarityMatches = options.filter((option) => optionPolarity(option) === polarity);
    if (polarityMatches.length === 1) return polarityMatches[0];
  }

  const prefixMatches = options.filter((option) => {
    const normalizedOption = normalize(option);
    return normalizedOption.startsWith(normalizedAnswer) || normalizedAnswer.startsWith(normalizedOption);
  });
  if (prefixMatches.length === 1 && normalizedAnswer.length >= 3) return prefixMatches[0];

  const ranked = options
    .map((option) => ({ option, score: fuzzySimilarity(normalizedAnswer, normalize(option)) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const next = ranked[1];
  if (best && best.score >= 0.88 && (!next || best.score - next.score >= 0.08)) {
    return best.option;
  }
  return null;
}

export function choiceOptionTextMatches(optionText: string, answerText: string): boolean {
  return matchChoiceOption(answerText, [optionText]) === optionText;
}
