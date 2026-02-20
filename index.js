require("dotenv").config();

// 🛑 Prevent silent crashes (Railway container can stop without this)
process.on("unhandledRejection", err => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", err => console.error("UNCAUGHT EXCEPTION:", err));

// ✅ Debug: check if environment variables are set
console.log("DISCORD_TOKEN:", process.env.DISCORD_TOKEN ? "SET" : "NOT SET");
console.log("CHANNEL_ID:", process.env.CHANNEL_ID ? "SET" : "NOT SET");

// ✅ Helps confirm Railway is running the latest deploy
console.log(
  "INDEX VERSION: multi-artist events + per-event price caps + per-event minTickets + enabledUntil ✅ (minTickets = total listings) + retry+debug + daily report ✅ (fixed scheduling)"
);
console.log("DEPLOY SHA:", process.env.RAILWAY_GIT_COMMIT_SHA || "unknown");

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { checkResale } = require("./checker");
const cron = require("node-cron");

// 🕰️ Channel for hourly check logs
const TIME_CHECK_CHANNEL_ID = "1465346769490809004";

// 📣 Daily report config
const DAILY_REPORT_CHANNEL_ID = "1473945399919378524";

// ✅ Daily report time (UK) — 10:00 UK
const DAILY_REPORT_TIME_UK_HOUR = 18;
const DAILY_REPORT_TIME_UK_MINUTE = 20;

// ✅ Daily report toggles
const ALLOW_DAILY_REPORT = true;
const RUN_DAILY_REPORT_ON_STARTUP = false;

// ✅ TEST MODE: set true to prove daily report is firing (runs every minute), then turn back to false
const DAILY_REPORT_TEST_MODE = true;

// ✅ Daily report filters (report-only)
const DAILY_REPORT_MAX_PRICE_GBP = 5000;
const DAILY_REPORT_MIN_LISTINGS = 1;

// ✅ Debug + retry options (no Railway env vars needed)
const DEBUG_RESULTS = true; // set false when happy
const RETRY_ON_EMPTY = true; // retry once if resale/offers look empty
const RETRY_DELAY_MS = 6000; // wait before retry

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

/**
 * ✅ EVENTS
 * enabledUntil format: "YYYY-MM-DD" (UK date). If enabledUntil is "" then always enabled.
 * minTickets: minimum total qualifying listings across prices (per link)
 */
const EVENTS = {
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-18-07-2026/event/2300638CCCE11DC5": {
    artist: "Bruno Mars",
    date: "Sat 18th July",
    location: "London",
    maxPrice: 600,
    minTickets: 1,
    enabledUntil: "2026-07-18"
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-19-07-2026/event/23006427C8FF0D82": {
    artist: "Bruno Mars",
    date: "Sun 19th July",
    location: "London",
    maxPrice: 600,
    minTickets: 1,
    enabledUntil: "2026-07-19"
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-22-07-2026/event/23006427F6C10F5B": {
    artist: "Bruno Mars",
    date: "Wed 22nd July",
    location: "London",
    maxPrice: 600,
    minTickets: 1,
    enabledUntil: "2026-07-22"
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-24-07-2026/event/23006427F78F0F67": {
    artist: "Bruno Mars",
    date: "Fri 24th July",
    location: "London",
    maxPrice: 600,
    minTickets: 1,
    enabledUntil: "2026-07-24"
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-25-07-2026/event/23006427F8750F70": {
    artist: "Bruno Mars",
    date: "Sat 25th July",
    location: "London",
    maxPrice: 600,
    minTickets: 1,
    enabledUntil: "2026-07-25"
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-28-07-2026/event/23006427FA0D0F8E": {
    artist: "Bruno Mars",
    date: "Tue 28th July",
    location: "London",
    maxPrice: 600,
    minTickets: 1,
    enabledUntil: "2026-07-28"
  }
};

// small delay between event checks
const BETWEEN_EVENTS_DELAY_MS = 2000;

let alertedEvents = {}; // url -> boolean
let isChecking = false;
let isDailyReporting = false;

function ukTimestamp() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function ukHourLabel() {
  return new Date().toLocaleString("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    hour12: true
  });
}

function ukDateYYYYMMDD() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const year = parts.find(p => p.type === "year").value;
  const month = parts.find(p => p.type === "month").value;
  const day = parts.find(p => p.type === "day").value;
  return `${year}-${month}-${day}`;
}

function isEventEnabled(info) {
  if (!info) return false;

  const until = String(info.enabledUntil || "").trim();
  if (!until) return true;

  const today = ukDateYYYYMMDD();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(until);
  if (!valid) {
    console.log(`⚠️ enabledUntil is invalid (${until}) — treating as ENABLED`);
    return true;
  }

  return today <= until;
}

// ✅ Clean output for alerts: hide singles + say "tickets"
function formatOfferAlert(o) {
  if (!o || typeof o.count !== "number") return null;
  if (o.count < 2) return null; // hide single listings
  return `${o.priceStr} — ${o.count} tickets`;
}

