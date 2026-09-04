// Flat ESLint config (ESLint 9). Prettier must come LAST so it disables the
// stylistic rules it supersedes — formatting is Prettier's job, linting is
// ours.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // pages deliberately export shared helpers/constants next to the page
      // component (MembersPage.MemberFormFields, etc.) — that is the
      // documented pattern in the README, not a fast-refresh problem.
      'react-refresh/only-export-components': 'off',
      // the codebase intentionally uses `any` for free-form backend payloads
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  prettier
);
