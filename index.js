require("dotenv").config();

// ✅ Debug: check if environment variables are set
console.log("DISCORD_TOKEN:", process.env.DISCORD_TOKEN ? "SET" : "NOT SET");
console.log("CHANNEL_ID:", process.env.CHANNEL_ID ? "SET" : "NOT SET");

// ✅ Helps confirm Railway is running the latest deploy
console.log("INDEX VERSION: multi-artist events + per-event price caps ✅");
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
 * ✅ EVENTS (multi-artist, per-event price caps)
 */
const EVENTS = {
  // Bruno Mars — £250 max
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-18-07-2026/event/2300638CCCE11DC5": {
    artist: "Bruno Mars",
    date: "Sat 18th July",
    location: "London",
    maxPrice: 200
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-19-07-2026/event/23006427C8FF0D82": {
    artist: "Bruno Mars",
    date: "Sun 19th July",
    location: "London",
    maxPrice: 200
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-22-07-2026/event/23006427F6C10F5B": {
    artist: "Bruno Mars",
    date: "Wed 22nd July",
    location: "London",
    maxPrice: 200
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-24-07-2026/event/23006427F78F0F67": {
    artist: "Bruno Mars",
    date: "Fri 24th July",
    location: "London",
    maxPrice: 200
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-25-07-2026/event/23006427F8750F70": {
    artist: "Bruno Mars",
    date: "Sat 25th July",
    location: "London",
    maxPrice: 200
  },
  "https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-28-07-2026/event/23006427FA0D0F8E": {
    artist: "Bruno Mars",
    date: "Tue 28th July",
    location: "London",
    maxPrice: 200
  }
};

// ✅ Filters
const MIN_TICKETS = 2;
const BETWEEN_EVENTS_DELAY_MS = 2000;

let alertedEvents = {};
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

function formatOffer(o) {
  return `${o.priceStr} — ${o.count} ticket${o.count === 1 ? "" : "s"}`;
}

function qualifyOffer(o, maxPrice) {
  if (!o) return false;
  if (o.count < MIN_TICKETS) return false;
  if (o.priceNum > maxPrice) return false;
  return true;
}

async function checkAllEvents(ticketChannel) {
  if (isChecking) return;
  isChecking = true;

  try {
    console.log("Checking all events for resale tickets...");

    for (const [url, info] of Object.entries(EVENTS)) {
      const { artist, date, location, maxPrice } = info;

      try {
        const { resale, offers = [] } = await checkResale(url);
        const qualifying = offers.filter(o => qualifyOffer(o, maxPrice));

        if (resale && qualifying.length > 0) {
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
              `Time Found (UK): ${ts}\n` +
              `${url}`
            );

            alertedEvents[url] = true;
            console.log(`Alert sent for ${artist} (${date})`);
          }
        } else {
          alertedEvents[url] = false;
          console.log(
            resale
              ? `Resale found but no matches for ${artist} (${date})`
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

  const ticketChannel = await client.channels.fetch(process.env.CHANNEL_ID);
  const timeCheckChannel = await client.channels.fetch(TIME_CHECK_CHANNEL_ID);

  await ticketChannel.send("✅ Bot is online and monitoring Ticketmaster resale events!");

  await checkAllEvents(ticketChannel);

  cron.schedule("*/5 * * * *", async () => {
    await checkAllEvents(ticketChannel);
  });

  cron.schedule("0 * * * *", async () => {
    const label = ukHourLabel();
    await timeCheckChannel.send(`🕰️ **${label} check**`);
    await checkAllEvents(ticketChannel);
  });
});

client.login(process.env.DISCORD_TOKEN);
