/** Verified outcomes of an installation attempt. */
export interface InstallReport {
  success: boolean;
  installed: string[];
  reused: string[];
  failed: string[];
  errors: string[];
}
