require('dotenv').config();
const express = require('express');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const RENDER_URL = process.env.RENDER_URL;
const PORT = process.env.PORT || 3000;

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── GITHUB STORAGE ───────────────────────────────────────────────────────────
let localData = null;
let dataSha = null;

async function loadData() {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/bot_data.json`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );
    dataSha = res.data.sha;
    localData = JSON.parse(Buffer.from(res.data.content, 'base64').toString());
  } catch (e) {
    localData = { channels:{}, customAds:[], pinQueue:{}, customAdsQueue:{}, stats:{}, dailyTracker:{} };
  }
  return localData;
}

async function saveData() {
  try {
    const content = Buffer.from(JSON.stringify(localData, null, 2)).toString('base64');
    const res = await axios.put(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/bot_data.json`,
      { message:'update', content, ...(dataSha ? { sha:dataSha } : {}) },
      { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
    );
    dataSha = res.data.content.sha;
  } catch (e) { console.error('Save error:', e.message); }
}

function data() { return localData; }
setInterval(saveData, 60000);

// ─── TELEGRAM API ─────────────────────────────────────────────────────────────
async function tg(method, params = {}) {
  try {
    const res = await axios.post(`${API}/${method}`, params);
    return res.data;
  } catch (e) {
    console.error(`tg.${method} error:`, e.response?.data || e.message);
    return { ok:false };
  }
}

async function send(chatId, text, keyboard=null, parse_mode='Markdown') {
  const params = { chat_id:chatId, text, parse_mode };
  if (keyboard) params.reply_markup = keyboard;
  return tg('sendMessage', params);
}

async function edit(chatId, msgId, text, keyboard=null, parse_mode='Markdown') {
  const params = { chat_id:chatId, message_id:msgId, text, parse_mode };
  if (keyboard) params.reply_markup = keyboard;
  try { return await tg('editMessageText', params); }
  catch (e) { return send(chatId, text, keyboard, parse_mode); }
}

// ─── KEYBOARDS ────────────────────────────────────────────────────────────────
const BACK_MAIN = { inline_keyboard: [[{ text:'⬅️ Back', callback_data:'main' }]] };

function mainMenu() {
  return { inline_keyboard: [
    [{ text:'➕ Add Channel', callback_data:'add_channel' }],
    [{ text:'📋 Channel List', callback_data:'channel_list' }],
    [{ text:'📣 Custom Ads', callback_data:'custom_ads_menu' }],
  ]};
}

function channelMenu(cid) {
  const ch = data().channels[cid];
  const ip = ch.insideadsPins ? '🟢 ON' : '🔴 OFF';
  const ca = ch.customAds ? '🟢 ON' : '🔴 OFF';
  return { inline_keyboard: [
    [{ text:`📌 InsideAds Pins [${ip}]`, callback_data:`toggle_ip_${cid}` }],
    [{ text:`📣 Custom Ads [${ca}]`, callback_data:`toggle_ca_${cid}` }],
    [{ text:'📊 Stats', callback_data:`stats_${cid}` }],
    [{ text:'⚙️ Ads Frequency', callback_data:`freq_${cid}` }],
    [{ text:'🗑️ Remove Channel', callback_data:`remove_confirm_${cid}` }],
    [{ text:'⬅️ Back', callback_data:'channel_list' }],
  ]};
}

function freqMenu(cid, current) {
  const nums = [1,2,3,4,5,6].map(n => ({ text: n==current ? `✅ ${n}` : `${n}`, callback_data:`setfreq_${cid}_${n}` }));
  return { inline_keyboard: [
    nums,
    [{ text:'✏️ Custom Number', callback_data:`freqcustom_${cid}` }],
    [{ text:'⬅️ Back', callback_data:`ch_${cid}` }],
  ]};
}

function adsMenu() {
  return { inline_keyboard: [
    [{ text:'✏️ Create Ad', callback_data:'create_ad' }],
    [{ text:'📋 My Ads List', callback_data:'ads_list_0' }],
    [{ text:'📊 Global Stats', callback_data:'global_stats' }],
    [{ text:'⬅️ Back', callback_data:'main' }],
  ]};
}

