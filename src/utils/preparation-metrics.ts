/** Cumulative measurements for a resolver. Stage durations can overlap. */
export interface PreparationTimings {
  milliseconds: {
    environment: number;
    lockWait: number;
    analysis: number;
    graph: number;
    registry: number;
    install: number;
    verify: number;
    planValidation: number;
  };
  counts: {
    analysisPasses: number;
    registryRequests: number;
    manifestReads: number;
    lookupProbes: number;
    realpaths: number;
    planHits: number;
    planMisses: number;
  };
}

type Phase = keyof PreparationTimings['milliseconds'];

export class PreparationMetrics {
  readonly milliseconds: PreparationTimings['milliseconds'] = {
    environment: 0,
    lockWait: 0,
    analysis: 0,
    graph: 0,
    registry: 0,
    install: 0,
    verify: 0,
    planValidation: 0,
  };
  readonly counts: PreparationTimings['counts'] = {
    analysisPasses: 0,
    registryRequests: 0,
    manifestReads: 0,
    lookupProbes: 0,
    realpaths: 0,
    planHits: 0,
    planMisses: 0,
  };

  measure<T>(phase: Phase, task: () => T): T {
    const start = performance.now();
    try {
      return task();
    } finally {
      this.milliseconds[phase] += performance.now() - start;
    }
  }

  async measureAsync<T>(phase: Phase, task: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await task();
    } finally {
      this.milliseconds[phase] += performance.now() - start;
    }
  }

  snapshot(): PreparationTimings {
    return { milliseconds: { ...this.milliseconds }, counts: { ...this.counts } };
  }

  add(other: PreparationMetrics): void {
    for (const phase of Object.keys(other.milliseconds) as Phase[])
      this.milliseconds[phase] += other.milliseconds[phase];
    for (const count of Object.keys(other.counts) as Array<keyof PreparationTimings['counts']>)
      this.counts[count] += other.counts[count];
  }
}
