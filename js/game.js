/* =========================================================
   オルグ！ ゲームエンジン
   ========================================================= */
'use strict';

const SAVE_KEY = 'orgu_save_v1';
const TICK_MS = 100;
const OFFLINE_CAP_H = 8;      // オフライン進行の上限（時間）
const OFFLINE_RATE = 0.5;     // オフライン中の効率

/* ---------------- 数値表記（万・億・兆…） ---------------- */
const JP_UNITS = [
  [1e68,'無量大数'],[1e64,'不可思議'],[1e60,'那由他'],[1e56,'阿僧祇'],
  [1e52,'恒河沙'],[1e48,'極'],[1e44,'載'],[1e40,'正'],[1e36,'澗'],
  [1e32,'溝'],[1e28,'穣'],[1e24,'秭'],[1e20,'垓'],[1e16,'京'],
  [1e12,'兆'],[1e8,'億'],[1e4,'万']
];
function fmt(n) {
  if (n === Infinity) return '∞';
  if (!isFinite(n) || isNaN(n)) return '0';
  if (n < 0) return '-' + fmt(-n);
  if (n < 10) return (n % 1 === 0) ? String(n) : n.toFixed(1);
  if (n < 1e4) return String(Math.floor(n));
  for (const [v, u] of JP_UNITS) {
    if (n >= v) {
      const x = n / v;
      const t = x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : String(Math.floor(x));
      return t + u;
    }
  }
  return n.toExponential(2);
}
function fmtTime(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  if (h) return `${h}時間${m}分`;
  if (m) return `${m}分${s}秒`;
  return `${s}秒`;
}

/* ---------------- 強化アイテムの統合リスト ---------------- */
const ALL_UPGRADES = [];
GENERATORS.forEach((g, gi) => {
  TIER_TITLES.forEach((title, t) => {
    ALL_UPGRADES.push({
      id: `t_${g.id}_${t}`, type: 'gen', gi, tier: t,
      icon: g.icon, name: `${g.name}・${title}`,
      cost: g.cost * TIER_COSTMUL[t],
      desc: `${g.name}の生産量が2倍。${g.quips[t]}`
    });
  });
});
CLICK_UPGRADES.forEach(u => ALL_UPGRADES.push(Object.assign({ type: 'click' }, u)));
GLOBAL_UPGRADES.forEach(u => ALL_UPGRADES.push(Object.assign({ type: 'global' }, u)));
const UPG_BY_ID = Object.fromEntries(ALL_UPGRADES.map(u => [u.id, u]));

/* ---------------- ステート ---------------- */
function newState() {
  return {
    spirit: 0, totalSpirit: 0, runSpirit: 0,
    clicks: 0, badges: 0,
    gens: GENERATORS.map(() => 0),
    upgrades: [], achievements: [],
    veteran: 0, prestiges: 0,
    playTime: 0, started: Date.now(), lastSave: Date.now(),
    offlineClaimed: 0,
    buffs: []
  };
}
let S = newState();
let buyAmount = 1;
let lastFrame = performance.now();

/* ---------------- 計算 ---------------- */
function hasUpg(id) { return S.upgrades.indexOf(id) !== -1; }

function genMult(gi) {
  let m = 1;
  for (let t = 0; t < TIER_TITLES.length; t++) if (hasUpg(`t_${GENERATORS[gi].id}_${t}`)) m *= 2;
  return m;
}
function buffMults() {
  const now = Date.now();
  let prod = 1, click = 1;
  for (const b of S.buffs) {
    if (b.until > now) { prod *= (b.mult || 1); click *= (b.clickMult || 1); }
  }
  return { prod, click };
}
function globalMult() {
  let m = 1;
  for (const u of GLOBAL_UPGRADES) if (hasUpg(u.id)) m *= u.mult;
  m *= 1 + S.veteran * 0.01;
  m *= 1 + S.achievements.length * 0.01;
  return m;
}
function baseSps() {
  let sps = 0;
  for (let i = 0; i < GENERATORS.length; i++) sps += GENERATORS[i].base * S.gens[i] * genMult(i);
  return sps * globalMult();
}
function sps() { return baseSps() * buffMults().prod; }

