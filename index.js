require("dotenv").config();

// ✅ Debug: check if environment variables are set
console.log("DISCORD_TOKEN:", process.env.DISCORD_TOKEN ? "SET" : "NOT SET");
console.log("CHANNEL_ID:", process.env.CHANNEL_ID ? "SET" : "NOT SET");

// ✅ Helps confirm Railway is running the latest deploy
console.log(
  "INDEX VERSION: multi-artist events + per-event price caps + enabledUntil ✅ (MIN_TICKETS = total listings)"
);
console.log("DEPLOY SHA:", process.env.RAILWAY_GIT_COMMIT_SHA || "unknown");

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { checkResale } = require("./checker");
const cron = require("node-cron");

// 🕰️ Channel for hourly check logs
const TIME_CHECK_CHANNEL_ID = "1465346769490809004";

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

/**
 * ✅ EVENTS (multi-artist, per-event price caps, optional enabledUntil)
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
const MIN_TICKETS = 2; // ✅ now means total qualifying listings across prices
const BETWEEN_EVENTS_DELAY_MS = 2000;

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

// ✅ Returns UK date in YYYY-MM-DD
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

// ✅ enabledUntil checker (inclusive): if today <= enabledUntil => enabled
function isEventEnabled(info) {
  if (!info) return false;

  const until = String(info.enabledUntil || "").trim();
  if (!until) return true; // ✅ empty => always enabled

  const today = ukDateYYYYMMDD();

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(until);
  if (!valid) {
    console.log(`⚠️ enabledUntil is invalid (${until}) — treating as ENABLED`);
    return true;
  }

  return today <= until; // inclusive
}

function formatOffer(o) {
  return `${o.priceStr} — ${o.count} listing${o.count === 1 ? "" : "s"}`;
}

function qualifiesByPrice(o, maxPrice) {
  if (!o) return false;
  if (typeof o.priceNum !== "number" || Number.isNaN(o.priceNum)) return false;
  return o.priceNum <= maxPrice;
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
        const { resale, offers = [] } = await checkResale(url);

        // ✅ apply per-event price cap
        const qualifying = offers.filter(o => qualifiesByPrice(o, maxPrice));

        // ✅ total qualifying listings across ALL prices
        const totalListings = qualifying.reduce(
          (sum, o) => sum + (typeof o.count === "number" ? o.count : 0),
          0
        );

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

      await new Promise(r => setTimeout(r, BETWEEN_EVENTS_DELAY_MS));
    }
  } finally {
    isChecking = false;
  }
}

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
  cron.schedule("*/5 * * * *", async () => {
    await checkAllEvents(ticketChannel);
  });

  // Every hour
  cron.schedule("0 * * * *", async () => {
    const label = ukHourLabel();
    await timeCheckChannel.send(`🕰️ **${label} check**`);
    await checkAllEvents(ticketChannel);
  });
});

client.login(process.env.DISCORD_TOKEN);
