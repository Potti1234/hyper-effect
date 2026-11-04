import tseslint from 'typescript-eslint'

/* Lint for the TypeScript sources (npm run lint). Type checking stays with
   tsc (npm run typecheck); these are the rules tsc does not cover. */
export default tseslint.config(
  // src/ui holds creaseui registry copies, linted in creaseui itself.
  { ignores: ['**/node_modules/**', '**/dist/**', '**/public/**', '**/src/ui/**', 'output/**'] },
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/test/**/*.ts', 'apps/*/src/**/*.ts', 'apps/*/test/**/*.ts', 'examples/*/src/**/*.ts', 'examples/*/test/**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      // A warning while the existing assertions are replaced by Schema
      // decoding or narrowing; new code should not add any.
      '@typescript-eslint/consistent-type-assertions': ['warn', { assertionStyle: 'never' }],
      // Effect's tagged errors without fields are declared with `<{}>`.
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
