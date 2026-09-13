import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/benchmark/profiles/**',
      '**/.worktrees/**',
      '**/downloads/**',
      '**/webgpu-render-engine/**',
      '**/*.generated.ts',
      'examples/**',
      'node_modules/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      // Enforce maximum depth that blocks (if, for, while, switch) can be nested
      'max-depth': ['warn', 4],
      // Enforce maximum depth that callbacks can be nested
      'max-nested-callbacks': ['warn', 3],
      // Enforce maximum file line length: 500 lines, excluding blanks and comments
      'max-lines': [
        'warn',
        {
          max: 500,
          skipBlankLines: true,
          skipComments: true
        }
      ],
      // Turn off overly aggressive rules on existing codebase
      'preserve-caught-error': 'off',
      'no-control-regex': 'off',
      'no-useless-assignment': 'off',
      'no-unassigned-vars': 'off',
      'no-useless-escape': 'off',
      'require-yield': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ]
    }
  },
  {
    files: ['test/**/*.{ts,js,tsx}', 'benchmark/**/*.{ts,js,tsx}'],
    rules: {
      // Integration test suites and benchmark suites have larger fixture scenarios
      'max-lines': [
        'warn',
        {
          max: 800,
          skipBlankLines: true,
          skipComments: true
        }
      ],
      'max-nested-callbacks': 'off',
      'max-depth': ['warn', 5],
      'no-constant-condition': 'off'
    }
  }
);
