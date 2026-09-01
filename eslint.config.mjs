import {defineConfig, globalIgnores} from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      '@next/next/no-img-element': 'off',
      'react-hooks/globals': 'off',
      'react-hooks/set-state-in-effect': 'off'
    }
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off'
    }
  },
  globalIgnores([
    '.data/**',
    '.history/**',
    '.next/**',
    '.vinext/**',
    '.wrangler/**',
    'build/**',
    'dist/**',
    'next-env.d.ts',
    'out/**',
    'public/vendor/**'
  ])
]);

export default eslintConfig;
