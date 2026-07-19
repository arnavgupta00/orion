import { ARNAV_CAREER_EVIDENCE, ARNAV_EVIDENCE_UPDATED } from './arnavCareerEvidence.generated';

export const ARNAV_PROFILE_CONTEXT = `
ARNAV GUPTA — CANONICAL PROFESSIONAL CONTEXT
- Core thesis: production AI, edge systems, and startup execution.
- VP of Engineering at Oracia and a system architect. The strongest evidence covers production agent orchestration, realtime infrastructure, shipping velocity, and team leadership.
- Oracia proof: 9 LangGraph state machines; $10–15K MRR; 1.5M messages in 90 days; 100+ paying realtors across the US and Brazil; a sub-200ms architecture target; and a reported team of 10.
- Upwork: Senior AI Engineer / AI Agent Architect; Top Rated Plus and 100% Job Success context. Treat full contract detail as medium-confidence unless the evidence tool supplies stronger support.
- Ascending Version WebRTC evidence: 20,000+ concurrent users, 99.9% uptime, sub-100ms latency, and 40% infrastructure cost reduction. Confidence: medium.
- Seekho evidence: 50+ educators, 1,000+ students, and 70% MAU. Confidence: medium.
- Core projects include Oracia, Orion/voice-agent, customgpt and GAIA benchmark work, model training/evaluation systems, realtime WebRTC systems, and product/ad-operations stacks.
- Public profiles: GitHub https://github.com/arnavgupta00, LinkedIn https://www.linkedin.com/in/arnavgupta3035/, Upwork https://www.upwork.com/freelancers/~015ec6270deed021f6.
- Never inflate confidence. Describe medium-confidence and user-asserted metrics as such, and use arnav_evidence for exact proof or caveats.
- Evidence snapshot updated ${ARNAV_EVIDENCE_UPDATED}.
`.trim();

interface EvidenceSection {
  heading: string;
  body: string;
}

const SECTIONS = splitSections(ARNAV_CAREER_EVIDENCE);

export function searchArnavEvidence(query: string, maxSections = 5): string {
  const terms = significantTerms(query);
  const ranked = SECTIONS.map((section, index) => ({
    section,
    index,
    score: scoreSection(section, terms),
  }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .filter((item, index) => item.score > 0 || index < 2)
    .slice(0, Math.max(1, Math.min(maxSections, 6)));

  const selected = ranked.map(({ section }) => `${section.heading}\n${section.body}`.trim()).join('\n\n');
  return selected.slice(0, 12_000);
}

function splitSections(markdown: string): EvidenceSection[] {
  const sections: EvidenceSection[] = [];
  let heading = '# Career Evidence Pack: Arnav Gupta';
  let lines: string[] = [];
  for (const line of markdown.split('\n')) {
    if (/^#{1,3}\s/.test(line)) {
      if (lines.length) sections.push({ heading, body: lines.join('\n').trim() });
      heading = line;
      lines = [];
    } else {
      lines.push(line);
    }
  }
  if (lines.length) sections.push({ heading, body: lines.join('\n').trim() });
  return sections;
}

function significantTerms(query: string): string[] {
  const stop = new Set(['about', 'after', 'arnav', 'could', 'from', 'have', 'tell', 'that', 'their', 'there', 'these', 'they', 'this', 'what', 'when', 'where', 'which', 'with', 'would', 'your']);
  return [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9+.-]{2,}/g) ?? [])]
    .filter((term) => !stop.has(term));
}

function scoreSection(section: EvidenceSection, terms: string[]): number {
  const heading = section.heading.toLowerCase();
  const body = section.body.toLowerCase();
  return terms.reduce((score, term) => score + (heading.includes(term) ? 8 : 0) + (body.includes(term) ? 2 : 0), 0);
}