// ✅ Clean output for daily report: allow singles + say "tickets"
function formatOfferReport(o) {
  if (!o || typeof o.count !== "number") return null;
  return `${o.priceStr} — ${o.count} ticket${o.count === 1 ? "" : "s"}`;
}

function qualifiesByPrice(o, maxPrice) {
  if (!o) return false;
  if (typeof o.priceNum !== "number" || Number.isNaN(o.priceNum)) return false;
  return o.priceNum <= maxPrice;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, label) {
  let result = await checkResale(url);
  let resale = !!result?.resale;
  let offers = Array.isArray(result?.offers) ? result.offers : [];

  if (RETRY_ON_EMPTY && (!resale || offers.length === 0)) {
    console.log(
      `⚠️ Possible false-negative for ${label} — retrying once in ${RETRY_DELAY_MS}ms...`
    );
    await sleep(RETRY_DELAY_MS);

    result = await checkResale(url);
    resale = !!result?.resale;
    offers = Array.isArray(result?.offers) ? result.offers : [];
  }

  return { resale, offers };
}

async function checkAllEvents(ticketChannel) {
  if (isChecking) return;
  isChecking = true;

  try {
    console.log("Checking all events for resale tickets...");

    for (const [url, info] of Object.entries(EVENTS)) {
      const { artist, date, location, maxPrice, minTickets, enabledUntil } = info;

      if (!isEventEnabled(info)) {
        console.log(
          `⏭️ Skipping (expired): ${artist} (${date}) — enabledUntil=${enabledUntil}`
        );
        continue;
      }

      const minTicketsForEvent = typeof minTickets === "number" ? minTickets : 2;

      try {
        const { resale, offers } = await fetchWithRetry(url, `${artist} (${date})`);

        const qualifying = offers.filter(o => qualifiesByPrice(o, maxPrice));

        const totalListings = qualifying.reduce(
          (sum, o) => sum + (typeof o.count === "number" ? o.count : 0),
          0
        );

        if (DEBUG_RESULTS) {
          console.log(
            `[DEBUG] ${artist} (${date}) resale=${resale} offers=${offers.length} qualifying=${qualifying.length} totalListings=${totalListings} minTickets=${minTicketsForEvent} alerted=${!!alertedEvents[url]}`
          );
          if (offers.length) console.log("[DEBUG offers]", offers);
        }

        const lines = qualifying
          .map(formatOfferAlert)
          .filter(Boolean)
          .join(" | ");

        if (resale && totalListings >= minTicketsForEvent && lines.length > 0) {
          if (!alertedEvents[url]) {
            const ts = ukTimestamp();

            await ticketChannel.send(
              `🚨 **RESALE TICKETS DETECTED (MATCHED FILTERS)!** 🚨\n` +
                `Artist: ${artist}\n` +
                `Location: ${location}\n` +
                `Event Date: ${date}\n` +
                `Max Price: £${maxPrice}\n` +
                `Matches: ${lines}\n` +
                `Time Found (UK): ${ts}\n` +
                `${url}`
            );

            alertedEvents[url] = true;
            console.log(`Alert sent for ${artist} (${date})`);
          } else {
            console.log(
              `Still matching filters for ${artist} (${date}) (already alerted).`
            );
          }
        } else {
          alertedEvents[url] = false;
          console.log(
            resale
              ? `Resale found but no matches for ${artist} (${date}) (qualifying listings: ${totalListings}, need ${minTicketsForEvent})`
              : `No resale tickets for ${artist} (${date})`
          );
        }
      } catch (err) {
        console.error(`Error checking ${artist} (${date}):`, err);
      }

      await sleep(BETWEEN_EVENTS_DELAY_MS);
    }
  } finally {
    isChecking = false;
  }
}

