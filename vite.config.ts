import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

function htmlTemplatePlugin(): Plugin {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss: https://dpwhgwdsfqzfwxlwvchp.supabase.co https://openrouter.ai;">`;

  return {
    name: 'html-template-plugin',
    generateBundle() {
      // 1. Operator Dashboard (index.html)
      this.emitFile({
        type: 'asset',
        fileName: 'index.html',
        source: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${cspMeta}
    <link rel="icon" type="image/webp" href="/logo.webp" />
    <link rel="apple-touch-icon" href="/logo.webp" />
    <title>ApplyWizz Greenhouse Operator Dashboard</title>
    <link rel="stylesheet" href="/dashboard.css" />
  </head>
  <body class="bg-gray-900 text-gray-100 min-h-screen">
    <div id="root"></div>
    <script type="module" src="/assets/index.js"></script>
  </body>
</html>`,
      });

      // 2. Admin Dashboard (admin/index.html)
      this.emitFile({
        type: 'asset',
        fileName: 'admin/index.html',
        source: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${cspMeta}
    <link rel="icon" type="image/webp" href="/logo.webp" />
    <link rel="apple-touch-icon" href="/logo.webp" />
    <title>Apply Wizz — Admin</title>
    <link rel="stylesheet" href="/dashboard.css" />
  </head>
  <body class="bg-[#FFF5EB] text-[#1A1A2E] min-h-screen">
    <div id="root"></div>
    <script type="module" src="/assets/admin.js"></script>
  </body>
</html>`,
      });

      // 3. Developer Dashboard (dev/index.html)
      this.emitFile({
        type: 'asset',
        fileName: 'dev/index.html',
        source: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${cspMeta}
    <link rel="icon" type="image/webp" href="/logo.webp" />
    <link rel="apple-touch-icon" href="/logo.webp" />
    <title>Apply Wizz — Dev</title>
    <link rel="stylesheet" href="/dashboard.css" />
  </head>
  <body class="bg-[#FFF5EB] text-[#1A1A2E] min-h-screen">
    <div id="root"></div>
    <script type="module" src="/assets/dev.js"></script>
  </body>
</html>`,
      });

      // 4. Manager Dashboard (manager/index.html)
      this.emitFile({
        type: 'asset',
        fileName: 'manager/index.html',
        source: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${cspMeta}
    <link rel="icon" type="image/webp" href="/logo.webp" />
    <link rel="apple-touch-icon" href="/logo.webp" />
    <title>Apply Wizz — Manager</title>
    <link rel="stylesheet" href="/dashboard.css" />
  </head>
  <body class="bg-[#FFF5EB] text-[#1A1A2E] min-h-screen">
    <div id="root"></div>
    <script type="module" src="/assets/manager.js"></script>
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
    outDir: 'dist/client',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'dashboard/index.tsx'),
        admin: path.resolve(__dirname, 'dashboard/src/main-admin.tsx'),
        dev: path.resolve(__dirname, 'dashboard/src/main-dev.tsx'),
        manager: path.resolve(__dirname, 'dashboard/src/main-manager.tsx'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/chunk-[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
