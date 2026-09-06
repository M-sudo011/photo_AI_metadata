const DIGITAL_SOURCE_TYPES = new Map([
  [
    'trainedalgorithmicmedia',
    {
      classification: 'generated',
      label: 'Created using Generative AI',
      explanation: 'The manifest identifies the media as created using a trained AI model.',
    },
  ],
  [
    'compositewithtrainedalgorithmicmedia',
    {
      classification: 'edited',
      label: 'Edited using Generative AI',
      explanation: 'The manifest identifies generative-AI editing, such as inpainting or outpainting.',
    },
  ],
  [
    'compositesynthetic',
    {
      classification: 'edited',
      label: 'Composite including Generative AI elements',
      explanation: 'The manifest identifies a composite with at least one generative-AI element.',
    },
  ],
]);

const AI_TEXT_FIELDS = new Set([
  'description',
  'softwareagent',
  'software',
  'creatortool',
  'generator',
  'model',
  'tool',
]);

const AI_TEXT_PATTERN = /\b(?:generative[\s-]+ai|artificial intelligence|ai[\s-]+generated|generated[\s-]+by[\s-]+ai|created[\s-]+using[\s-]+ai|edited[\s-]+with[\s-]+ai|google generative ai|gemini|imagen|openai|chatgpt|gpt[\s-]*image|dall[\s.·-]*e)\b/i;

const PROVIDER_PATTERNS = [
  { label: 'OpenAI', pattern: /\b(?:openai|chatgpt|gpt[\s-]*image|dall[\s.·-]*e)\b/i },
  { label: 'Google', pattern: /\b(?:google generative ai|gemini|imagen)\b/i },
];

const CLASSIFICATION_PRIORITY = {
  'ai-involved': 1,
  edited: 2,
  generated: 3,
};

export function assessC2paAiDeclaration(c2pa) {
  if (c2pa?.status === 'error') {
    return baseAssessment({
      status: 'unavailable',
      summary: 'C2PA could not be parsed, so an AI declaration could not be assessed.',
    });
  }

  if (c2pa?.status !== 'found' || !c2pa.manifestStore) {
    return baseAssessment({
      status: 'not-assessed',
      summary: 'No C2PA manifest was available to inspect for an AI declaration.',
    });
  }

  const entries = collectLeafEntries(c2pa.manifestStore);
  const signals = [];
  const providers = new Set();
  let classification = null;

  for (const entry of entries) {
    const field = normalizeFieldName(entry.field);
    const text = String(entry.value);

    if (field === 'digitalsourcetype') {
      const sourceType = matchDigitalSourceType(text);
      if (sourceType) {
        signals.push({
          type: 'digital-source-type',
          label: sourceType.label,
          value: text,
          path: entry.path,
          explanation: sourceType.explanation,
        });
        classification = higherPriorityClassification(classification, sourceType.classification);
      }
      continue;
    }

    if (AI_TEXT_FIELDS.has(field) && AI_TEXT_PATTERN.test(text)) {
      signals.push({
        type: 'ai-specific-text',
        label: 'AI system named in provenance',
        value: text,
        path: entry.path,
        explanation: 'An AI-specific tool or declaration appears in a C2PA provenance field.',
      });
      classification = higherPriorityClassification(classification, 'ai-involved');
      for (const provider of detectProviders(text)) providers.add(provider);
    }
  }

  const uniqueSignals = deduplicateSignals(signals).slice(0, 25);
  const context = extractManifestContext(entries);
  const validationWarnings = extractValidationWarnings(c2pa.manifestStore);

  if (uniqueSignals.length === 0) {
    return baseAssessment({
      status: 'not-detected',
      summary: 'A C2PA manifest is present, but no supported AI declaration was found in it.',
      context,
      validationWarnings,
    });
  }

  return baseAssessment({
    status: 'detected',
    classification,
    label: classificationLabel(classification),
    summary: classificationSummary(classification),
    providers: [...providers],
    signals: uniqueSignals,
    context,
    validationWarnings,
  });
}

function baseAssessment(overrides) {
  return {
    status: 'not-assessed',
    classification: null,
    label: null,
    summary: '',
    providers: [],
    signals: [],
    context: [],
    validationWarnings: [],
    limitation: 'This checks declarations carried in C2PA metadata. Metadata can be removed or copied, so absence is not proof that a file is human-made.',
    ...overrides,
  };
}

