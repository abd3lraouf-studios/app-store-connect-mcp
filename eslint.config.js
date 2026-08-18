// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Type-aware linting is the point of this config.
 *
 * For a server whose whole job is calling an external HTTP API, the rules that
 * catch real defects — no-floating-promises, no-misused-promises,
 * await-thenable — need type information. A dropped promise in a tool handler
 * does not throw; it resolves into nothing and the call appears to hang, which
 * is among the hardest MCP failures to diagnose from the client side.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'spec/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // Apple's payloads are genuinely unknown at compile time; narrowing every
      // access would add noise without adding safety.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      'no-console': 'off',
    },
  },
  {
    // Scripts are plain ESM run by Node, outside the tsconfig project.
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { projectService: false, project: null },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        __dirname: 'readonly',
      },
    },
  }
);
