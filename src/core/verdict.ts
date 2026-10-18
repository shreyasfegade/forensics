import type { Finding, Severity, Verdict } from './types';

const RANK: Record<Severity, number> = { exposed: 3, caution: 2, info: 1, clear: 0 };

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}

export function buildVerdict(findings: Finding[]): Verdict {
  const top = findings.reduce((m, f) => Math.max(m, RANK[f.severity]), 0);
  const exposed = findings.filter(f => f.severity === 'exposed').length;
  const caution = findings.filter(f => f.severity === 'caution').length;
  if (top === 3) return { level: 'exposed', title: 'Exposed', summary: `${exposed} serious leak${exposed > 1 ? 's' : ''}${caution ? ` and ${caution} more to review` : ''}.` };
  if (top === 2) return { level: 'caution', title: 'Identifying', summary: `${caution} item${caution > 1 ? 's' : ''} can identify a person, device or organisation.` };
  return { level: 'clear', title: 'Clean', summary: findings.length ? 'Nothing identifying. Only routine technical details.' : 'No location, names, hidden payloads or history found.' };
}

export function caseIdFor(sha256: string): string {
  return `${sha256.slice(0, 4)}-${sha256.slice(4, 8)}`.toUpperCase();
}