function adsListMenu(page) {
  const ads = data().customAds;
  const PAGE = 10, start = page * PAGE;
  const rows = ads.slice(start, start+PAGE).map((ad,i) => [{ text:`${start+i+1}. ${ad.text.slice(0,35)}...`, callback_data:`view_ad_${ad.id}` }]);
  const nav = [];
  if (page > 0) nav.push({ text:'⬅️ Prev', callback_data:`ads_list_${page-1}` });
  if (start+PAGE < ads.length) nav.push({ text:'Next ➡️', callback_data:`ads_list_${page+1}` });
  if (nav.length) rows.push(nav);
  if (ads.length > 0) rows.push([{ text:'🗑️ Delete All', callback_data:'delete_all_confirm' }]);
  rows.push([{ text:'⬅️ Back', callback_data:'custom_ads_menu' }]);
  return { inline_keyboard: rows };
}

function adViewMenu(adId) {
  return { inline_keyboard: [
    [{ text:'✏️ Edit', callback_data:`edit_ad_${adId}` }],
    [{ text:'🗑️ Delete', callback_data:`del_ad_confirm_${adId}` }],
    [{ text:'📊 Stats', callback_data:`ad_stats_${adId}` }],
    [{ text:'⬅️ Back', callback_data:'ads_list_0' }],
  ]};
}

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {};
function getState(uid) { return state[uid] || {}; }
function setState(uid, s) { state[uid] = s; }
function clearState(uid) { state[uid] = {}; }

// ─── STATS ────────────────────────────────────────────────────────────────────
function ensureStats(cid) {
  if (!data().stats[cid]) data().stats[cid] = { insideads:{today:0,month:0,total:0}, customads:{today:0,month:0,total:0}, day:'', month:'' };
  const s = data().stats[cid];
  const d = new Date().toISOString().slice(0,10);
  const m = new Date().toISOString().slice(0,7);
  if (s.day !== d) { s.insideads.today=0; s.customads.today=0; s.day=d; }
  if (s.month !== m) { s.insideads.month=0; s.customads.month=0; s.month=m; }
  return s;
}

// ─── INSIDEADS ────────────────────────────────────────────────────────────────
function isInsideAds(msg) {
  const text = (msg.text || msg.caption || '').toLowerCase();
  if (text.includes('insideads') || text.includes('insidead')) return true;
  const ents = msg.entities || msg.caption_entities || [];
  return ents.some(e => e.url && e.url.toLowerCase().includes('insidead'));
}

async function handleInsideAdsPost(cid, msg) {
  const ch = data().channels[cid];
  if (!ch || !ch.insideadsPins) return;
  const mid = msg.message_id;
  console.log(`[InsideAds] Detected in ${cid}, pinning message ${mid}`);
  const pinRes = await tg('pinChatMessage', { chat_id:cid, message_id:mid, disable_notification:true });
  console.log(`[InsideAds] Pin result:`, JSON.stringify(pinRes));
  if (!data().pinQueue[cid]) data().pinQueue[cid] = [];
  if (!data().pinQueue[cid].find(p => p.mid===mid)) {
    data().pinQueue[cid].push({ mid, pinnedAt:Date.now() });
  }
  const s = ensureStats(cid);
  s.insideads.today++; s.insideads.month++; s.insideads.total++;
  await saveData();
}

// ─── CUSTOM ADS ───────────────────────────────────────────────────────────────
function getDhakaDate() { return new Date(Date.now() + 6*3600000).toISOString().slice(0,10); }

async function onNewPost(cid, msg) {
  const ch = data().channels[cid];
  if (!ch || !ch.customAds) return;
  if (isInsideAds(msg)) return;
  const d = getDhakaDate();
  if (!data().dailyTracker[cid] || data().dailyTracker[cid].date !== d) {
    data().dailyTracker[cid] = { date:d, placed:0, usedAds:[], lastPlaced:0, pending:[] };
  }
  data().dailyTracker[cid].pending.push({
    mid: msg.message_id,
    text: msg.text || msg.caption || '',
    entities: msg.entities || [],
    readyAt: Date.now() + 30*60*1000,
    done: false
  });
}

