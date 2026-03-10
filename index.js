require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const { checkResale, cleanUrl } = require("./checker");

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const EVENTS = {

"https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-18-07-2026/event/2300638CCCE11DC5":{
artist:"Bruno Mars",
date:"Sat 18th July",
location:"London",
maxPrice:300,
minTickets:2
},

"https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-19-07-2026/event/23006427C8FF0D82":{
artist:"Bruno Mars",
date:"Sun 19th July",
location:"London",
maxPrice:300,
minTickets:2
},

"https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-22-07-2026/event/23006427F6C10F5B":{
artist:"Bruno Mars",
date:"Wed 22nd July",
location:"London",
maxPrice:300,
minTickets:2
},

"https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-24-07-2026/event/23006427F78F0F67":{
artist:"Bruno Mars",
date:"Fri 24th July",
location:"London",
maxPrice:300,
minTickets:2
},

"https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-25-07-2026/event/23006427F8750F70":{
artist:"Bruno Mars",
date:"Sat 25th July",
location:"London",
maxPrice:300,
minTickets:2
},

"https://www.ticketmaster.co.uk/bruno-mars-the-romantic-tour-london-28-07-2026/event/23006427FA0D0F8E":{
artist:"Bruno Mars",
date:"Tue 28th July",
location:"London",
maxPrice:300,
minTickets:2
}};

const WORKERS = 4;
const BASE_INTERVAL = 3000;

let alertedEvents = {};

function sleep(ms){
  return new Promise(r => setTimeout(r, ms));
}

function ukTimestamp(){
  return new Date().toLocaleString("en-GB",{
    timeZone:"Europe/London",
    day:"2-digit",
    month:"short",
    year:"numeric",
    hour:"2-digit",
    minute:"2-digit",
    second:"2-digit"
  });
}

function formatOffer(o){
  return `${o.priceStr} — ${o.count} ticket${o.count===1?"":"s"}`;
}

async function worker(channel,urls){

while(true){

for(const rawUrl of urls){

const url = cleanUrl(rawUrl);
const info = EVENTS[rawUrl];

const {artist,date,location,maxPrice,minTickets} = info;

try{

const res = await checkResale(url);

console.log("────────────");
console.log("Checking:", artist, "|", date);

if(res.offers?.length){
console.log("Offers detected:", res.offers.length);
}

const qualifying = (res.offers || []).filter(o => o.priceNum <= maxPrice);
const totalTickets = qualifying.reduce((s,o)=>s+o.count,0);

if(qualifying.length > 0 && totalTickets >= minTickets){

if(!alertedEvents[url]){

const ts = ukTimestamp();
const lines = qualifying.map(formatOffer).join(" | ");

await channel.send(
`🚨 **RESALE TICKETS DETECTED (MATCHED FILTERS)!** 🚨
Artist: ${artist}
Location: ${location}
Event Date: ${date}
Max Price: £${maxPrice}
Matches: ${lines}
Time Found (UK): ${ts}
${url}`
);

console.log("🚨 ALERT SENT");

alertedEvents[url] = true;

}

}else{

alertedEvents[url] = false;

}

}catch(err){

console.log("Check failed:", artist);

}

await sleep(900 + Math.random()*1500);

}

await sleep(BASE_INTERVAL);

}

}

client.once("clientReady",async()=>{

console.log(`Logged in as ${client.user.tag}`);

const channel = await client.channels.fetch(process.env.CHANNEL_ID);

await channel.send("✅ Bot is online and monitoring Ticketmaster resale events!");

const urls = Object.keys(EVENTS);
const chunkSize = Math.ceil(urls.length / WORKERS);

for(let i=0;i<WORKERS;i++){

const chunk = urls.slice(i*chunkSize,(i+1)*chunkSize);

worker(channel,chunk);

}

});

client.login(process.env.DISCORD_TOKEN);