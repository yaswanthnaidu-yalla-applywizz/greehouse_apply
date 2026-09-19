import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

function htmlTemplatePlugin(): Plugin {
  return {
    name: 'html-template-plugin',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'index.html',
        source: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ApplyWizz Greenhouse Operator Dashboard</title>
    <link rel="stylesheet" href="/dashboard.css" />
  </head>
  <body class="bg-gray-900 text-gray-100 min-h-screen">
    <div id="root"></div>
    <script type="module" src="/assets/index.js"></script>
  </body>
</html>`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), htmlTemplatePlugin()],
  base: '/',
  build: {
    outDir: 'dist/dashboard',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'dashboard/index.tsx'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