function clickPower() {
  let m = 1, pct = 0;
  for (const u of CLICK_UPGRADES) {
    if (!hasUpg(u.id)) continue;
    if (u.mult) m *= u.mult;
    if (u.sps) pct += u.sps;
  }
  const b = buffMults();
  return (m * globalMult() + sps() * pct) * b.click;
}

function genCost(gi, count) {
  return GENERATORS[gi].cost * Math.pow(1.15, count);
}
function bulkCost(gi, n) {
  const c = S.gens[gi];
  return GENERATORS[gi].cost * Math.pow(1.15, c) * (Math.pow(1.15, n) - 1) / 0.15;
}
function maxAffordable(gi) {
  const c = S.gens[gi], base = GENERATORS[gi].cost * Math.pow(1.15, c);
  const n = Math.floor(Math.log(S.spirit * 0.15 / base + 1) / Math.log(1.15));
  return Math.max(0, Math.min(n, 1000));
}
function wantAmount(gi) {
  return buyAmount === 'max' ? Math.max(1, maxAffordable(gi)) : buyAmount;
}

function pendingVeteran() {
  return Math.max(0, Math.floor(Math.cbrt(S.totalSpirit / 1e9)) - S.veteran);
}
function currentRank() {
  const m = memberCount(S);
  let r = RANKS[0];
  for (const x of RANKS) if (m >= x.at) r = x;
  return r.name;
}

/* ---------------- 操作 ---------------- */
function doClick(ev) {
  const p = clickPower();
  S.spirit += p; S.totalSpirit += p; S.runSpirit += p; S.clicks++;
  spawnFloat(ev, '+' + fmt(p));
  const btn = document.getElementById('shoutBtn');
  btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
}

function buyGen(gi) {
  const n = wantAmount(gi);
  const cost = bulkCost(gi, n);
  if (S.spirit < cost || n < 1) return;
  S.spirit -= cost; S.gens[gi] += n;
  toast(`${GENERATORS[gi].icon} ${GENERATORS[gi].name} が ${n}人 加入！`);
  renderShop(); renderUpgrades();
}

function buyUpgrade(id) {
  const u = UPG_BY_ID[id];
  if (!u || hasUpg(id) || S.spirit < u.cost) return;
  S.spirit -= u.cost; S.upgrades.push(id);
  toast(`${u.icon} 「${u.name}」を獲得！`);
  renderUpgrades(); renderShop();
}

function doPrestige() {
  const gain = pendingVeteran();
  if (gain < 1) return;
  closeModal();
  S.veteran += gain; S.prestiges++;
  S.spirit = 0; S.runSpirit = 0;
  S.gens = GENERATORS.map(() => 0);
  S.upgrades = [];
  S.buffs = [];
  toast(`🔁 組織再編！ 組合歴 +${gain}（全生産 +${(S.veteran)}%）`);
  renderAll(); save();
}

/* ---------------- 実績 ---------------- */
function checkAchievements() {
  for (const a of ACHIEVEMENTS) {
    if (S.achievements.indexOf(a.id) !== -1) continue;
    let ok = false;
    try { ok = a.check(S); } catch (e) { ok = false; }
    if (ok) {
      S.achievements.push(a.id);
      toast(`🏅 実績解除：${a.name}`, 4000);
      renderAchievements();
    }
  }
}

/* ---------------- 号外バッジ ---------------- */
let badgeTimer = null;
function scheduleBadge() {
  clearTimeout(badgeTimer);
  const wait = (60 + Math.random() * 120) * 1000;
  badgeTimer = setTimeout(spawnBadge, wait);
}
function spawnBadge() {
  const el = document.createElement('button');
  el.className = 'badge-drop';
  el.type = 'button';
  el.innerHTML = '<span>号外</span>';
  el.style.left = (8 + Math.random() * 78) + 'vw';
  el.style.top = (16 + Math.random() * 62) + 'vh';
  el.title = '号外をつかむ！';
  const kill = () => { el.remove(); scheduleBadge(); };
  el.addEventListener('click', () => { el.remove(); grabBadge(); scheduleBadge(); }, { once: true });
  document.body.appendChild(el);
  setTimeout(() => { if (el.isConnected) kill(); }, 13000);
}
function grabBadge() {
  S.badges++;
  const total = BUFFS.reduce((a, b) => a + b.weight, 0);
  let r = Math.random() * total, pick = BUFFS[0];
  for (const b of BUFFS) { r -= b.weight; if (r <= 0) { pick = b; break; } }
  if (pick.instant === 'cash') {
    const gain = Math.min(S.runSpirit * 0.15, sps() * 60 * 15) + 13;
    S.spirit += gain; S.totalSpirit += gain; S.runSpirit += gain;
    toast(`${pick.icon} ${pick.msg}（+${fmt(gain)}闘志）`, 5000);
  } else {
    S.buffs.push({
      id: pick.id, name: pick.name, icon: pick.icon,
      mult: pick.mult || 1, clickMult: pick.clickMult || 1,
      until: Date.now() + pick.time * 1000, dur: pick.time
    });
    toast(`${pick.icon} ${pick.msg}`, 5000);
  }
  renderBuffs();
}

