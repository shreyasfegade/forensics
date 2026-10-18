import { analyze } from '../src/core/analyze';
import { BytesSource } from '../src/util/source';

export function run(bytes: Uint8Array, name: string) {
  return analyze(new BytesSource(bytes), { name });
}

export function tags(report: Awaited<ReturnType<typeof run>>): string[] {
  return report.findings.map(f => f.tag);
}
