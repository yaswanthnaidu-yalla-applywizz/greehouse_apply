import { chromium } from 'playwright';
import { createServer } from '../src/server/index.js';
import http from 'http';
import path from 'path';

async function main() {
  const app = createServer();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 3001;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(`http://localhost:${port}`);
  await page.waitForTimeout(2500);

  const screenshotPath = path.resolve('output', 'dashboard_preview.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const bodyText = await page.innerText('body');
  console.log('--- Body Preview ---');
  console.log(bodyText.slice(0, 300));
  console.log(`\nScreenshot saved to: ${screenshotPath}`);

  await browser.close();
  server.close();
}

main().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
