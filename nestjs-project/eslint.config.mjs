// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // `jest.Mocked<T>` types method properties as plain class methods, which
    // `unbound-method` flags as unsafe `this` scoping when referenced bare in
    // `expect(mock.method).toHaveBeenCalledWith(...)`. This is a well-known
    // false positive with Jest mocks (the "instance" is a mock, not a real
    // object depending on `this`), so the rule is disabled for test files.
    files: ['**/*.spec.ts', '**/*.integration-spec.ts', '**/*.e2e-spec.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // supertest types `Response.body` as `any` by design (it cannot know the
    // JSON shape of an arbitrary endpoint), so every `res.body.field` access
    // in e2e assertions trips these rules without indicating a real bug.
    // Scoped to e2e specs only — production code and mocked-fixture unit/
    // integration tests keep full `any`-safety checking.
    files: ['**/*.e2e-spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);
