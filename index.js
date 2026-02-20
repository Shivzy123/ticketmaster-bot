require("dotenv").config();

// ✅ Debug: check if environment variables are set
console.log("DISCORD_TOKEN:", process.env.DISCORD_TOKEN ? "SET" : "NOT SET");
console.log("CHANNEL_ID:", process.env.CHANNEL_ID ? "SET" : "NOT SET");

// ✅ Helps confirm Railway is running the latest deploy
console.log(
  "INDEX VERSION: retry+debug hardened ✅ (extra retries + crash guards + cron timezone)"
);
console.log("DEPLOY SHA:", process.env.RAILWAY_GIT_COMMIT_SHA || "unknown");

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { checkResale } = require("./checker");
const cron = require("node-cron");

// 🕰️ Channel for hourly check logs
const TIME_CHECK_CHANNEL_ID = "1465346769490809004";

// ✅ Debug + retry options
const DEBUG_RESULTS = true;     // set false when happy
const RETRY_ON_EMPTY = true;    // retry if resale/offers look empty
const RETRY_DELAY_MS = 6000;    // first retry wait
const RETRY_DELAY_MS_2 = 12000; // second retry wait

// small delay between event checks
const BETWEEN_EVENTS_DELAY_MS = 2000;

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

/**
 * ✅ EVENTS
 * enabledUntil format: "YYYY-MM-DD" (UK date). If enabledUntil is "" then always enabled.
 */
const EVENTS = {
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-18-07-2026/event/2300638CCCE11DC5": {
    artist: "Bruno Mars",
    date: "Sat 18th July",
    location: "London",
    maxPrice: 2000,
    enabledUntil: "2026-07-18"
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-19-07-2026/event/23006427C8FF0D82": {
    artist: "Bruno Mars",
    date: "Sun 19th July",
    location: "London",
    maxPrice: 2000,
    enabledUntil: "2026-07-19"
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-22-07-2026/event/23006427F6C10F5B": {
    artist: "Bruno Mars",
    date: "Wed 22nd July",
    location: "London",
    maxPrice: 2000,
    enabledUntil: "2026-07-22"
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-24-07-2026/event/23006427F78F0F67": {
    artist: "Bruno Mars",
    date: "Fri 24th July",
    location: "London",
    maxPrice: 2000,
    enabledUntil: "2026-07-24"
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-25-07-2026/event/23006427F8750F70": {
    artist: "Bruno Mars",
    date: "Sat 25th July",
    location: "London",
    maxPrice: 2000,
    enabledUntil: "2026-07-25"
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-28-07-2026/event/23006427FA0D0F8E": {
    artist: "Bruno Mars",
    date: "Tue 28th July",
    location: "London",
    maxPrice: 2000,
    enabledUntil: "2026-07-28"
  }
};

// ✅ Filters
const MIN_TICKETS = 2; // total qualifying listings across prices

let alertedEvents = {}; // url -> boolean
let isChecking = false;

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

function formatOffer(o) {
  // keep your original wording
  return `${o.priceStr} — ${o.count} listing${o.count === 1 ? "" : "s"}`;
}

function qualifiesByPrice(o, maxPrice) {
  if (!o) return false;
  if (typeof o.priceNum !== "number" || Number.isNaN(o.priceNum)) return false;
  return o.priceNum <= maxPrice;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * ✅ Hardened fetch with up to 2 retries for Railway flakiness
 */
async function fetchWithRetry(url, label) {
  let attempt = 1;
  let result = await checkResale(url);
  let resale = !!result?.resale;
  let offers = Array.isArray(result?.offers) ? result.offers : [];

  if (RETRY_ON_EMPTY && (!resale || offers.length === 0)) {
    console.log(
      `⚠️ Possible false-negative for ${label} — retry #1 in ${RETRY_DELAY_MS}ms...`
    );
    await sleep(RETRY_DELAY_MS);

    attempt = 2;
    result = await checkResale(url);
    resale = !!result?.resale;
    offers = Array.isArray(result?.offers) ? result.offers : [];
  }

  if (RETRY_ON_EMPTY && (!resale || offers.length === 0)) {
    console.log(
      `⚠️ Still empty for ${label} — retry #2 in ${RETRY_DELAY_MS_2}ms...`
    );
    await sleep(RETRY_DELAY_MS_2);

    attempt = 3;
    result = await checkResale(url);
    resale = !!result?.resale;
    offers = Array.isArray(result?.offers) ? result.offers : [];
  }

  return { resale, offers, attempt };
}

// Function to check all events (with lock to prevent overlapping runs)
async function checkAllEvents(ticketChannel) {
  if (isChecking) return;
  isChecking = true;

  try {
    console.log("Checking all events for resale tickets...");

    for (const [url, info] of Object.entries(EVENTS)) {
      const { artist, date, location, maxPrice, enabledUntil } = info;

      if (!isEventEnabled(info)) {
        console.log(
          `⏭️ Skipping (expired): ${artist} (${date}) — enabledUntil=${enabledUntil}`
        );
        continue;
      }

      try {
        const { resale, offers, attempt } = await fetchWithRetry(
          url,
          `${artist} (${date})`
        );

        const qualifying = offers.filter(o => qualifiesByPrice(o, maxPrice));
        const totalListings = qualifying.reduce(
          (sum, o) => sum + (typeof o.count === "number" ? o.count : 0),
          0
        );

        if (DEBUG_RESULTS) {
          console.log(
            `[DEBUG] ${artist} (${date}) attempt=${attempt} resale=${resale} offers=${offers.length} qualifying=${qualifying.length} totalListings=${totalListings} alerted=${!!alertedEvents[url]}`
          );
          if (offers.length) console.log("[DEBUG offers]", offers);
        }

        if (resale && qualifying.length > 0 && totalListings >= MIN_TICKETS) {
          if (!alertedEvents[url]) {
            const ts = ukTimestamp();
            const lines = qualifying.map(formatOffer).join(" | ");

            await ticketChannel.send(
              `🚨 **RESALE TICKETS DETECTED (MATCHED FILTERS)!** 🚨\n` +
                `Artist: ${artist}\n` +
                `Location: ${location}\n` +
                `Event Date: ${date}\n` +
                `Max Price: £${maxPrice}\n` +
                `Matches: ${lines}\n` +
                `Total qualifying listings: ${totalListings}\n` +
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
              ? `Resale found but no matches for ${artist} (${date}) (qualifying listings: ${totalListings})`
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

/**
 * ✅ Crash guards (important on Railway)
 */
process.on("unhandledRejection", err => {
  console.error("[FATAL] Unhandled Rejection:", err);
});
process.on("uncaughtException", err => {
  console.error("[FATAL] Uncaught Exception:", err);
});

client.on("error", err => console.error("[Discord] client error:", err));
client.on("shardError", err => console.error("[Discord] shard error:", err));

client.once("ready", async () => {
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

  await ticketChannel.send(
    "✅ Bot is online and monitoring Ticketmaster resale events!"
  );

  // Run immediately on startup
  await checkAllEvents(ticketChannel);

  // Every 5 minutes
  cron.schedule(
    "*/5 * * * *",
    async () => {
      await checkAllEvents(ticketChannel);
    },
    { timezone: "Europe/London" }
  );

  // Every hour
  cron.schedule(
    "0 * * * *",
    async () => {
      const label = ukHourLabel();
      await timeCheckChannel.send(`🕰️ **${label} check**`);
      await checkAllEvents(ticketChannel);
    },
    { timezone: "Europe/London" }
  );

  console.log("Schedulers started ✅");
});

client.login(process.env.DISCORD_TOKEN);