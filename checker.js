const axios = require("axios");
const playwright = require("playwright");

const MIN_PRICE = 20;

const USER_AGENTS = [
"Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
"Mozilla/5.0 (X11; Linux x86_64)"
];

function randomUA(){
return USER_AGENTS[Math.floor(Math.random()*USER_AGENTS.length)];
}

function cleanUrl(url){
return String(url).split("?")[0];
}

function extractEventId(url){
const match=url.match(/event\/([A-Z0-9]+)/i);
return match?match[1]:null;
}

function detectProtection(text,finalUrl){

const t=text.toLowerCase();
const u=finalUrl.toLowerCase();

if(u.includes("queue")||u.includes("queue-it")){
return{blocked:true,reason:"Queue detected"};
}

if(
t.includes("pardon our interruption")||
t.includes("verify you are human")||
t.includes("captcha")||
t.includes("access denied")
){
return{blocked:true,reason:"Bot protection detected"};
}

return{blocked:false};

}

async function apiCheck(eventId){

try{

const apiUrl=`https://offeradapter.ticketmaster.com/api/ismds/event/${eventId}/facets`;

const res=await axios.get(apiUrl,{
timeout:7000,
headers:{
"user-agent":randomUA(),
accept:"application/json"
}
});

const offers=[];
const list=res?.data?.facets?.offers||[];

for(const o of list){

if(o.inventoryType!=="resale")continue;

const price=o.listPrice;

if(!price||price<MIN_PRICE)continue;

offers.push({
priceStr:`£${price}`,
priceNum:price,
count:o.ticketCount||1
});

}

return offers;

}catch{

return[];

}

}

async function scrapeFallback(url){

let browser;

try{

browser=await playwright.chromium.launch({
headless:true,
args:["--no-sandbox"]
});

const page=await browser.newPage();

await page.goto(url,{waitUntil:"domcontentloaded"});

await page.waitForTimeout(4000);

const finalUrl=page.url();

const text=await page.locator("body").innerText();

const protection=detectProtection(text,finalUrl);

if(protection.blocked){
return{blocked:true,reason:protection.reason,offers:[]};
}

const prices=text.match(/£\d+(?:\.\d{2})?/g)||[];

const offers=prices
.map(p=>({
priceStr:p,
priceNum:parseFloat(p.replace("£","")),
count:1
}))
.filter(o=>o.priceNum>=MIN_PRICE);

return{blocked:false,offers};

}catch{

return{blocked:false,offers:[]};

}finally{

if(browser){
try{await browser.close();}catch{}
}

}

}

async function checkResale(url){

const clean=cleanUrl(url);
const eventId=extractEventId(clean);

let offers=[];

if(eventId){
offers=await apiCheck(eventId);
}

if(offers.length>0){
return{resale:true,offers,blocked:false,finalUrl:clean};
}

const scrape=await scrapeFallback(clean);

return{
resale:scrape.offers.length>0,
offers:scrape.offers,
blocked:scrape.blocked,
reason:scrape.reason||"",
finalUrl:clean
};

}

module.exports={checkResale,cleanUrl};