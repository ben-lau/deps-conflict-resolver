/** A problem the caller can inspect without parsing log messages. */
export interface ResolverDiagnostic {
  code:
    | 'PROJECT_STATE_CHANGED'
    | 'DEPENDENCY_NOT_FOUND'
    | 'PEER_NOT_DECLARED'
    | 'PEER_NOT_INSTALLED'
    | 'PEER_PROVIDER_MISMATCH'
    | 'REGISTRY_ERROR'
    | 'NO_MATCHING_VERSION'
    | 'OFFLINE_ALIAS_MISSING'
    | 'ALIAS_INSTALL_FAILED'
    | 'ALIAS_NOT_INSTALLED'
    | 'ALIAS_PEER_UNSATISFIED'
    | 'ALIAS_METADATA_UNAVAILABLE'
    | 'TRANSITIVE_PEER_CONFLICT'
    | 'SHARED_PEER_CONTEXT'
    | 'AMBIGUOUS_ALIAS_SCOPE'
    | 'AMBIGUOUS_IMPORTER';
  severity: 'warning' | 'error';
  message: string;
  packageName: string;
  requestedBy?: string[];
  aliases?: string[];
  importerPaths?: string[];
}

/** Why a particular request was redirected or left to the normal resolver. */
export interface ResolutionExplanation {
  request: string;
  importer?: string;
  resolved: string | null;
  reason:
    | 'redirected'
    | 'excluded'
    | 'ambiguous'
    | 'unmatched'
    | 'no-rule'
    | 'no-importer'
    | 'inactive'
    | 'hook';
  aliases: string[];
  matchedPaths: string[];
}
