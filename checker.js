const playwright = require("playwright");

async function checkResale(url) {
  let browser;

  try {
    // ✅ Required for many cloud/container environments
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    // ✅ Ticketmaster often never reaches "networkidle", so use domcontentloaded
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

    // ✅ Make sure the page is actually loaded before scraping
    await page.waitForSelector("body", { timeout: 30000 });

    // ✅ Small buffer for heavy JS sites like Ticketmaster
    await page.waitForTimeout(3000);

    // Check if Resale Tickets exist
    const resaleAvailable =
      (await page.$("text=Resale Tickets")) || (await page.$("text=Resale"));

    if (!resaleAvailable) {
      return { resale: false, price: null };
    }

    // Grab all ticket rows
    const ticketElements = await page.$$(
      "[data-test='ticket-row'], .ticket-row, .ticket"
    );

    let prices = [];

    for (const el of ticketElements) {
      const text = (await el.innerText()).trim();

      // Ignore sold-out tickets
      if (text.toLowerCase().includes("sold out")) continue;

      // Extract prices like £120 or £120.50
      const match = text.match(/£\d+(?:\.\d{2})?/g);
      if (match) prices.push(...match);
    }

    if (prices.length === 0) {
      return { resale: false, price: null };
    }

    const uniquePrices = [...new Set(prices)];
    const priceString = uniquePrices.join(" | ");

    return { resale: true, price: priceString };
  } catch (err) {
    console.error("Error scraping page:", err);
    return { resale: false, price: null };
  } finally {
    // ✅ Always close browser (prevents leaks + crashes)
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

module.exports = { checkResale };