async function processCustomAds() {
  const now = Date.now();
  for (const cid of Object.keys(data().channels)) {
    const ch = data().channels[cid];
    if (!ch || !ch.customAds) continue;
    const d = getDhakaDate();
    if (!data().dailyTracker[cid] || data().dailyTracker[cid].date !== d) continue;
    const tracker = data().dailyTracker[cid];
    const freq = ch.adsFrequency || 2;
    if (tracker.placed >= freq) continue;
    if (tracker.lastPlaced && now - tracker.lastPlaced < 10*60*1000) continue;
    const ready = tracker.pending.filter(p => !p.done && now >= p.readyAt);
    if (!ready.length) continue;
    const allAds = data().customAds;
    if (!allAds.length) continue;
    const unused = allAds.filter(a => !tracker.usedAds.includes(a.id));
    const pool = unused.length ? unused : allAds;
    const ad = pool[Math.floor(Math.random() * pool.length)];
    const post = ready[0];
    const newText = post.text + '\n\n📢 *Ads*\n\n' + ad.text;
    const res = await tg('editMessageText', { chat_id:cid, message_id:post.mid, text:newText, parse_mode:'Markdown' });
    if (res.ok) {
      if (!data().customAdsQueue[cid]) data().customAdsQueue[cid] = [];
      data().customAdsQueue[cid].push({ mid:post.mid, originalText:post.text, adId:ad.id, editedAt:now });
      post.done = true;
      tracker.placed++; tracker.usedAds.push(ad.id); tracker.lastPlaced = now;
      const s = ensureStats(cid);
      s.customads.today++; s.customads.month++; s.customads.total++;
      if (!ad.stats) ad.stats = { today:0, month:0, total:0 };
      ad.stats.today++; ad.stats.month++; ad.stats.total++;
      await saveData();
    }
  }
}

async function processReverts() {
  const now = Date.now();
  for (const cid of Object.keys(data().customAdsQueue || {})) {
    const queue = data().customAdsQueue[cid] || [];
    const keep = [];
    for (const item of queue) {
      if (now - item.editedAt >= 24*3600*1000) {
        if (item.originalText) await tg('editMessageText', { chat_id:cid, message_id:item.mid, text:item.originalText });
      } else keep.push(item);
    }
    data().customAdsQueue[cid] = keep;
  }
  await saveData();
}

async function processUnpins() {
  const now = Date.now();
  for (const cid of Object.keys(data().pinQueue || {})) {
    const queue = data().pinQueue[cid] || [];
    const keep = [];
    for (const item of queue) {
      if (now - item.pinnedAt >= 24*3600*1000) {
        await tg('unpinChatMessage', { chat_id:cid, message_id:item.mid });
      } else keep.push(item);
    }
    data().pinQueue[cid] = keep;
  }
  await saveData();
}

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
async function handleMessage(msg) {
  const uid = String(msg.from?.id);
  if (uid !== ADMIN_ID) return;
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const s = getState(uid);

  if (text === '/start') { clearState(uid); return send(chatId, '👋 *Ads Manager Bot*\n\nChoose an option:', mainMenu()); }

  if (s.waiting === 'add_channel') {
    clearState(uid);
    const res = await tg('getChat', { chat_id: text.trim() });
    if (!res.ok) return send(chatId, '❌ Channel not found. Make sure bot is admin first.', BACK_MAIN);
    const cid = String(res.result.id);
    const title = res.result.title || cid;
    const botId = BOT_TOKEN.split(':')[0];
    const member = await tg('getChatMember', { chat_id:cid, user_id:parseInt(botId) });
    if (!member.ok || member.result.status !== 'administrator') return send(chatId, `❌ Bot is not admin in *${title}*`, BACK_MAIN);
    if (data().channels[cid]) return send(chatId, `ℹ️ *${title}* already added!`, BACK_MAIN);
    data().channels[cid] = { id:cid, title, insideadsPins:true, customAds:false, adsFrequency:2, addedAt:Date.now() };
    await saveData();
    return send(chatId, `✅ *${title}* added!`, { inline_keyboard: [[{ text:`⚙️ Manage`, callback_data:`ch_${cid}` }], [{ text:'⬅️ Back', callback_data:'main' }]] });
  }

  if (s.waiting === 'create_ad') {
    clearState(uid);
    const id = `ad_${Date.now()}`;
    data().customAds.push({ id, text, entities:msg.entities||[], createdAt:Date.now(), stats:{today:0,month:0,total:0} });
    await saveData();
    return send(chatId, `✅ *Ad Created!*\n\n📢 *Ads*\n\n${text.slice(0,100)}`, adsMenu());
  }

  if (s.waiting === 'edit_ad') {
    clearState(uid);
    const ad = data().customAds.find(a => a.id===s.adId);
    if (ad) { ad.text=text; ad.entities=msg.entities||[]; await saveData(); }
    return send(chatId, '✅ Ad updated!', adsMenu());
  }

  if (s.waiting === 'freq_custom') {
    clearState(uid);
    const n = parseInt(text);
    if (isNaN(n) || n < 1) return send(chatId, '❌ Send a valid number.', BACK_MAIN);
    data().channels[s.cid].adsFrequency = n;
    await saveData();
    return send(chatId, `✅ Frequency set to *${n}*/day`, { inline_keyboard: [[{ text:'⬅️ Back', callback_data:`ch_${s.cid}` }]] });
  }
}

