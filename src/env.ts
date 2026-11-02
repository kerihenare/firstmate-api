/**
 * Reading numeric settings from the environment.
 *
 * @remarks
 * A bad value stops the server at startup with a message naming the variable. Quietly using
 * `NaN` is worse: a `NaN` delay makes Node fire a timer after 1 ms, so the refresh loop would
 * rebuild nonstop.
 *
 * @packageDocumentation
 */

/**
 * Read a whole-number setting from the environment.
 *
 * @param name - The environment variable, for example `BEARINGS_API_PORT`.
 * @param fallback - The value when the variable is unset or empty.
 * @param min - The smallest value allowed.
 * @param max - The largest value allowed.
 * @returns The value, or `fallback` when the variable is unset or empty.
 * @throws When the variable is set to anything other than a whole number from `min` to `max`.
 */
export function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= min && value <= max)) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, not "${raw}".`);
  }
  return value;
}
