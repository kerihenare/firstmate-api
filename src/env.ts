/**
 * The server's settings, read once from the environment and checked with Zod.
 *
 * @remarks
 * Every setting the server reads comes from here, so nothing else touches `process.env`. An
 * empty or blank variable counts as unset. A bad value stops the server at startup with a
 * message naming each variable that is wrong. Quietly carrying on is worse: a `NaN` delay, for
 * one, makes Node fire a timer after 1 ms, so the refresh loop would rebuild nonstop.
 *
 * `.env.example` lists every variable with its default.
 *
 * @packageDocumentation
 */
import path from "node:path";

import { z } from "zod";

/**
 * The Firstmate home when `FM_HOME` is unset: two levels above this repo, which assumes the
 * repo sits inside a Firstmate home.
 */
const DEFAULT_FM_HOME = path.resolve(import.meta.dirname, "..", "..", "..");

/** The checked settings. */
export interface Settings {
  /** Host names the server answers to, lowercased. Requests for any other Host get 421. */
  allowedHosts: string[];
  /** The bearer token every `/api/v1/*` request must send, or `""` to leave the API open. */
  apiKey: string;
  /** The Firstmate home directory, as an absolute path. */
  fmHome: string;
  /** The command that runs the GitHub CLI. */
  ghBin: string;
  /** The command that runs git. */
  gitBin: string;
  /** The interface to listen on. */
  host: string;
  /** The base URL for ticket links, or `""` when Linear is not configured. */
  linearBase: string;
  /** The Linear team keys to recognise, uppercased. Each is plain letters and digits. */
  linearTeams: string[];
  /** The command that runs no-mistakes. */
  noMistakesBin: string;
  /** The port to listen on. */
  port: number;
  /** Seconds between scheduled rebuilds. */
  refreshSeconds: number;
}

/**
 * Wrap a schema so that an unset, empty or blank variable takes `fallback`.
 *
 * @typeParam T - The setting's type.
 * @param schema - Checks a set value.
 * @param fallback - The value when the variable is unset or blank.
 */
function setting<T>(schema: z.ZodType<T, string>, fallback: T): z.ZodType<T, unknown> {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional().transform((value) => value ?? fallback),
  );
}

/** A comma-separated list, trimmed, with empty entries dropped. */
const commaList = z
  .string()
  .transform((text) => text.split(",").map((item) => item.trim()))
  .transform((items) => items.filter(Boolean));

/** A command name or path, trimmed. */
const command = z.string().trim();

/**
 * A whole number from `min` to `max`, written in plain digits.
 *
 * @param min - The smallest value allowed.
 * @param max - The largest value allowed.
 */
function wholeNumber(min: number, max: number): z.ZodType<number, string> {
  const error = `must be a whole number from ${min} to ${max}`;

  return z
    .string()
    .trim()
    .regex(/^\d+$/, { error })
    .transform(Number)
    .pipe(z.int({ error }).min(min, { error }).max(max, { error }));
}

/** The environment variables this server reads. Any others are ignored. */
const EnvSchema = z.object({
  BEARINGS_API_ALLOWED_HOSTS: setting(
    commaList.transform((hosts) => hosts.map((host) => host.toLowerCase())),
    ["localhost", "127.0.0.1", "[::1]"],
  ),
  BEARINGS_API_HOST: setting(z.string().trim(), "127.0.0.1"),
  BEARINGS_API_KEY: setting(z.string(), ""),
  BEARINGS_API_PORT: setting(wholeNumber(1, 65_535), 4748),
  BEARINGS_API_REFRESH: setting(wholeNumber(10, 86_400), 300),
  BEARINGS_GH_BIN: setting(command, "gh"),
  BEARINGS_GIT_BIN: setting(command, "git"),
  BEARINGS_LINEAR_BASE: setting(
    z.url({ error: "must be an http or https URL", protocol: /^https?$/ }),
    "",
  ),
  BEARINGS_LINEAR_TEAMS: setting(
    commaList
      .transform((teams) => teams.map((team) => team.toUpperCase()))
      // Team keys go into a regular expression, so only plain letters and digits are safe.
      .pipe(z.array(z.string().regex(/^[A-Z0-9]+$/, { error: "must be letters and digits" }))),
    [],
  ),
  BEARINGS_NO_MISTAKES_BIN: setting(command, "no-mistakes"),
  FM_HOME: setting(
    z
      .string()
      .trim()
      .transform((dir) => path.resolve(dir)),
    DEFAULT_FM_HOME,
  ),
});

/**
 * Check a set of environment variables and turn them into {@link Settings}.
 *
 * @param env - The environment, usually `process.env`.
 * @returns The settings.
 * @throws When any variable is set to a bad value. The message names every one that is wrong.
 */
export function parseSettings(env: Record<string, string | undefined>): Settings {
  const result = EnvSchema.safeParse(env);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
    throw new Error(`Bad settings: ${problems.join("; ")}.`);
  }

  const vars = result.data;

  return {
    allowedHosts: vars.BEARINGS_API_ALLOWED_HOSTS,
    apiKey: vars.BEARINGS_API_KEY,
    fmHome: vars.FM_HOME,
    ghBin: vars.BEARINGS_GH_BIN,
    gitBin: vars.BEARINGS_GIT_BIN,
    host: vars.BEARINGS_API_HOST,
    linearBase: vars.BEARINGS_LINEAR_BASE,
    linearTeams: vars.BEARINGS_LINEAR_TEAMS,
    noMistakesBin: vars.BEARINGS_NO_MISTAKES_BIN,
    port: vars.BEARINGS_API_PORT,
    refreshSeconds: vars.BEARINGS_API_REFRESH,
  };
}

/**
 * The settings from `process.env`.
 *
 * @throws At import time, when any variable is set to a bad value (see {@link parseSettings}).
 */
export const settings: Settings = parseSettings(process.env);
