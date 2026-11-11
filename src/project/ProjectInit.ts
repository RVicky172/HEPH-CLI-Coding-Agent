import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, HEPH_DIR } from '../config/paths.js';

export interface InitResult {
  readonly created: string[];
  readonly skipped: string[];
  /** Commands detected from package.json, shown to the user. */
  readonly detected: string[];
}

/** package.json scripts that are useful for an agent to know about, in display order. */
const USEFUL_SCRIPTS = ['test', 'lint', 'typecheck', 'check', 'build', 'format', 'dev', 'start'];

/**
 * `heph init`: prepare a project for heph.
 *   HEPH.md                 rules for the agent (pre-filled from package.json)
 *   .heph/config.json       project settings (can only make heph STRICTER)
 *   .heph/.gitignore        keeps heph's logs out of git
 *
 * Never overwrites existing files unless `force` is set.
 */
export function initProject(root: string, options: { force?: boolean } = {}): InitResult {
  const created: string[] = [];
  const skipped: string[] = [];
  const scripts = detectScripts(root);
  const detected = Object.keys(scripts).map((name) => `npm run ${name}`);

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    if (fs.existsSync(full) && !options.force) {
      skipped.push(relative);
      return;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    created.push(relative);
  };

  write('HEPH.md', hephMdTemplate(path.basename(root), scripts));
  write(
    path.join(HEPH_DIR, CONFIG_FILE),
    `${JSON.stringify(
      {
        permissions: {
          // A project may only make heph STRICTER: e.g. "read-only", or deny rules.
          deny: ['run_command:git push*', 'run_command:npm publish*'],
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    path.join(HEPH_DIR, '.gitignore'),
    '# heph runtime data (stays on your machine)\nlogs/\nsessions/\n',
  );

  return { created, skipped, detected };
}

function detectScripts(root: string): Record<string, string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    return Object.fromEntries(
      USEFUL_SCRIPTS.filter((name) => typeof scripts[name] === 'string').map((name) => [
        name,
        scripts[name] as string,
      ]),
    );
  } catch {
    return {};
  }
}

function hephMdTemplate(projectName: string, scripts: Record<string, string>): string {
  const commands = Object.entries(scripts).map(
    ([name, cmd]) =>
      `- \`npm run ${name}\`${name === 'test' ? ' (run after every change)' : ''}: \`${cmd}\``,
  );
  return [
    `# ${projectName}: instructions for heph`,
    '',
    'heph reads this file at startup and follows it. Keep it short and specific.',
    '',
    '## Project',
    '- What this project is, in one or two sentences.',
    '- Main folders: e.g. `src/` (code), `tests/` (tests).',
    '',
    '## Commands',
    ...(commands.length
      ? commands
      : ['- How to run the tests: e.g. `npm test`', '- How to build: e.g. `npm run build`']),
    '',
    '## Conventions',
    '- Code style rules the agent must follow (naming, formatting, patterns).',
    '- Files or folders the agent must never change (e.g. generated code).',
    '',
  ].join('\n');
}
