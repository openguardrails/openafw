// Single source of truth for the installed afw version. Must match
// packages/afw/package.json. The CLI's --version flag and the update
// checker both read this — they must never disagree.
export const VERSION = '0.11.0'
