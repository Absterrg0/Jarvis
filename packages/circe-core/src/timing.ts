/**
 * Monotonic marks for one Circe turn. Pure and clock-injected so pipeline
 * timing stays testable: production passes the ambient clock, tests pass a
 * controlled one. First write wins per mark, so a repeated boundary (for
 * example a retried interpretation) keeps the original instant instead of
 * silently moving it. Missing marks read as undefined, never zero, so an
 * absent boundary cannot masquerade as instant.
 */

export type CirceTurnTiming = {
  /** Record the current instant under name, keeping the first write. */
  readonly mark: (name: string) => void;
  /** Milliseconds from mark `from` to mark `to`, or undefined when absent. */
  readonly elapsed: (from: string, to: string) => number | undefined;
  /** A copy of every recorded mark. */
  readonly record: () => Record<string, number>;
};

export function createCirceTurnTiming(
  now: () => number = () => performance.now(),
): CirceTurnTiming {
  const marks = new Map<string, number>();
  return {
    mark: (name: string): void => {
      if (!marks.has(name)) marks.set(name, now());
    },
    elapsed: (from: string, to: string): number | undefined => {
      const start = marks.get(from);
      const end = marks.get(to);
      return start === undefined || end === undefined ? undefined : end - start;
    },
    record: (): Record<string, number> => Object.fromEntries(marks),
  };
}