async function handleCallback(query) {
  const uid = String(query.from.id);
  if (uid !== ADMIN_ID) return tg('answerCallbackQuery', { callback_query_id:query.id });
  await tg('answerCallbackQuery', { callback_query_id:query.id });
  const chatId = query.message.chat.id;
  const mid = query.message.message_id;
  const d = query.data;

  if (d==='main') { clearState(uid); return edit(chatId, mid, '👋 *Ads Manager Bot*\n\nChoose an option:', mainMenu()); }
  if (d==='add_channel') { setState(uid, {waiting:'add_channel'}); return edit(chatId, mid, '➕ *Add Channel*\n\nSend channel username or ID:\n\nExample: `@YourChannel`', BACK_MAIN); }

  if (d==='channel_list') {
    const chs = data().channels;
    const ids = Object.keys(chs);
    if (!ids.length) return edit(chatId, mid, '📋 No channels yet.', BACK_MAIN);
    const rows = ids.map(id => [{ text:`📺 ${chs[id].title}`, callback_data:`ch_${id}` }]);
    rows.push([{ text:'⬅️ Back', callback_data:'main' }]);
    return edit(chatId, mid, '📋 *Your Channels:*', { inline_keyboard:rows });
  }

  if (d.startsWith('ch_')) {
    const cid = d.replace('ch_','');
    const ch = data().channels[cid];
    if (!ch) return edit(chatId, mid, '❌ Not found.', BACK_MAIN);
    return edit(chatId, mid, `📺 *${ch.title}*`, channelMenu(cid));
  }

  if (d.startsWith('toggle_ip_')) {
    const cid = d.replace('toggle_ip_','');
    data().channels[cid].insideadsPins = !data().channels[cid].insideadsPins;
    await saveData();
    return edit(chatId, mid, `📌 InsideAds Pins: *${data().channels[cid].insideadsPins ? 'ON ✅':'OFF ❌'}*`, channelMenu(cid));
  }

  if (d.startsWith('toggle_ca_')) {
    const cid = d.replace('toggle_ca_','');
    data().channels[cid].customAds = !data().channels[cid].customAds;
    await saveData();
    return edit(chatId, mid, `📣 Custom Ads: *${data().channels[cid].customAds ? 'ON ✅':'OFF ❌'}*`, channelMenu(cid));
  }

  if (d.startsWith('stats_')) {
    const cid = d.replace('stats_','');
    const s = ensureStats(cid);
    return edit(chatId, mid,
      `📊 *${data().channels[cid].title} Stats*\n\n📌 InsideAds\n• Today: ${s.insideads.today}\n• Month: ${s.insideads.month}\n• Total: ${s.insideads.total}\n\n📣 Custom Ads\n• Today: ${s.customads.today}\n• Month: ${s.customads.month}\n• Total: ${s.customads.total}`,
      { inline_keyboard:[[{ text:'⬅️ Back', callback_data:`ch_${cid}` }]] }
    );
  }

  if (d.startsWith('freq_') && !d.startsWith('freqcustom_')) {
    const cid = d.replace('freq_','');
    return edit(chatId, mid, `⚙️ *Ads Frequency*\n\nCurrent: *${data().channels[cid].adsFrequency||2}*/day`, freqMenu(cid, data().channels[cid].adsFrequency||2));
  }

  if (d.startsWith('setfreq_')) {
    const parts = d.split('_'); const n = parts.pop(); const cid = parts.slice(1).join('_');
    data().channels[cid].adsFrequency = parseInt(n); await saveData();
    return edit(chatId, mid, `✅ Frequency: *${n}*/day`, channelMenu(cid));
  }

  if (d.startsWith('freqcustom_')) {
    const cid = d.replace('freqcustom_','');
    setState(uid, { waiting:'freq_custom', cid });
    return edit(chatId, mid, '✏️ Send number for ads per day:', { inline_keyboard:[[{ text:'⬅️ Back', callback_data:`freq_${cid}` }]] });
  }

  if (d.startsWith('remove_confirm_')) {
    const cid = d.replace('remove_confirm_','');
    return edit(chatId, mid, `🗑️ Remove *${data().channels[cid].title}*?`, { inline_keyboard:[[{ text:'✅ Yes', callback_data:`remove_do_${cid}` },{ text:'❌ Cancel', callback_data:`ch_${cid}` }]] });
  }

  if (d.startsWith('remove_do_')) {
    const cid = d.replace('remove_do_','');
    for (const item of (data().pinQueue[cid]||[])) await tg('unpinChatMessage',{chat_id:cid,message_id:item.mid});
    for (const item of (data().customAdsQueue[cid]||[])) if(item.originalText) await tg('editMessageText',{chat_id:cid,message_id:item.mid,text:item.originalText});
    delete data().channels[cid]; delete data().stats[cid]; delete data().pinQueue[cid]; delete data().customAdsQueue[cid]; delete data().dailyTracker[cid];
    await saveData();
    return edit(chatId, mid, '✅ Channel removed!', { inline_keyboard:[[{ text:'⬅️ Back', callback_data:'channel_list' }]] });
  }

  if (d==='custom_ads_menu') return edit(chatId, mid, '📣 *Custom Ads*', adsMenu());
  if (d==='create_ad') { setState(uid,{waiting:'create_ad'}); return edit(chatId, mid, '✏️ *Create Ad*\n\nSend your ad text. Supports *bold*, _italic_, `mono`, [links](url):', { inline_keyboard:[[{ text:'⬅️ Back', callback_data:'custom_ads_menu' }]] }); }

  if (d.startsWith('ads_list_')) {
    const page = parseInt(d.replace('ads_list_',''))||0;
    return edit(chatId, mid, `📋 *My Ads* (${data().customAds.length} total)`, adsListMenu(page));
  }

  if (d.startsWith('view_ad_')) {
    const adId = d.replace('view_ad_','');
    const ad = data().customAds.find(a=>a.id===adId);
    if (!ad) return edit(chatId, mid, '❌ Not found.', adsMenu());
    return edit(chatId, mid, `📣 *Ad Preview:*\n\n📢 *Ads*\n\n${ad.text.slice(0,200)}`, adViewMenu(adId));
  }

  if (d.startsWith('edit_ad_')) { const adId=d.replace('edit_ad_',''); setState(uid,{waiting:'edit_ad',adId}); return edit(chatId,mid,'✏️ Send new ad text:',{inline_keyboard:[[{text:'⬅️ Back',callback_data:`view_ad_${adId}`}]]}); }
  if (d.startsWith('del_ad_confirm_')) { const adId=d.replace('del_ad_confirm_',''); return edit(chatId,mid,'🗑️ Delete this ad?',{inline_keyboard:[[{text:'✅ Delete',callback_data:`del_ad_do_${adId}`},{text:'❌ Cancel',callback_data:`view_ad_${adId}`}]]}); }
  if (d.startsWith('del_ad_do_')) { localData.customAds=data().customAds.filter(a=>a.id!==d.replace('del_ad_do_','')); await saveData(); return edit(chatId,mid,'✅ Deleted!',adsMenu()); }
  if (d==='delete_all_confirm') return edit(chatId,mid,'🗑️ Delete ALL ads?',{inline_keyboard:[[{text:'✅ Yes',callback_data:'delete_all_do'},{text:'❌ Cancel',callback_data:'ads_list_0'}]]});
  if (d==='delete_all_do') { localData.customAds=[]; await saveData(); return edit(chatId,mid,'✅ All deleted!',adsMenu()); }

  if (d.startsWith('ad_stats_')) {
    const ad = data().customAds.find(a=>a.id===d.replace('ad_stats_',''));
    if (!ad) return edit(chatId,mid,'❌ Not found.',adsMenu());
    const s = ad.stats||{today:0,month:0,total:0};
    return edit(chatId,mid,`📊 *Ad Stats*\n\n• Today: ${s.today}\n• Month: ${s.month}\n• Total: ${s.total}`,{inline_keyboard:[[{text:'⬅️ Back',callback_data:`view_ad_${ad.id}`}]]});
  }

  if (d==='global_stats') {
    let it=0,im=0,itot=0,ct=0,cm=0,ctot=0;
    for (const cid of Object.keys(data().channels)) { const s=ensureStats(cid); it+=s.insideads.today; im+=s.insideads.month; itot+=s.insideads.total; ct+=s.customads.today; cm+=s.customads.month; ctot+=s.customads.total; }
    return edit(chatId,mid,`📊 *Global Stats*\n\n📌 InsideAds\n• Today: ${it}\n• Month: ${im}\n• Total: ${itot}\n\n📣 Custom Ads\n• Today: ${ct}\n• Month: ${cm}\n• Total: ${ctot}`,{inline_keyboard:[[{text:'⬅️ Back',callback_data:'custom_ads_menu'}]]});
  }
}

