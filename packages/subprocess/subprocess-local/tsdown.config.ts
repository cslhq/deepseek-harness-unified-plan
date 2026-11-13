import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    runner: 'lib/types/bin.js',
    output: 'lib/types/output.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // The runner carries its diagnostic helpers itself. A published package has no
  // src/, and Node refuses to strip types under node_modules, so a bare
  // `@deepseek-ai/dsh-win32-process/src/*.ts` import would only ever work in this
  // workspace. alwaysBundle inlines that subpath while leaving the package root,
  // and its published lib/index.js, external.
  deps: {
    alwaysBundle: [/^@deepseek-ai\/dsh-win32-process\/src\//],
  },
})