/* ---------------- 保存 ---------------- */
function save(silent) {
  S.lastSave = Date.now();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(S));
    if (!silent) toast('💾 保存しました');
  } catch (e) {
    if (!silent) toast('⚠️ 保存できませんでした');
  }
}
function load() {
  let raw = null;
  try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
  if (!raw) return false;
  try {
    const d = JSON.parse(raw);
    const fresh = newState();
    S = Object.assign(fresh, d);
    S.gens = fresh.gens.map((_, i) => Number(d.gens && d.gens[i]) || 0);
    S.upgrades = (d.upgrades || []).filter(id => UPG_BY_ID[id]);
    S.achievements = (d.achievements || []).filter(id => ACHIEVEMENTS.some(a => a.id === id));
    S.buffs = [];
    return true;
  } catch (e) { return false; }
}
function offlineProgress() {
  const dt = Math.min((Date.now() - (S.lastSave || Date.now())) / 1000, OFFLINE_CAP_H * 3600);
  if (dt < 60) return;
  const gain = baseSps() * dt * OFFLINE_RATE;
  if (gain <= 0) return;
  S.spirit += gain; S.totalSpirit += gain; S.runSpirit += gain; S.offlineClaimed++;
  openModal('😴 おかえりなさい',
    `<p>あなたが寝ている間も、組合は動いていた。</p>
     <p class="big">＋${fmt(gain)} 闘志</p>
     <p class="dim">留守番時間 ${fmtTime(dt)}（効率${OFFLINE_RATE * 100}％・上限${OFFLINE_CAP_H}時間）</p>`,
    [{ label: 'ありがとう', act: closeModal }]);
}
function hardReset() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  S = newState();
  closeModal(); renderAll();
  toast('🧹 最初からやり直します');
}

/* ---------------- 描画 ---------------- */
const $ = id => document.getElementById(id);

function renderHeader() {
  $('spirit').textContent = fmt(S.spirit);
  $('sps').textContent = fmt(sps());
  $('members').textContent = fmt(memberCount(S));
  $('rank').textContent = currentRank();
  $('clickPower').textContent = fmt(clickPower());
  const pv = pendingVeteran();
  $('veteranNow').textContent = S.veteran;
  $('prestigeBtn').disabled = pv < 1;
  $('prestigeBtn').textContent = pv >= 1 ? `🔁 組織再編（組合歴 +${pv}）` : `🔁 組織再編（あと少し）`;
}

let shopRows = [];
function buildShop() {
  const box = $('shop'); box.innerHTML = ''; shopRows = [];
  GENERATORS.forEach((g, gi) => {
    const row = document.createElement('button');
    row.className = 'row gen'; row.type = 'button';
    row.innerHTML =
      `<span class="ico">${g.icon}</span>
       <span class="body">
         <span class="nm">${g.name}</span>
         <span class="cost"></span>
         <span class="sub"></span>
       </span>
       <span class="cnt">0</span>`;
    row.addEventListener('click', () => buyGen(gi));
    row.addEventListener('mouseenter', () => showTip(
      `${g.icon} ${g.name}`,
      `${g.desc}<br><span class="dim">1人あたり ${fmt(GENERATORS[gi].base * genMult(gi) * globalMult())} 闘志/秒</span>`));
    row.addEventListener('mouseleave', hideTip);
    box.appendChild(row);
    shopRows.push(row);
  });
}
function renderShop() {
  GENERATORS.forEach((g, gi) => {
    const row = shopRows[gi];
    if (!row) return;
    const unlocked = S.gens[gi] > 0 || S.totalSpirit >= g.cost * 0.4 || (gi > 0 && S.gens[gi - 1] > 0);
    row.classList.toggle('hidden', !unlocked);
    if (!unlocked) return;
    const n = wantAmount(gi);
    const cost = bulkCost(gi, n);
    row.querySelector('.cnt').textContent = S.gens[gi];
    row.querySelector('.cost').textContent = `🔥 ${fmt(cost)}${n > 1 ? ` ×${n}` : ''}`;
    row.querySelector('.sub').textContent =
      S.gens[gi] > 0 ? `合計 ${fmt(g.base * S.gens[gi] * genMult(gi) * globalMult())}/秒` : '未加入';
    row.classList.toggle('afford', S.spirit >= cost);
  });
}

