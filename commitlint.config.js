/**
 * Conventional commits, checked rather than trusted.
 *
 * This is not style enforcement. `release-please` reads these messages to
 * decide the next version of the three packages and to write their
 * changelogs, so a subject it cannot parse is a release that silently does
 * not happen — and a `feat` typed as `fix` is a minor published as a patch, on
 * packages every consumer pins by hand.
 *
 * The default rule set is the whole configuration. What is written here is
 * only what this repository decided differently, and each line says why.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    /**
     * A hundred characters, which is the conventional default and is kept
     * deliberately: a subject that does not fit is a subject doing the body's
     * work.
     */
    "header-max-length": [2, "always", 100],

    /**
     * The body wraps where every other document here wraps. `git log` in an
     * eighty-column terminal is where these are read.
     */
    "body-max-line-length": [2, "always", 80],

    /**
     * Scopes are free text on purpose. What a release reads is the *path* a
     * commit touched, never its scope, so an enumerated list would be a second
     * vocabulary to keep in step with the first for no mechanical gain.
     */
    "scope-enum": [0],
  },
};
