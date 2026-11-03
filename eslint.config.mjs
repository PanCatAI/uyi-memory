// Lint config. ESLint lives in tools/lint (its own node_modules) so the published package never carries it.
// Setup once: npm run lint:setup
import { createRequire } from 'node:module';
const require = createRequire(new URL('./tools/lint/package.json', import.meta.url));
const js = require('@eslint/js');
const globals = require('globals');

export default [
  { ignores: ['node_modules/**', 'tools/**', 'dist/**', 'data/**', 'docs/**'] },
  js.configs.recommended,
  { rules: { 'no-unused-vars': 'warn' } },
  { files: ['index.mjs', 'server/**', 'bin/**', 'examples/**', 'lib/**', 'contracts/**', 'scripts/**', 'test/**', '*.mjs'], languageOptions: { globals: globals.node } },
  // Hard rule 6 in AGENTS.md: world time only comes from the injected clock.
  {
    files: ['lib/**'],
    rules: {
      'no-restricted-properties': ['error', { object: 'Date', property: 'now', message: '用 clock.now(saveId)' }],
      'no-restricted-syntax': ['error', { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: '用 clock.now(saveId)' }]
    }
  }
];
