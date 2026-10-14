const affirmativeTokens = [
  'yes',
  'agree',
  'accept',
  'authorized',
  'eligible',
  'willing',
  'consent',
  'true',
  'acknowledge',
  'confirm',
  'reviewed',
  'certify',
  'attest',
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
  'U.S.A.',
];

const ukCountryAliases = [
  'United Kingdom',
  'UK',
  'U.K.',
  'Great Britain',
  'Britain',
  'GB',
];

const uaeCountryAliases = [
  'United Arab Emirates',
  'UAE',
  'U.A.E.',
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
  if (
    negativeTokens.some((token) => normalized === token) ||
    /^(no|not|false|decline)\b/.test(normalized) ||
    /^(i do not|i am not)\b/.test(normalized)
  ) {
    return 'negative';
  }
  if (
    affirmativeTokens.some((token) => normalized === token) ||
    /^(yes|true|agree|accept|acknowledge|confirm)\b/.test(normalized) ||
    /^(i confirm|i acknowledge|i have reviewed)\b/.test(normalized) ||
    affirmativeTokens.some(
      (token) =>
        normalized.includes(` ${token} `) ||
        normalized.startsWith(`${token} `) ||
        normalized.endsWith(` ${token}`)
    )
  ) {
    return 'affirmative';
  }
  return null;
}

function stripDialCodeSuffix(val: string): string {
  return val.replace(/\s*\+\d+$/, '').trim();
}

function canonicalAlias(value: string): string | null {
  const stripped = stripDialCodeSuffix(value);
  const normalized = normalize(stripped);
  if (countryAliases.some((alias) => normalize(alias) === normalized)) return 'united states';
  if (ukCountryAliases.some((alias) => normalize(alias) === normalized)) return 'united kingdom';
  if (uaeCountryAliases.some((alias) => normalize(alias) === normalized)) return 'united arab emirates';
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
  // Degree levels
  if (/\b(?:master of science|m\.s\.|ms)\b/.test(normalized)) {
    return 'ms';
  }
  if (/\b(?:master of arts|m\.a\.|ma)\b/.test(normalized)) {
    return 'ma';
  }
  if (/\b(?:master(?:s|\x27s)?|master of engineering)\b/.test(normalized)) {
    return 'masters';
  }
  if (/\b(?:bachelor of science|b\.s\.|bs|bachelor of technology|b\.tech|btech)\b/.test(normalized)) {
    return 'bs';
  }
  if (/\b(?:bachelor of arts|b\.a\.|ba)\b/.test(normalized)) {
    return 'ba';
  }
  if (/\b(?:bachelor(?:s|\x27s)?|undergraduate)\b/.test(normalized)) {
    return 'bachelors';
  }
  if (/\b(?:doctorate|doctoral|phd|ph\.d\.|doctor of philosophy)\b/.test(normalized)) {
    return 'doctorate';
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
    const isDegreeAlias = ['ms', 'ma', 'masters', 'bs', 'ba', 'bachelors', 'doctorate'].includes(alias);
    const aliasMatches = options.filter((option) => {
      const optionAlias = canonicalAlias(option);
      if (optionAlias === alias || normalize(option) === alias) return true;
      if (isDegreeAlias && optionAlias) {
        if ((alias === 'ms' || alias === 'ma') && optionAlias === 'masters') return true;
        if (alias === 'masters' && (optionAlias === 'ms' || optionAlias === 'ma')) return true;
        if ((alias === 'bs' || alias === 'ba') && optionAlias === 'bachelors') return true;
        if (alias === 'bachelors' && (optionAlias === 'bs' || optionAlias === 'ba')) return true;
      }
      return false;
    });
    if (aliasMatches.length === 1) return aliasMatches[0];
    if (aliasMatches.length > 1) {
      // Disambiguate when multiple options match (e.g. MS vs MA)
      // 1. Direct acronym match (e.g. "Master of Science" -> "MS")
      const directAcronym = aliasMatches.find((opt) => normalize(opt) === alias);
      if (directAcronym) return directAcronym;

      // 2. Acronym from initials
      const initials = normalizedAnswer
        .split(' ')
        .filter(Boolean)
        .map((w) => w[0])
        .join('');
      const initialMatch = aliasMatches.find((opt) => normalize(opt) === initials);
      if (initialMatch) return initialMatch;

      // 3. Substring or highest similarity
      const rankedMatches = aliasMatches
        .map((opt) => ({ opt, score: fuzzySimilarity(normalizedAnswer, normalize(opt)) }))
        .sort((a, b) => b.score - a.score);
      if (rankedMatches[0] && (!rankedMatches[1] || rankedMatches[0].score > rankedMatches[1].score)) {
        return rankedMatches[0].opt;
      }
    }
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