const upgEls = new Map();
function upgradeAvailable(u) {
  if (hasUpg(u.id)) return false;
  if (u.type === 'gen') return S.gens[u.gi] >= TIER_UNLOCK[u.tier];
  return S.totalSpirit >= u.cost * 0.25;
}
function renderUpgrades() {
  const box = $('upgrades');
  let shown = 0;
  for (const u of ALL_UPGRADES) {
    const ok = upgradeAvailable(u);
    let el = upgEls.get(u.id);
    if (!ok) { if (el) { el.remove(); upgEls.delete(u.id); } continue; }
    shown++;
    if (!el) {
      el = document.createElement('button');
      el.className = 'upg'; el.type = 'button';
      el.innerHTML = `<span class="ico">${u.icon}</span>`;
      el.addEventListener('click', () => buyUpgrade(u.id));
      el.addEventListener('mouseenter', () => showTip(
        `${u.icon} ${u.name}`, `${u.desc}<br><span class="dim">🔥 ${fmt(u.cost)}</span>`));
      el.addEventListener('mouseleave', hideTip);
      upgEls.set(u.id, el);
      box.appendChild(el);
    }
    el.classList.toggle('afford', S.spirit >= u.cost);
  }
  $('upgEmpty').classList.toggle('hidden', shown > 0);
  $('upgCount').textContent = S.upgrades.length;
}

function renderAchievements() {
  const box = $('achievements');
  if (box.childElementCount !== ACHIEVEMENTS.length) {
    box.innerHTML = '';
    for (const a of ACHIEVEMENTS) {
      const el = document.createElement('div');
      el.className = 'ach'; el.dataset.id = a.id;
      el.innerHTML = `<span class="ico">${a.icon}</span>`;
      el.addEventListener('mouseenter', () => showTip(
        `${a.icon} ${a.name}`,
        (S.achievements.indexOf(a.id) !== -1 ? '<b class="got">達成済み</b><br>' : '') + a.desc));
      el.addEventListener('mouseleave', hideTip);
      box.appendChild(el);
    }
  }
  for (const el of box.children) el.classList.toggle('got', S.achievements.indexOf(el.dataset.id) !== -1);
  $('achCount').textContent = `${S.achievements.length}/${ACHIEVEMENTS.length}`;
}

function renderBuffs() {
  const box = $('buffs'); const now = Date.now();
  S.buffs = S.buffs.filter(b => b.until > now);
  box.innerHTML = '';
  for (const b of S.buffs) {
    const left = (b.until - now) / 1000;
    const el = document.createElement('div');
    el.className = 'buff' + (b.mult < 1 ? ' bad' : '');
    el.innerHTML = `<span>${b.icon} ${b.name}</span><b>${left.toFixed(0)}秒</b>
      <i style="width:${Math.max(0, left / b.dur * 100)}%"></i>`;
    box.appendChild(el);
  }
}

function renderStats() {
  const box = $('stats');
  box.innerHTML = `
    <dl>
      <dt>累計闘志（通算）</dt><dd>${fmt(S.totalSpirit)}</dd>
      <dt>累計闘志（今期）</dt><dd>${fmt(S.runSpirit)}</dd>
      <dt>総組合員数</dt><dd>${fmt(memberCount(S))} 人</dd>
      <dt>組織ランク</dt><dd>${currentRank()}</dd>
      <dt>声をかけた回数</dt><dd>${S.clicks.toLocaleString('ja-JP')} 回</dd>
      <dt>1声あたりの闘志</dt><dd>${fmt(clickPower())}</dd>
      <dt>つかんだ号外</dt><dd>${S.badges} 回</dd>
      <dt>組合歴（永続）</dt><dd>${S.veteran}（全生産 +${S.veteran}%）</dd>
      <dt>実績ボーナス</dt><dd>+${S.achievements.length}%</dd>
      <dt>組織再編の回数</dt><dd>${S.prestiges} 回</dd>
      <dt>強化アイテム</dt><dd>${S.upgrades.length} / ${ALL_UPGRADES.length}</dd>
      <dt>通算プレイ時間</dt><dd>${fmtTime(S.playTime)}</dd>
    </dl>`;
}