// ─── UPDATE HANDLER ───────────────────────────────────────────────────────────
async function processUpdate(u) {
  if (u.message) return handleMessage(u.message);
  if (u.callback_query) return handleCallback(u.callback_query);
  const msg = u.channel_post || u.edited_channel_post;
  if (!msg) return;
  const cid = String(msg.chat.id);
  if (!data().channels[cid]) return;
  if (msg.pinned_message) { await tg('deleteMessage',{chat_id:cid,message_id:msg.message_id}); return; }
  if (isInsideAds(msg)) { await handleInsideAdsPost(cid, msg); }
  else if (u.channel_post) { await onNewPost(cid, msg); }
}

// ─── EXPRESS + WEBHOOK ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/', (_, res) => res.send('Bot is running!'));
app.get('/health', (_, res) => res.json({ ok:true, time:new Date().toISOString() }));

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  try { await processUpdate(req.body); }
  catch (e) { console.error('Webhook error:', e.message); }
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// ─── INTERVALS ────────────────────────────────────────────────────────────────
setInterval(processCustomAds, 60*1000);
setInterval(processReverts, 30*60*1000);
setInterval(processUnpins, 10*60*1000);
if (RENDER_URL) setInterval(() => axios.get(`${RENDER_URL}/health`).catch(()=>{}), 14*60*1000);

