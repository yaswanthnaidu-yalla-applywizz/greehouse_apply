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

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
  if (/^united states(?: of america)?$|^usa$|^us$/.test(normalized)) return 'united states';
  if (/^asian(?: not hispanic or latino)?$|^asian or pacific islander$/.test(normalized)) return 'asian';
  if (/^black(?: or african american| not hispanic or latino)?$/.test(normalized)) return 'black';
  if (/^white(?: not hispanic or latino)?$|^caucasian$/.test(normalized)) return 'white';
  if (/^hispanic(?: or latino| latino)?$|^latino$/.test(normalized)) return 'hispanic';
  if (/^female$|^woman$|^she her$/.test(normalized)) return 'female';
  if (/^male$|^man$|^he him$/.test(normalized)) return 'male';
  if (/^no disability$|^i dont have a disability(?: and have not had one in the past)?$/.test(normalized)) {
    return 'no disability';
  }
  if (/^not a veteran$|^i am not a protected veteran$|^none of the above$/.test(normalized)) {
    return 'not veteran';
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

  const exact = options.find((option) => normalize(option) === normalizedAnswer);
  if (exact) return exact;

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
  return prefixMatches.length === 1 ? prefixMatches[0] : null;
}

export function choiceOptionTextMatches(optionText: string, answerText: string): boolean {
  return matchChoiceOption(answerText, [optionText]) === optionText;
}
