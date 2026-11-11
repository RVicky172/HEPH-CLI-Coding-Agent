// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // ── Dependency Inversion, enforced by the linter ──────────────────────────
    // The core (application layer) may only depend on interfaces.
    // Infrastructure and presentation libraries are injected via container.ts.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'child_process', 'os'],
              message: 'core/ must not do I/O directly. Depend on an interface instead.',
            },
            {
              group: ['openai', 'execa', 'chalk', 'ora', 'commander', '@inquirer/*'],
              message: 'core/ must not import infrastructure/UI libraries (Dependency Inversion).',
            },
            {
              group: ['**/cli/**', '**/ui/**', '**/container'],
              message: 'core/ must not depend on outer layers.',
            },
          ],
        },
      ],
    },
  },
);
