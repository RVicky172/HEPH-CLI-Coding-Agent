/**
 * Recognises commands that can destroy data or reach outside the project.
 * A match never blocks by itself. It makes heph ALWAYS ask (even in full-auto
 * or with an allow rule) and shows the warning in red.
 *
 * This is a safety net, not a sandbox: a determined command can always be
 * disguised. That's why `ask` is the default mode.
 */
const RULES: readonly { readonly pattern: RegExp; readonly warning: string }[] = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, warning: 'deletes files (rm -r/-f)' },
  {
    pattern: /\b(Remove-Item|rmdir|rd|del|erase)\b[^|;&]*\s-(Recurse|Force)\b/i,
    warning: 'deletes files recursively',
  },
  { pattern: /\b(rd|rmdir|del)\s+\/[sq]\b/i, warning: 'deletes files recursively' },
  {
    pattern: /\bgit\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/i,
    warning: 'force-pushes and can overwrite remote history',
  },
  { pattern: /\bgit\s+push\b/i, warning: 'publishes commits to a remote repository' },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    warning: 'throws away uncommitted changes (git reset --hard)',
  },
  { pattern: /\bgit\s+clean\b[^|;&]*-[a-z]*f/i, warning: 'deletes untracked files (git clean -f)' },
  {
    pattern: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i,
    warning: 'discards all local changes',
  },
  { pattern: /\bgit\s+branch\s+-D\b/, warning: 'force-deletes a branch' },
  {
    pattern:
      /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|powershell|pwsh)\b/i,
    warning: 'downloads and executes code from the internet',
  },
  {
    pattern: /\b(iex|Invoke-Expression)\b/i,
    warning: 'executes a dynamically built command (Invoke-Expression)',
  },
  {
    pattern: /\bsudo\b|\bStart-Process\b[^\n]*-Verb\s+RunAs/i,
    warning: 'runs with administrator rights',
  },
  { pattern: /\b(mkfs|format|diskpart|fdisk)\b|\bdd\s+if=/i, warning: 'can erase a disk' },
  {
    pattern: /\b(shutdown|reboot|Stop-Computer|Restart-Computer)\b/i,
    warning: 'shuts down or restarts the computer',
  },
  {
    pattern: /\bchmod\s+-R\b|\bchown\s+-R\b|\bicacls\b[^\n]*\/grant/i,
    warning: 'changes permissions recursively',
  },
  {
    pattern: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i,
    warning: 'publishes a package publicly',
  },
  { pattern: /\bdocker\s+(system|volume|image)\s+prune\b/i, warning: 'deletes Docker data' },
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, warning: 'deletes database data' },
  {
    // Lookahead instead of \b: there is no "word boundary" between "~" and "/".
    pattern:
      /(^|[\s;&|"'])(~|\$HOME|\$env:USERPROFILE|%USERPROFILE%|\/etc|C:\\Windows)(?=[\\/\s"']|$)/i,
    warning: 'touches files outside the project',
  },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, warning: 'fork bomb' },
];

export function detectDangers(command: string): string[] {
  const warnings = RULES.filter((r) => r.pattern.test(command)).map((r) => r.warning);
  // A force push matches both git push rules: keep only the more specific warning.
  if (warnings.some((w) => w.startsWith('force-pushes'))) {
    return warnings.filter((w) => !w.startsWith('publishes commits'));
  }
  return [...new Set(warnings)];
}
