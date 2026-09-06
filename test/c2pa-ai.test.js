import test from 'node:test';
import assert from 'node:assert/strict';
import { assessC2paAiDeclaration } from '../src/c2pa-ai.js';

function c2paWith(manifestStore) {
  return { status: 'found', manifestStore };
}

test('detects Gemini-style generated-media declarations', () => {
  const result = assessC2paAiDeclaration(c2paWith({
    active_manifest: 'urn:c2pa:example',
    manifests: {
      'urn:c2pa:example': {
        claim_generator_info: [{ name: 'Google C2PA Core Generator Library' }],
        assertions: [{
          label: 'c2pa.actions.v2',
          data: {
            actions: [{
              action: 'c2pa.resized',
              description: 'Resized by Google Generative AI.',
              digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
            }],
          },
        }],
      },
    },
  }));

  assert.equal(result.status, 'detected');
  assert.equal(result.classification, 'generated');
  assert.deepEqual(result.providers, ['Google']);
  assert.equal(result.signals.some(({ type }) => type === 'digital-source-type'), true);
});

test('distinguishes generative-AI editing from full generation', () => {
  const result = assessC2paAiDeclaration(c2paWith({
    manifests: {
      active: {
        assertions: [{ data: { actions: [{
          digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia',
        }] } }],
      },
    },
  }));

  assert.equal(result.status, 'detected');
  assert.equal(result.classification, 'edited');
});

test('does not treat a generic C2PA claim generator as an AI declaration', () => {
  const result = assessC2paAiDeclaration(c2paWith({
    validation_state: 'Valid',
    manifests: {
      active: {
        claim_generator_info: [{ name: 'Google C2PA Core Generator Library' }],
        assertions: [{ data: { actions: [{ action: 'c2pa.created' }] } }],
      },
    },
  }));

  assert.equal(result.status, 'not-detected');
  assert.equal(result.context[0].value, 'Google C2PA Core Generator Library');
});

test('reports AI involvement when provenance names an AI system without a source type', () => {
  const result = assessC2paAiDeclaration(c2paWith({
    manifests: {
      active: {
        assertions: [{ data: { actions: [{ description: 'Opened by Google Generative AI.' }] } }],
      },
    },
  }));

  assert.equal(result.status, 'detected');
  assert.equal(result.classification, 'ai-involved');
  assert.deepEqual(result.providers, ['Google']);
});

test('does not interpret ordinary camera C2PA as AI', () => {
  const result = assessC2paAiDeclaration(c2paWith({
    manifests: {
      active: {
        assertions: [{ data: { actions: [{
          action: 'c2pa.created',
          digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture',
          description: 'Captured by a camera.',
        }] } }],
      },
    },
  }));

  assert.equal(result.status, 'not-detected');
});

test('reports when no C2PA manifest can be assessed', () => {
  const result = assessC2paAiDeclaration({ status: 'not-found', manifestStore: null });
  assert.equal(result.status, 'not-assessed');
});
