const { chromium } = require("playwright");

async function checkResale(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120"
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  const result = await page.evaluate(() => {
    const bodyText = document.body.innerText.toLowerCase();
    const resale = bodyText.includes("resale") || bodyText.includes("verified resale");

    let price = "Unknown price";
    const priceElement = document.querySelector(".price-range"); // adjust selector if needed
    if (priceElement) price = priceElement.innerText.trim();

    return { resale, price };
  });

  await browser.close();
  return result;
}

module.exports = { checkResale };
