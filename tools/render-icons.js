// Renders web/icons/icon.svg to the PNG sizes the web app manifest needs.
// Run: node tools/render-icons.js   (uses the Playwright that is already installed)
const fs = require("fs"), path = require("path");
const { chromium } = require("playwright");
const dir = path.join(__dirname, "..", "web", "icons");
const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
const OUT = { "icon-192.png": 192, "icon-512.png": 512, "icon-maskable-512.png": 512, "apple-touch-icon.png": 180 };
(async () => {
  const browser = await chromium.launch();
  for (const name in OUT) {
    const n = OUT[name];
    const page = await browser.newPage({ viewport: { width: n, height: n } });
    await page.setContent('<style>html,body{margin:0;background:#111214}svg{display:block;width:' + n + 'px;height:' + n + 'px}</style>' + svg);
    await page.screenshot({ path: path.join(dir, name), clip: { x: 0, y: 0, width: n, height: n } });
    await page.close();
    console.log("wrote " + name);
  }
  await browser.close();
})();
