import type { ResolverDiagnostic } from '../types';

export class ResolutionError extends Error {
  constructor(readonly diagnostics: ResolverDiagnostic[]) {
    super(
      diagnostics.map((diagnostic) => '[' + diagnostic.code + '] ' + diagnostic.message).join('\n'),
    );
    this.name = 'ResolutionError';
  }
}