// ─── START ────────────────────────────────────────────────────────────────────
async function start() {
  await loadData();
  const preloaded = [
    { id:'-1002050685769', title:'Arc Comic (Art & Story)' },
    { id:'-1002040219241', title:'QuickAid Comic' },
    { id:'-1002097522734', title:'BrainRage' },
    { id:'-1002119822656', title:'Emma 💥 ( Jizzy B )' },
  ];
  let changed = false;
  for (const ch of preloaded) {
    if (!data().channels[ch.id]) { data().channels[ch.id] = { id:ch.id, title:ch.title, insideadsPins:true, customAds:false, adsFrequency:2, addedAt:Date.now() }; changed=true; }
  }
  if (changed) await saveData();

  if (RENDER_URL) {
    const webhookUrl = `${RENDER_URL}/webhook/${BOT_TOKEN}`;
    const res = await tg('setWebhook', { url:webhookUrl, allowed_updates:['message','callback_query','channel_post','edited_channel_post'] });
    console.log('Webhook:', res.ok ? `✅ Set to ${webhookUrl}` : `❌ ${res.description}`);
  } else {
    console.log('⚠️ RENDER_URL not set!');
  }

  console.log('✅ Bot started!');
  await tg('sendMessage', { chat_id:ADMIN_ID, text:'🤖 Bot started! Send /start for menu.' });
}

start().catch(console.error);
