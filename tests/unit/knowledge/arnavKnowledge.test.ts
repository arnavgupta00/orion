import { describe, expect, it } from 'vitest';
import { ARNAV_CAREER_EVIDENCE } from '../../../src/knowledge/arnavCareerEvidence.generated';
import { searchArnavEvidence } from '../../../src/knowledge/arnavKnowledge';

describe('Arnav career evidence', () => {
  it('contains professional proof without private local paths', () => {
    expect(ARNAV_CAREER_EVIDENCE).toContain('1.5M messages / 90 days');
    expect(ARNAV_CAREER_EVIDENCE).toContain('github.com/arnavgupta00');
    expect(ARNAV_CAREER_EVIDENCE).not.toMatch(/\/Users\/[^/]+/);
  });

  it('retrieves relevant evidence sections', () => {
    const evidence = searchArnavEvidence('What did Arnav build at Oracia?');
    expect(evidence).toContain('Oracia');
    expect(evidence).toMatch(/LangGraph|realtors|messages/);
  });
});
