import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

export default defineConfig([
  globalIgnores(['.next/**', 'out/**', 'node_modules/**', 'src-tauri/**', 'coverage/**']),
  nextVitals,
  nextTs,
  {
    // The React-Compiler-era rules flag the app's intentional load-on-mount
    // effects (load external data, then setState). Keep them visible as
    // warnings rather than blocking the gate on a working pattern.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/immutability': 'warn',
    },
  },
])
