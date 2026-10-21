import { Router, Request, Response } from 'express';

export const devDbRouter = Router();

devDbRouter.get('/', (_req: Request, res: Response) => {
  if (process.env.SANDBOX !== 'true') {
    res.status(403).send('Sandbox mode only');
    return;
  }
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Local Database Viewer (Sandbox)</title>
  <style>
    body { font-family: sans-serif; padding: 20px; background: #f5f5f5; }
    .container { display: flex; gap: 20px; height: 90vh; min-width: 0; }
    .sidebar { box-sizing: border-box; flex: 0 0 250px; min-width: 250px; background: white; padding: 15px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow-y: auto; }
    .main { flex: 1 1 0; min-width: 0; background: white; padding: 15px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); display: flex; flex-direction: column; }
    .table-item { cursor: pointer; padding: 5px; border-radius: 4px; }
    .table-item:hover { background: #eee; }
    .table-item.active { background: #e0f7fa; font-weight: bold; }
    #sql-input { width: 100%; height: 100px; margin-bottom: 10px; font-family: monospace; }
    #sql-input, button { box-sizing: border-box; }
    table { width: max-content; min-width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; max-width: 360px; overflow-wrap: anywhere; }
    th { background: #f9f9f9; }
    .json-cell { max-width: 320px; }
    .json-cell summary { cursor: pointer; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .json-cell pre { margin: 8px 0 0; max-width: min(640px, 70vw); max-height: 360px; overflow: auto; white-space: pre; }
    .results { flex: 1 1 0; min-width: 0; min-height: 0; overflow: auto; }
    @media (max-width: 700px) {
      .container { height: auto; min-height: 90vh; flex-direction: column; }
      .sidebar { flex: 0 0 auto; min-width: 0; max-height: 30vh; }
      .main { min-height: 60vh; }
    }
  </style>
</head>
<body>
  <h2>Local Database Viewer</h2>
  <div class="container">
    <div class="sidebar" id="table-list">Loading tables...</div>
    <div class="main">
      <textarea id="sql-input" placeholder="SELECT * FROM gh_users;"></textarea>
      <button onclick="runQuery()">Run Query</button>
      <div id="error-msg" style="color: red; margin-top: 10px;"></div>
      <div class="results" id="results-area"></div>
    </div>
  </div>
  <script>
    async function fetchTables() {
      try {
        const res = await fetch('/api/dev/db/tables');
        const data = await res.json();
        if (data.tables) {
          const list = document.getElementById('table-list');
          list.innerHTML = data.tables.map(t =>
            '<div class="table-item" onclick="selectTable(this, \\'' + t + '\\')">' + t + '</div>'
          ).join('');
        }
      } catch (e) {
        document.getElementById('table-list').innerText = 'Error loading tables';
      }
    }
    function selectTable(el, tableName) {
      document.querySelectorAll('.table-item').forEach(i => i.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('sql-input').value = 'SELECT * FROM "' + tableName + '" LIMIT 50;';
      runQuery();
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[character]);
    }
    function formatCell(value) {
      if (value === null) return '<i>null</i>';
      if (typeof value === 'object') {
        const compact = JSON.stringify(value);
        const formatted = JSON.stringify(value, null, 2);
        return '<details class="json-cell"><summary title="Click to expand or collapse JSON">' +
          escapeHtml(compact) + '</summary><pre>' + escapeHtml(formatted) + '</pre></details>';
      }
      return escapeHtml(value);
    }
    async function runQuery() {
      const query = document.getElementById('sql-input').value;
      if (!query) return;
      document.getElementById('error-msg').innerText = '';
      document.getElementById('results-area').innerHTML = 'Loading...';
      try {
        const res = await fetch('/api/dev/db/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        if (!data.rows || data.rows.length === 0) {
          document.getElementById('results-area').innerHTML = '<i>0 rows returned.</i>';
          return;
        }
        const cols = Object.keys(data.rows[0]);
        let html = '<table><thead><tr>' + cols.map(c => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr></thead><tbody>';
        for (const row of data.rows) {
          html += '<tr>' + cols.map(c => '<td>' + formatCell(row[c]) + '</td>').join('') + '</tr>';
        }
        html += '</tbody></table>';
        document.getElementById('results-area').innerHTML = html;
      } catch (e) {
        document.getElementById('error-msg').innerText = e.message;
        document.getElementById('results-area').innerHTML = '';
      }
    }
    fetchTables();
  </script>
</body>
</html>`);
});
