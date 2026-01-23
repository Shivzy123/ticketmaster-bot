const playwright = require("playwright");

async function checkResale(url) {
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle" });

    // Check if Resale Tickets exist
    const resaleAvailable = await page.$("text=Resale Tickets") || await page.$("text=Resale");

    if (!resaleAvailable) {
      await browser.close();
      return { resale: false, price: null };
    }

    // Grab all ticket rows
    const ticketElements = await page.$$("[data-test='ticket-row'], .ticket-row, .ticket"); // adjust selector if needed
    let prices = [];

    for (const el of ticketElements) {
      const text = (await el.innerText()).trim();

      // Ignore sold-out tickets
      if (text.toLowerCase().includes("sold out")) continue;

      // Extract price from text
      const match = text.match(/£\d+/g);
      if (match) prices.push(...match);
    }

    if (prices.length === 0) {
      await browser.close();
      return { resale: false, price: null };
    }

    const uniquePrices = [...new Set(prices)];
    const priceString = uniquePrices.join(" | ");

    await browser.close();
    return { resale: true, price: priceString };
  } catch (err) {
    console.error("Error scraping page:", err);
    await browser.close();
    return { resale: false, price: null };
  }
}

module.exports = { checkResale };