function collectLeafEntries(value) {
  const entries = [];
  walk(value, [], entries, new WeakSet());
  return entries;
}

function walk(value, segments, entries, seen) {
  if (value === null || value === undefined) return;

  if (typeof value !== 'object') {
    entries.push({
      field: nearestField(segments),
      path: displayPath(segments),
      value,
    });
    return;
  }

  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, [...segments, index], entries, seen));
  } else {
    Object.entries(value).forEach(([key, child]) => walk(child, [...segments, key], entries, seen));
  }

  seen.delete(value);
}

function nearestField(segments) {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (typeof segments[index] === 'string') return segments[index];
  }
  return '';
}

function displayPath(segments) {
  return segments.reduce((path, segment) => {
    if (typeof segment === 'number') return `${path}[${segment}]`;
    return path ? `${path}.${segment}` : segment;
  }, '');
}

function normalizeFieldName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchDigitalSourceType(value) {
  const sourceTypeId = String(value).split(/[\/#:]/).filter(Boolean).at(-1) || '';
  const normalized = sourceTypeId.toLowerCase().replace(/[^a-z]/g, '');
  for (const [knownId, definition] of DIGITAL_SOURCE_TYPES) {
    if (normalized === knownId) return definition;
  }
  return null;
}

function detectProviders(value) {
  return PROVIDER_PATTERNS
    .filter(({ pattern }) => pattern.test(value))
    .map(({ label }) => label);
}

function higherPriorityClassification(current, candidate) {
  if (!current) return candidate;
  return CLASSIFICATION_PRIORITY[candidate] > CLASSIFICATION_PRIORITY[current] ? candidate : current;
}

function classificationLabel(classification) {
  if (classification === 'generated') return 'Generated media declared';
  if (classification === 'edited') return 'Generative-AI editing declared';
  return 'AI involvement declared';
}

function classificationSummary(classification) {
  if (classification === 'generated') {
    return 'The C2PA manifest explicitly declares that the media was created using Generative AI.';
  }
  if (classification === 'edited') {
    return 'The C2PA manifest explicitly declares Generative AI editing or AI-generated elements.';
  }
  return 'The C2PA provenance names an AI system, but the matched fields do not say whether the whole image was generated or only processed by AI.';
}

function deduplicateSignals(signals) {
  const seen = new Set();
  return signals.filter((signal) => {
    const key = `${signal.type}\u0000${signal.path}\u0000${signal.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractManifestContext(entries) {
  const context = [];
  for (const entry of entries) {
    const normalizedPath = normalizeFieldName(entry.path);
    const field = normalizeFieldName(entry.field);

    if (normalizedPath.includes('claimgeneratorinfo') && ['name', 'version'].includes(field)) {
      context.push({ label: field === 'name' ? 'Claim generator' : 'Claim generator version', value: String(entry.value), path: entry.path });
    } else if (normalizedPath.includes('signatureinfo') && ['issuer', 'commonname'].includes(field)) {
      context.push({ label: field === 'issuer' ? 'Signature issuer' : 'Signature common name', value: String(entry.value), path: entry.path });
    }
  }
  return deduplicateContext(context).slice(0, 12);
}

function deduplicateContext(context) {
  const seen = new Set();
  return context.filter((item) => {
    const key = `${item.label}\u0000${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractValidationWarnings(store) {
  const warnings = [];
  visitValidationObjects(store, [], warnings, new WeakSet());
  return deduplicateContext(warnings).slice(0, 20);
}

function visitValidationObjects(value, segments, warnings, seen) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);

  const path = displayPath(segments);
  const pathIsValidationResult = /validation|failure|informational/i.test(path);
  if (
    pathIsValidationResult &&
    typeof value.code === 'string' &&
    /untrusted|invalid|mismatch|malformed|missing|failure|error|unsupported/i.test(value.code)
  ) {
    warnings.push({
      label: value.code,
      value: String(value.explanation || 'Validation or trust warning reported'),
      path,
    });
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => visitValidationObjects(item, [...segments, index], warnings, seen));
  } else {
    Object.entries(value).forEach(([key, child]) => visitValidationObjects(child, [...segments, key], warnings, seen));
  }

  seen.delete(value);
}
