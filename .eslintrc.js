// https://docs.expo.dev/guides/using-eslint/
module.exports = {
  extends: ['expo', 'prettier'],
  plugins: ['prettier'],
  env: {
    es2022: true,
    browser: true, // React Native exposes timers/console etc. as globals
  },
  rules: {
    'prettier/prettier': 'warn',
    // Existing codebase has many empty catch blocks used as intentional
    // best-effort guards; flag them but don't block on them yet.
    'no-empty': 'warn',
    'no-unused-vars': 'warn',
    // Advisory react-hooks v7 rules: existing patterns flagged here are
    // tracked for cleanup in later refactor phases — not blocking for now.
    'react-hooks/set-state-in-effect': 'warn',
    'react-hooks/refs': 'warn',
    'react-hooks/purity': 'warn',
    'react-hooks/static-components': 'warn',
  },
  overrides: [
    {
      files: ['app.config.js', '*.config.js', '.eslintrc.js', 'babel.config.js', 'test/**/*.js'],
      env: { node: true },
    },
  ],
  ignorePatterns: ['/dist/*', '/backend/*', '/admin-dashboard/*', '/node_modules/*', '.expo/*'],
};
