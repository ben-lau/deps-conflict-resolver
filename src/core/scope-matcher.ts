import { posix } from 'node:path';
import type { AliasMapping, ResolutionExplanation, ResolvedOptions } from '../types';

interface PackageInstance {
  name: string;
  path: string;
}
export interface PackageScope {
  path: string;
  name?: string;
}
interface AliasRule {
  aliasName: string;
  dependents: Set<string>;
  excludedPackages: Set<string>;
  pathScoped: boolean;
}
interface PathScopeEntry {
  rule: AliasRule;
  scope: PackageScope;
  pruned?: boolean;
}
interface RuleIndex {
  paths: Map<string, PathScopeEntry[]>;
  rules: AliasRule[];
}
export interface ImporterInfo {
  paths: string[];
  instances: PackageInstance[];
}
interface RuleMatch {
  rule: AliasRule;
  specificity: number;
  scopes: PackageScope[];
  excluded: boolean;
}
interface PrunedMatch {
  specificity: number;
  scopes: PackageScope[];
}
export interface Decision {
  reason: ResolutionExplanation['reason'];
  aliases: string[];
  matchedPaths: string[];
  resolved?: string;
}

export const NO_RULE: Decision = { reason: 'no-rule', aliases: [], matchedPaths: [] };
export const NO_IMPORTER: Decision = { reason: 'no-importer', aliases: [], matchedPaths: [] };
const UNMATCHED: Decision = { reason: 'unmatched', aliases: [], matchedPaths: [] };
function isWithin(path: string, directory: string): boolean {
  return (
    path === directory || path.startsWith(directory.endsWith('/') ? directory : directory + '/')
  );
}

/** An index of positive and negative scopes over normalized importer paths. */
export class ScopeMatcher {
  private readonly rulesMap = new Map<string, RuleIndex>();

  constructor(
    mappings: readonly AliasMapping[],
    options: Pick<ResolvedOptions, 'includeRedirects' | 'excludeRedirects'>,
    expandScope: (path: string) => PackageScope[],
  ) {
    for (const mapping of mappings) {
      const pathScoped = mapping.importerPaths !== undefined;
      const rule: AliasRule = {
        aliasName: mapping.aliasName,
        pathScoped,
        dependents: new Set([
          ...(pathScoped ? [] : mapping.allDependents),
          ...(options.includeRedirects[mapping.originalName] ?? []),
        ]),
        excludedPackages: new Set(options.excludeRedirects[mapping.originalName] ?? []),
      };
      let index = this.rulesMap.get(mapping.originalName);
      if (!index) {
        index = { paths: new Map(), rules: [] };
        this.rulesMap.set(mapping.originalName, index);
      }
      index.rules.push(rule);
      for (const [paths, pruned] of [
        [mapping.importerPaths, false],
        [mapping.excludedImporterPaths, true],
      ] as const) {
        for (const path of paths ?? []) {
          for (const scope of expandScope(path)) {
            const entries = index.paths.get(scope.path) ?? [];
            entries.push({ rule, scope, pruned });
            index.paths.set(scope.path, entries);
          }
        }
      }
    }
  }

  hasRules(packageName: string): boolean {
    return this.rulesMap.has(packageName);
  }

  match(packageName: string, info: ImporterInfo): Decision {
    const index = this.rulesMap.get(packageName);
    if (!index) return NO_RULE;
    const matches = new Map<AliasRule, RuleMatch>();
    const prunedMatches = new Map<AliasRule, PrunedMatch>();
    // Walk ancestors instead of scanning every path in every rule.
    for (const candidate of info.paths) {
      let path = candidate;
      let distance = 0;
      while (true) {
        for (const { rule, scope, pruned } of index.paths.get(path) ?? []) {
          if (pruned) {
            const specificity = -distance;
            let prunedMatch = prunedMatches.get(rule);
            if (!prunedMatch) {
              prunedMatch = { specificity, scopes: [scope] };
              prunedMatches.set(rule, prunedMatch);
            } else if (specificity > prunedMatch.specificity) {
              prunedMatch.specificity = specificity;
              prunedMatch.scopes = [scope];
            } else if (specificity === prunedMatch.specificity) {
              prunedMatch.scopes.push(scope);
            }
            continue;
          }
          let match = matches.get(rule);
          if (!match) {
            match = { rule, specificity: Number.NEGATIVE_INFINITY, scopes: [], excluded: false };
            matches.set(rule, match);
          }
          match.specificity = Math.max(match.specificity, -distance);
          match.scopes.push(scope);
        }
        const parent = posix.dirname(path);
        if (parent === path) break;
        path = parent;
        distance++;
      }
    }

    // Negative boundaries mask only their own rule's ancestor scopes, so a
    // pruned nested package never poisons another alias rule at the same depth.
    for (const [rule, prunedMatch] of prunedMatches) {
      const match = matches.get(rule);
      if (match && prunedMatch.specificity >= match.specificity) {
        matches.delete(rule);
      }
    }

    for (const rule of index.rules) {
      const prunedMatch = prunedMatches.get(rule);
      const included = info.instances.filter(
        (instance) =>
          rule.dependents.has(instance.name) &&
          (!prunedMatch || prunedMatch.scopes.some((scope) => isWithin(instance.path, scope.path))),
      );
      let match = matches.get(rule);
      if (!match && included.length > 0) {
        match = { rule, specificity: Number.NEGATIVE_INFINITY, scopes: [], excluded: false };
        matches.set(rule, match);
      }
      if (!match) continue;
      match.excluded =
        match.scopes.some((scope) => scope.name && rule.excludedPackages.has(scope.name)) ||
        info.instances.some(
          (instance) =>
            rule.excludedPackages.has(instance.name) &&
            (!rule.pathScoped ||
              match.scopes.some(
                (scope) =>
                  isWithin(instance.path, scope.path) || isWithin(scope.path, instance.path),
              ) ||
              included.some(
                (parent) =>
                  isWithin(instance.path, parent.path) || isWithin(parent.path, instance.path),
              )),
        );
    }

    let specificity = Number.NEGATIVE_INFINITY;
    let best: RuleMatch[] = [];
    for (const match of matches.values()) {
      if (match.specificity > specificity) {
        specificity = match.specificity;
        best = [match];
      } else if (match.specificity === specificity) {
        best.push(match);
      }
    }
    if (best.length === 0) return UNMATCHED;
    const aliases = [...new Set(best.map((match) => match.rule.aliasName))].sort();
    const matchedPaths = [
      ...new Set(best.flatMap((match) => match.scopes.map((scope) => scope.path))),
    ].sort();
    if (best.some((match) => match.excluded)) return { reason: 'excluded', aliases, matchedPaths };
    return aliases.length > 1
      ? { reason: 'ambiguous', aliases, matchedPaths }
      : { reason: 'redirected', aliases, matchedPaths, resolved: aliases[0] };
  }
}