function renderAll() {
  lastCrowd = -1;
  renderHeader(); buildShop(); renderShop(); renderCrowd();
  upgEls.forEach(el => el.remove()); upgEls.clear();
  renderUpgrades(); renderAchievements(); renderBuffs(); renderStats();
}

/* ---------------- UI 小物 ---------------- */
function spawnFloat(ev, text) {
  const el = document.createElement('div');
  el.className = 'floaty'; el.textContent = text;
  const x = (ev && ev.clientX) || window.innerWidth / 2;
  const y = (ev && ev.clientY) || window.innerHeight / 2;
  el.style.left = x + 'px'; el.style.top = y + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}
const LOG = [];
function logMsg(msg) {
  LOG.unshift(`<span class="t">${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span> ${msg}`);
  if (LOG.length > 10) LOG.pop();
  const el = $('log');
  if (el) el.innerHTML = LOG.map(x => `<li>${x}</li>`).join('');
}

let lastCrowd = -1;
function renderCrowd() {
  const m = memberCount(S);
  if (m === lastCrowd) return;
  lastCrowd = m;
  const box = $('crowd');
  if (!box) return;
  if (m === 0) { box.innerHTML = '<span class="dim">まだ誰もいない。まずは声をかけよう。</span>'; return; }
  let html = '', total = 0;
  for (let i = GENERATORS.length - 1; i >= 0 && total < 300; i--) {
    for (let k = 0; k < S.gens[i] && total < 300; k++, total++) {
      html += `<span title="${GENERATORS[i].name}">${GENERATORS[i].icon}</span>`;
    }
  }
  if (m > 300) html += `<span class="more">ほか ${fmt(m - 300)} 人</span>`;
  box.innerHTML = html;
}

let toastTimer = null;
function toast(msg, ms) {
  logMsg(msg);
  const el = $('toast');
  el.innerHTML = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2600);
}
function showTip(title, body) {
  const t = $('tip');
  t.innerHTML = `<h4>${title}</h4><p>${body}</p>`;
  t.classList.add('show');
}
function hideTip() { $('tip').classList.remove('show'); }
document.addEventListener('mousemove', e => {
  const t = $('tip');
  if (!t.classList.contains('show')) return;
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.min(e.clientX + 16, window.innerWidth - w - 8) + 'px';
  t.style.top = Math.min(e.clientY + 16, window.innerHeight - h - 8) + 'px';
});

function openModal(title, html, buttons) {
  $('modalTitle').innerHTML = title;
  $('modalBody').innerHTML = html;
  const bar = $('modalButtons'); bar.innerHTML = '';
  (buttons || [{ label: '閉じる', act: closeModal }]).forEach(b => {
    const el = document.createElement('button');
    el.textContent = b.label; el.className = b.danger ? 'danger' : '';
    el.addEventListener('click', b.act);
    bar.appendChild(el);
  });
  $('modal').classList.add('show');
}
function closeModal() { $('modal').classList.remove('show'); }

/* ---------------- メインループ ---------------- */
function tick() {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 1);
  lastFrame = now;
  const gain = sps() * dt;
  S.spirit += gain; S.totalSpirit += gain; S.runSpirit += gain;
  S.playTime += dt;
  checkAchievements();
  renderHeader(); renderShop(); renderUpgrades(); renderBuffs(); renderCrowd();
}

