const playwright = require("playwright");

async function checkResale(url) {
  let browser;

  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector("body", { timeout: 30000 });
    await page.waitForTimeout(3000);

    // ✅ If a cookie banner exists, try to accept (won’t crash if not found)
    const acceptBtn = page.locator(
      "button:has-text('Accept'), button:has-text('Accept All'), button:has-text('I Accept')"
    );
    if (await acceptBtn.count()) {
      try { await acceptBtn.first().click({ timeout: 3000 }); } catch {}
    }

    // ✅ Grab full visible text (Ticketmaster markup changes a lot)
    const bodyText = await page.locator("body").innerText();

    // ✅ Resale detection: Ticketmaster commonly uses "Verified Resale Ticket"
    const hasResale =
      /Verified Resale Ticket/i.test(bodyText) ||
      /\bResale\b/i.test(bodyText);

    if (!hasResale) return { resale: false, price: null };

    // ✅ Extract prices like £563.22 from the whole page text
    const matches = bodyText.match(/£\d+(?:\.\d{2})?/g) || [];
    const uniquePrices = [...new Set(matches)];

    if (uniquePrices.length === 0) {
      // Resale text exists but no prices extracted
      return { resale: true, price: "Price not detected" };
    }

    return { resale: true, price: uniquePrices.join(" | ") };
  } catch (err) {
    console.error("Error scraping page:", err);
    return { resale: false, price: null };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

module.exports = { checkResale };
