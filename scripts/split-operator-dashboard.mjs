import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('dashboard/public/index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const openTag = '<script type="text/babel">';
const start = html.indexOf(openTag);
if (start < 0) throw new Error('babel block not found');
const babelStart = start + openTag.length;
const end = html.lastIndexOf('</script>');
const babel = html.slice(babelStart, end);
const lines = babel.split(/\r?\n/);

const authStart = lines.findIndex((l) => l.includes('function formatQrCodeSrc'));
const helperMarker = lines.findIndex(
  (l, i) => i > authStart && l.includes('// Per-candidate queue helpers')
);
const authEnd = helperMarker - 1;
if (authStart < 0 || helperMarker < 0 || authEnd < authStart) {
  throw new Error(`markers authStart=${authStart} helperMarker=${helperMarker}`);
}

const authLines = lines.slice(authStart, authEnd + 1);
const operatorLines = [...lines.slice(0, authStart), ...lines.slice(authEnd + 1)];
let operator = operatorLines.join('\n');
operator = operator.replace(
  /\s*const root = ReactDOM\.createRoot\(document\.getElementById\('root'\)\);\s*\n\s*root\.render\(<App \/>\);\s*$/,
  ''
);
operator += `
    window.__applywizzOperatorApp = App;
    if (typeof window.__applywizzOnOperatorLoaded === 'function') {
      window.__applywizzOnOperatorLoaded();
    }
`;

const outPath = path.resolve('dashboard/public/operator-app.jsx');
fs.writeFileSync(outPath, operator.replace(/^\n/, ''), 'utf8');

const authBootstrap = `    const { useState, useEffect } = React;

    function loadOperatorApp(onReady) {
      if (window.__applywizzOperatorApp) {
        onReady();
        return;
      }
      window.__applywizzOnOperatorLoaded = onReady;
      if (document.querySelector('script[data-applywizz-operator-app]')) return;
      const s = document.createElement('script');
      s.type = 'text/babel';
      s.src = '/operator-app.jsx';
      s.dataset.applywizzOperatorApp = '1';
      s.dataset.presets = 'react';
      document.body.appendChild(s);
      if (window.Babel && typeof Babel.transformScriptTags === 'function') {
        Babel.transformScriptTags();
      }
    }

    function OperatorShell() {
      const [gateUser, setGateUser] = useState(() => {
        try {
          const saved = localStorage.getItem('applywizz_auth_user');
          return saved ? JSON.parse(saved) : null;
        } catch {
          return null;
        }
      });
      const [operatorReady, setOperatorReady] = useState(() => Boolean(window.__applywizzOperatorApp));

      useEffect(() => {
        if (!gateUser) return;
        loadOperatorApp(() => setOperatorReady(true));
      }, [gateUser]);

      if (!gateUser) {
        return (
          <div className="flex items-center justify-center min-h-screen w-screen bg-[#FFF5EB] p-4 select-none font-sans">
            <AuthView onAuthSuccess={(user) => setGateUser(user)} />
          </div>
        );
      }

      if (!operatorReady || !window.__applywizzOperatorApp) {
        return (
          <div className="flex items-center justify-center min-h-screen w-screen bg-[#FFF5EB] p-4 select-none font-sans">
            <p className="text-sm font-bold text-[#64748B]">Loading dashboard…</p>
          </div>
        );
      }

      const DashboardApp = window.__applywizzOperatorApp;
      return <DashboardApp />;
    }

    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<OperatorShell />);
`;

const prefix = lines.slice(0, 3).join('\n'); // hooks + API_BASE_URL + getAuthHeaders start - actually auth needs getAuthHeaders? AuthView doesn't use it.

// Keep minimal prefix for auth: hooks only
const authPrefix = `    const { useState, useEffect } = React;
`;
const newBabel = authPrefix + '\n' + authLines.join('\n') + '\n\n' + authBootstrap;

const newHtml =
  html.slice(0, babelStart) + '\n' + newBabel + '\n' + html.slice(end);

fs.writeFileSync(indexPath, newHtml, 'utf8');
console.log('Wrote', outPath, 'bytes', fs.statSync(outPath).size);
console.log('index.html babel reduced to', newBabel.split(/\r?\n/).length, 'lines');
