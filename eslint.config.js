import tseslint from 'typescript-eslint';

// Security rails per CLAUDE.md rule 4: never execute dynamic code.
export default tseslint.config(
  { ignores: ['out/', 'node_modules/', 'dist/', 'coverage/'] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-modules': ['error', { name: 'vm', message: 'Dynamic code execution is forbidden (CLAUDE.md rule 4).' }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*vm*', 'node:vm'],
              message: 'Dynamic code execution is forbidden (CLAUDE.md rule 4).',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'WebContents',
          property: 'loadURL',
          message: 'Use loadFile with bundled assets or an allowlisted dev URL only.',
        },
        {
          object: 'process',
          property: 'dlopen',
          message: 'Loading native modules dynamically is restricted.',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'off', // needed sparingly at electron API seams; reviewed manually
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'src/main/security/**'],
    rules: {
      // Tests may assert via any-typed mocks without tripping strict rules.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  }
);