async function runDailyReport(dailyReportChannel) {
  if (!dailyReportChannel) return;

  if (isDailyReporting) {
    console.log("[DailyReport] Skipping: already running.");
    return;
  }

  isDailyReporting = true;
  try {
    const ts = ukTimestamp();
    await dailyReportChannel.send(`📊 **Daily resale report** (UK time: ${ts})`);

    for (const [url, info] of Object.entries(EVENTS)) {
      const { artist, date, location, enabledUntil } = info;

      if (!isEventEnabled(info)) {
        await dailyReportChannel.send(
          `Artist: ${artist}\nLocation: ${location}\nEvent Date: ${date}\nStatus: Skipped (expired: enabledUntil=${enabledUntil})\n${url}`
        );
        continue;
      }

      try {
        const { resale, offers } = await fetchWithRetry(
          url,
          `DAILY ${artist} (${date})`
        );

        const qualifying = offers.filter(o =>
          qualifiesByPrice(o, DAILY_REPORT_MAX_PRICE_GBP)
        );

        const totalListings = qualifying.reduce(
          (sum, o) => sum + (typeof o.count === "number" ? o.count : 0),
          0
        );

        const lines = qualifying
          .map(formatOfferReport)
          .filter(Boolean)
          .join(" | ");

        if (resale && totalListings >= DAILY_REPORT_MIN_LISTINGS && lines.length > 0) {
          await dailyReportChannel.send(
            `Artist: ${artist}\n` +
              `Location: ${location}\n` +
              `Event Date: ${date}\n` +
              `Max Price: £${DAILY_REPORT_MAX_PRICE_GBP}\n` +
              `Matches: ${lines}\n` +
              `Total qualifying listings: ${totalListings}\n` +
              `Time Checked (UK): ${ts}\n` +
              `${url}`
          );
        } else {
          await dailyReportChannel.send(
            `Artist: ${artist}\n` +
              `Location: ${location}\n` +
              `Event Date: ${date}\n` +
              `Max Price: £${DAILY_REPORT_MAX_PRICE_GBP}\n` +
              `Matches: none\n` +
              `Total qualifying listings: ${totalListings}\n` +
              `Time Checked (UK): ${ts}\n` +
              `${url}`
          );
        }
      } catch (err) {
        console.error(`Daily report error for ${artist} (${date}):`, err);
        await dailyReportChannel.send(
          `Artist: ${artist}\nLocation: ${location}\nEvent Date: ${date}\nStatus: ERROR\n${url}`
        );
      }

      await sleep(1500);
    }

    await dailyReportChannel.send("✅ **Daily report complete**");
  } finally {
    isDailyReporting = false;
  }
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const ticketChannel = await client.channels
    .fetch(process.env.CHANNEL_ID)
    .catch(err => {
      console.error("Failed to fetch ticket channel. Check CHANNEL_ID.", err);
      process.exit(1);
    });

  const timeCheckChannel = await client.channels
    .fetch(TIME_CHECK_CHANNEL_ID)
    .catch(err => {
      console.error(
        "Failed to fetch time-check channel. Check TIME_CHECK_CHANNEL_ID.",
        err
      );
      process.exit(1);
    });

  // ✅ SAFER: do NOT kill the bot if daily report channel can't be fetched
  let dailyReportChannel = null;
  if (ALLOW_DAILY_REPORT) {
    try {
      dailyReportChannel = await client.channels.fetch(DAILY_REPORT_CHANNEL_ID);
      console.log("[DailyReport] Channel fetched OK");
    } catch (err) {
      console.error(
        "[DailyReport] Failed to fetch daily-report channel (will keep bot running):",
        err
      );
    }
  }

  await ticketChannel.send("✅ Bot is online and monitoring Ticketmaster resale events!");

  // ✅ Delay first scrape slightly (helps Railway stability)
  setTimeout(() => {
    console.log("[Startup] Running first resale check...");
    checkAllEvents(ticketChannel);
  }, 5000);

  cron.schedule("*/5 * * * *", async () => {
    await checkAllEvents(ticketChannel);
  });

  cron.schedule(
    "0 * * * *",
    async () => {
      const label = ukHourLabel();
      await timeCheckChannel.send(`🕰️ **${label} check**`);
      await checkAllEvents(ticketChannel);
    },
    { timezone: "Europe/London" }
  );

  // ✅ Daily report (optional) - UK timezone
  if (ALLOW_DAILY_REPORT && dailyReportChannel) {
    const cronExpr = `${DAILY_REPORT_TIME_UK_MINUTE} ${DAILY_REPORT_TIME_UK_HOUR} * * *`;

    if (DAILY_REPORT_TEST_MODE) {
      cron.schedule(
        "* * * * *",
        async () => {
          console.log(`[DailyReport] TEST MODE trigger at ${ukTimestamp()}`);
          await runDailyReport(dailyReportChannel);
        },
        { timezone: "Europe/London" }
      );

      console.log("[DailyReport] TEST MODE ENABLED: report will run every minute (UK).");
    } else {
      cron.schedule(
        cronExpr,
        async () => {
          console.log(`[DailyReport] Trigger fired at ${ukTimestamp()}`);
          await runDailyReport(dailyReportChannel);
        },
        { timezone: "Europe/London" }
      );

      console.log(
        `[DailyReport] Scheduled for ${String(DAILY_REPORT_TIME_UK_HOUR).padStart(2, "0")}:${String(
          DAILY_REPORT_TIME_UK_MINUTE
        ).padStart(2, "0")} UK daily in channel ${DAILY_REPORT_CHANNEL_ID}`
      );
      console.log(`[DailyReport] Cron expression: ${cronExpr} (timezone Europe/London)`);
    }

    if (RUN_DAILY_REPORT_ON_STARTUP) {
      console.log(`[DailyReport] Running once on startup at ${ukTimestamp()}`);
      await runDailyReport(dailyReportChannel);
    }

    console.log("Daily report is ENABLED ✅");
  } else if (ALLOW_DAILY_REPORT && !dailyReportChannel) {
    console.log("Daily report is ENABLED but channel fetch failed ❌");
  } else {
    console.log("Daily report is DISABLED ❌");
  }
});

client.login(process.env.DISCORD_TOKEN);