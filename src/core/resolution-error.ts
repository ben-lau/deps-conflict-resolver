import type { AliasMapping, InstallReport, ResolverDiagnostic } from '../types';

interface FailedPreparation {
  aliases: AliasMapping[];
  diagnostics: ResolverDiagnostic[];
  installation: InstallReport | null;
}

export class ResolutionError extends Error {
  constructor(
    readonly diagnostics: ResolverDiagnostic[],
    readonly preparation?: FailedPreparation,
  ) {
    super(
      diagnostics.map((diagnostic) => '[' + diagnostic.code + '] ' + diagnostic.message).join('\n'),
    );
    this.name = 'ResolutionError';
  }
}