/* ---------------- 起動 ---------------- */
function init() {
  const loaded = load();

  $('shoutBtn').addEventListener('click', doClick);
  document.querySelectorAll('.buyamt button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.buyamt button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      buyAmount = b.dataset.amt === 'max' ? 'max' : Number(b.dataset.amt);
      renderShop();
    });
  });
  document.querySelectorAll('.tabs button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('on'));
      document.querySelectorAll('.panel').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      $(b.dataset.tab).classList.add('on');
      if (b.dataset.tab === 'tab-stats') renderStats();
    });
  });

  $('prestigeBtn').addEventListener('click', () => {
    const g = pendingVeteran();
    openModal('🔁 組織再編',
      `<p>いまの組織をいったん解散し、経験を次の世代に引き継ぎます。</p>
       <ul>
         <li>闘志・組合員・強化アイテムは <b>すべてリセット</b></li>
         <li><b>組合歴 +${g}</b> を永続獲得（1につき全生産 +1%）</li>
         <li>実績と組合歴は引き継がれます</li>
       </ul>
       <p class="dim">再編後の組合歴：${S.veteran} → ${S.veteran + g}</p>`,
      [{ label: 'やめておく', act: closeModal },
       { label: `再編する（+${g}）`, act: doPrestige, danger: true }]);
  });

  $('menuBtn').addEventListener('click', () => {
    openModal('⚙️ メニュー',
      `<p>セーブデータはこのブラウザ（localStorage）に保存されます。</p>
       <p class="dim">最終保存：${new Date(S.lastSave).toLocaleString('ja-JP')}</p>`,
      [{ label: '💾 いま保存', act: () => { save(); closeModal(); } },
       { label: '📤 書き出し', act: exportSave },
       { label: '📥 読み込み', act: importSave },
       { label: '🧹 最初から', act: confirmReset, danger: true },
       { label: '閉じる', act: closeModal }]);
  });
  $('helpBtn').addEventListener('click', () => {
    openModal('❓ あそびかた',
      `<ol>
        <li><b>「声をかける」</b>を押して 🔥闘志 を稼ぐ。</li>
        <li>闘志で右の一覧から <b>組合員を加入</b> させる。組合員は自動で闘志を生む。</li>
        <li>たまに現れる <b>📰号外</b> をクリックすると強力なバフ。</li>
        <li>行き詰まったら <b>🔁組織再編</b>。すべてリセットする代わりに<b>組合歴</b>を獲得し、次の周が速くなる。</li>
       </ol>
       <p class="dim">オフライン中も${OFFLINE_RATE * 100}％の効率で最大${OFFLINE_CAP_H}時間ぶん進みます。</p>`);
  });

  $('ticker').innerHTML = `<span>${HEADLINES.concat(HEADLINES).join('　◆　')}</span>`;

  renderAll();
  if (loaded) offlineProgress();
  checkAchievements();

  setInterval(tick, TICK_MS);
  setInterval(() => save(true), 20000);
  window.addEventListener('beforeunload', () => save(true));
  scheduleBadge();
}

function confirmReset() {
  openModal('⚠️ 本当に最初から？',
    '<p>これまでの組合員・闘志・組合歴・実績が<b>すべて消えます</b>。取り消せません。</p>',
    [{ label: 'やめる', act: closeModal }, { label: '消す', act: hardReset, danger: true }]);
}
function exportSave() {
  const code = btoa(unescape(encodeURIComponent(JSON.stringify(S))));
  openModal('📤 セーブの書き出し',
    `<p>この文字列をコピーして保管してください。</p>
     <textarea id="saveBox" readonly rows="6">${code}</textarea>`,
    [{ label: 'コピー', act: () => {
        const t = $('saveBox'); t.select();
        navigator.clipboard ? navigator.clipboard.writeText(code).then(() => toast('📋 コピーしました'))
                            : document.execCommand('copy');
      } },
     { label: '閉じる', act: closeModal }]);
}
function importSave() {
  openModal('📥 セーブの読み込み',
    '<p>書き出した文字列を貼り付けてください。</p><textarea id="saveBox" rows="6"></textarea>',
    [{ label: '読み込む', act: () => {
        try {
          const d = JSON.parse(decodeURIComponent(escape(atob($('saveBox').value.trim()))));
          localStorage.setItem(SAVE_KEY, JSON.stringify(d));
          load(); closeModal(); renderAll(); toast('📥 読み込みました');
        } catch (e) { toast('⚠️ 読み込めませんでした'); }
      }, danger: true },
     { label: '閉じる', act: closeModal }]);
}

document.addEventListener('DOMContentLoaded', init);
