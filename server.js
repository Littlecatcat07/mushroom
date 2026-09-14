// 蘑菇村·怪物捕捉 —— 联机对战后端
// 职责：WebSocket 房间管理 + 服务端权威回合制战斗 + 排行榜接口
// 依赖：npm i ws
// 运行：node server.js   （默认端口 3000；可用 PORT 环境变量覆盖）

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

/* ============ 云端存档：库优先（Neon/Postgres）、落盘兜底 ============ */
const SAVE_DIR = path.join(__dirname, 'saves');
try{ fs.mkdirSync(SAVE_DIR, {recursive:true}); }catch(e){}
let pgPool = null;
try {
  const pgmod = require('pg');
  if(process.env.DATABASE_URL){
    pgPool = new pgmod.Pool({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:true} });
    pgPool.query(`CREATE TABLE IF NOT EXISTS saves (nick TEXT PRIMARY KEY, passhash TEXT NOT NULL, data TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`)
      .then(()=>console.log('[cloud] Neon 表已就绪'))
      .catch(e=>console.error('[cloud] 建表失败（将退回落盘）:', e.message));
  } else {
    console.log('[cloud] 未设置 DATABASE_URL，使用落盘兜底');
  }
} catch(e){ console.log('[cloud] 未安装 pg，使用落盘兜底'); }
function passHash(p){ return crypto.createHash('sha256').update('mush_'+p).digest('hex'); }
function safeNick(n){ return (n||'').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g,'').slice(0,40); }
async function cloudSave(nick, pass, data){
  nick = safeNick(nick); if(!nick) return {ok:false, msg:'昵称为空或含非法字符'};
  if(!pass) return {ok:false, msg:'口令为空'};
  const h = passHash(pass);
  const payload = (typeof data==='string') ? data : JSON.stringify(data||{});
  if(pgPool){
    try{
      const ex = await pgPool.query('SELECT passhash FROM saves WHERE nick=$1',[nick]);
      if(ex.rows.length && ex.rows[0].passhash!==h) return {ok:false, msg:'口令错误'};
      await pgPool.query('INSERT INTO saves(nick,passhash,data,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(nick) DO UPDATE SET data=EXCLUDED.data, updated_at=now()',[nick,h,payload]);
      return {ok:true, msg:'已保存到云端数据库'};
    }catch(e){ console.error('[cloud] DB保存失败，落盘兜底:', e.message); }
  }
  const f = path.join(SAVE_DIR, nick+'.json');
  try{
    let cur=null; try{ cur=JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){}
    if(cur && cur.passhash!==h) return {ok:false, msg:'口令错误'};
    fs.writeFileSync(f, JSON.stringify({passhash:h, data:payload}));
    return {ok:true, msg:'已保存到服务器本地（未配置数据库）'};
  }catch(e){ return {ok:false, msg:'保存失败：'+e.message}; }
}
async function cloudLoad(nick, pass){
  nick = safeNick(nick); if(!nick) return {ok:false, msg:'昵称为空或含非法字符'};
  if(!pass) return {ok:false, msg:'口令为空'};
  const h = passHash(pass);
  if(pgPool){
    try{
      const r = await pgPool.query('SELECT passhash,data FROM saves WHERE nick=$1',[nick]);
      if(!r.rows.length) return {ok:false, msg:'云端无该昵称的存档'};
      if(r.rows[0].passhash!==h) return {ok:false, msg:'口令错误'};
      return {ok:true, data:r.rows[0].data};
    }catch(e){ console.error('[cloud] DB读取失败，落盘兜底:', e.message); }
  }
  const f = path.join(SAVE_DIR, nick+'.json');
  try{
    const cur = JSON.parse(fs.readFileSync(f,'utf8'));
    if(cur.passhash!==h) return {ok:false, msg:'口令错误'};
    return {ok:true, data:cur.data};
  }catch(e){ return {ok:false, msg:'云端无该昵称的存档'}; }
}

/* ============ 战斗规则（与前端一致，服务端权威） ============ */
const ELEMENT_BEATS = { '金':'木', '木':'土', '土':'水', '水':'火', '火':'金' };
function elementMultiplier(skillEl, targetEl){
  skillEl = skillEl || '无'; targetEl = targetEl || '木';
  if(skillEl==='无' || skillEl===targetEl) return 1;
  if(ELEMENT_BEATS[skillEl]===targetEl) return 2;
  if(ELEMENT_BEATS[targetEl]===skillEl) return 0.5;
  return 1;
}
const MON_ELEMENT = {
  '小红菇':'木','大红菇':'木','蘑菇新兵':'木',
  '蘑菇士兵':'木','蘑菇剑士':'木','蘑菇盾兵':'木',
  '铁匠菇':'木','大锤菇':'木',
  '蘑菇女王':'木','反制·蘑菇女王':'木','信仰·蘑菇女王':'木',
  '树桩':'木','红眼树桩':'木','大蝙蝠':'无','恶蝠':'无','树精':'木','鬼木':'木','伐木工的恐惧':'木',
  '树人守卫':'木','红眼树人守卫':'木','声波蝙蝠':'无','爬蝠':'无','惊吓恶蝠':'无','病毒恶蝠':'无','树精头领':'木','鬼树':'木','恐吓·恐惧':'木','污染·恐惧':'木',
};
const SKILLS = {
  '攻击':     { power:100, cd:0, type:'single', element:'无' },
  '猛击':     { power:150, cd:2, type:'single', element:'无' },
  '剑舞':     { power:70, hits:3, cd:2, type:'multi', element:'金' },
  '盾反':     { power:0, cd:3, type:'shield', element:'无' },
  '连续猛击': { power:100, hits:2, cd:3, type:'multi', element:'无' },
  '防御':     { power:0, cd:3, type:'defend', mult:3, element:'无' },
  '高级防御': { power:0, cd:3, type:'defend', mult:4, element:'无' },
  '重斩':     { power:200, cd:3, type:'single', element:'金' },
  '重伤':     { power:200, cd:4, type:'heavy', element:'金' },
  '锻打':     { power:0, cd:3, type:'forge', element:'金' },
  '火球术':   { power:100, cd:0, type:'single', element:'火' },
  '引火':     { power:100, cd:2, type:'burn', element:'火' },
  '鼓舞':     { power:0, cd:3, type:'inspire', element:'无' },
  '三连火球术':{ power:100, hits:3, cd:3, type:'multi', element:'火' },
  '反制':     { power:0, cd:3, type:'counter', turns:3, element:'无' },
  '灼香火':   { power:100, cd:5, type:'burnMax', element:'火' },
  // 鬼木之森技能（与前端一致）
  '守护':     { power:0, cd:3, type:'guard', element:'无' },
  '狂暴':     { power:0, cd:4, type:'berserk', element:'无' },
  '撕咬':     { power:70, hits:3, cd:2, type:'multi', element:'无' },
  '回声':     { power:100, cd:3, type:'echo', element:'无' },
  '冲锋':     { power:75, cd:1, type:'charge', element:'无' },
  '蓄力':     { power:0, cd:3, type:'charge_up', element:'无' },
  '惊吓':     { power:0, cd:3, type:'fear', element:'无' },
  '瞬击':     { power:125, cd:1, type:'single', element:'无' },
  '汲取':     { power:125, cd:3, type:'drain', element:'木' },
  '扎根':     { power:0, cd:4, type:'root', element:'木' },
  '传染':     { power:75, cd:3, type:'infect', element:'木' },
  '恐吓':     { power:0, cd:3, type:'menace', element:'无' },
  '污染':     { power:100, cd:5, type:'pollute', element:'无' },
  '追击':     { power:100, cd:1, type:'zhui', element:'无' },
  '看破':     { power:0, cd:2, type:'kanpo', element:'无' },
  '坚韧':     { power:0, cd:3, type:'tenacity', element:'无' },
  '施毒':     { power:0, cd:3, type:'applypoison', element:'木' },
  '毒发':     { power:0, cd:3, type:'dufa', element:'木' },
  '寄生':     { power:0, cd:0, type:'parasite', element:'木' },
  // 第三章 · 腐化沼泽技能
  '投石':     { power:125, cd:1, type:'single', element:'土' },
  '回春':     { power:0, cd:4, type:'regen', element:'木' },
  '连续撕咬': { power:80, hits:4, cd:3, type:'multi', element:'无' },
  '流血':     { power:100, cd:2, type:'bleed', element:'无' },
  '逐浪':     { power:150, cd:4, type:'wave', element:'水' },
  '刺击':     { power:85, cd:1, type:'thorn', element:'金' },
  '顽固':     { power:0, cd:3, type:'sturdy', element:'无' },
  '潜行':     { power:0, cd:4, type:'stealth', element:'无' },
  '以静制动': { power:0, cd:3, type:'static', element:'土' },
  '土墙':     { power:0, cd:2, type:'earthwall', element:'土' },
  '硬甲':     { power:0, cd:5, type:'hardarmor', element:'土' },
  '转守为攻': { power:0, cd:3, type:'counterattack', element:'无' },
  '酸液喷吐': { power:225, cd:4, type:'acid', element:'木' },
  '重力领域': { power:0, cd:5, type:'gravity', element:'无' },
  // 腐化沼泽进化新技能
  '防御':     { power:0, cd:3, type:'defend', mult:3, element:'无' },
  '软甲':     { power:0, cd:1, type:'softarmor', element:'无' },
  '喷发':     { power:125, cd:4, type:'erupt', element:'火' },
  '迅捷':     { power:0, cd:3, type:'swift', element:'无' },
  '酸雨':     { power:125, cd:3, type:'acidrain', element:'木' },
  '超重':     { power:0, cd:3, type:'overweight', element:'无' },
};
function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function curDef(m){
  let d=m.def;
  if(m.shield>0) d*=2;
  if(m.defend>0) d*=(m.defendMult||3);
  if(m.defBuff>0) d=Math.floor(d*1.2);
  return d;
}
function applyDamage(target, dmg, attacker, triggerCounter){
  triggerCounter = triggerCounter!==false;
  let remaining = dmg;
  if(triggerCounter!==false && (target.evade||0)>0 && Math.random()<0.5){ log(`  💨 ${target.name} 闪避了攻击！`); return 0; }
  if((target.vuln||0)>0 && remaining>0) remaining=Math.floor(remaining*1.5);
  if((target.tenacity||0)>0 && remaining>0) remaining=Math.floor(remaining*0.75);
  if((target.shieldHp||0)>0 && remaining>0){
    const absorbed=Math.min(target.shieldHp, remaining);
    target.shieldHp -= absorbed; remaining -= absorbed;
  }
  target.hp = Math.max(0, target.hp - remaining);
  if(target.shield>0 && remaining>0){
    const reflect = Math.min(remaining, target.atk*5);
    attacker.hp = Math.max(0, attacker.hp - reflect);
    if(reflect>0) log(`  🛡️ ${target.name}盾反反弹 ${reflect} 点伤害！`);
  }
  if(triggerCounter && remaining>0 && (target.counter||0)>0 && attacker){
    const cdmg = Math.max(0, Math.floor(target.atk*50/100) - curDef(attacker));
    if(cdmg>0){ attacker.hp = Math.max(0, attacker.hp - cdmg); log(`  🔁 ${target.name}【反制】反击 ${cdmg} 点伤害！`); }
  }
  return dmg;
}
function computeDamage(attacker, defender, power, el){
  const mult = elementMultiplier(el, defender.element);
  const effAtk = attacker.atk * (attacker.atkBuff||1) * (attacker.atkUp>0?1.2:1);
  const weakF = (attacker.weak>0)?0.75:1;
  const chargeF = (attacker.charged)?3:1;
  const pre = effAtk * power / 100 * mult * weakF * chargeF;
  const dmg = Math.max(0, Math.floor(pre - curDef(defender)));   // 防御正常生效
  return { dmg, mult };
}
let BATTLE_LOG = [];
function log(s){ BATTLE_LOG.push(s); }

function performSkill(attacker, defender, skillName){
  const sk = SKILLS[skillName];
  const el = sk ? (sk.element || '无') : '无';
  if(!sk){ const {dmg}=computeDamage(attacker,defender,100,el); applyDamage(defender,dmg,attacker); attacker.charged=false; log(`${attacker.name} 使用了未知技能，化为普通攻击，造成 ${dmg} 点伤害！`); return; }

  if(sk.type==='shield'){ attacker.shield=1; log(`${attacker.name} 使用【盾反】，进入盾反状态！`); return; }
  if(sk.type==='defend'){ attacker.defend=1; attacker.defendMult=sk.mult||3; log(`${attacker.name} 使用【${skillName}】，本回合防御大幅提升！`); return; }
  if(sk.type==='inspire'){ attacker.inspire=(attacker.inspire||0)+3; attacker.atkBuff=1.5; log(`${attacker.name} 使用【鼓舞】，获得3层【鼓舞】（攻击+50%）！`); return; }
  if(sk.type==='zhui'){ const {dmg,mult}=computeDamage(attacker,defender,sk.power,el); const dealt=applyDamage(defender,dmg,attacker); attacker.inspire=(attacker.inspire||0)+1; attacker.atkBuff=Math.max(attacker.atkBuff,1.5); attacker.charged=false; log(`${attacker.name} 使用【追击】，造成 ${dealt} 点伤害${mult>1?'（克制×2）':''}，并获得1层鼓舞！`); return; }
  if(sk.type==='kanpo'){ attacker.inspire=(attacker.inspire||0)+1; attacker.atkBuff=Math.max(attacker.atkBuff,1.5); defender.vuln=(defender.vuln||0)+2; attacker.charged=false; log(`${attacker.name} 使用【看破】，自身获得1层鼓舞，并使 ${defender.name} 获得2层易伤！`); return; }
  if(sk.type==='tenacity'){ attacker.tenacity=(attacker.tenacity||0)+4; attacker.charged=false; log(`${attacker.name} 使用【坚韧】，获得4层【坚韧】（受伤-25%）！`); return; }
  if(sk.type==='applypoison'){ defender.poison=(defender.poison||0)+5; defender.poisonAtk=attacker.atk; defender.poisonEl='木'; attacker.charged=false; log(`${attacker.name} 使用【施毒】，使 ${defender.name} 获得5层中毒！`); return; }
  if(sk.type==='dufa'){ defender.poison=(defender.poison||0)+1; const layers=defender.poison; const {dmg,mult}=computeDamage(attacker,defender, layers*50, '木'); const dealt=applyDamage(defender,dmg,attacker); attacker.charged=false; log(`${attacker.name} 使用【毒发】，使 ${defender.name} 中毒+1层，造成 ${dealt} 点木系伤害（50×${layers}）！`); return; }
  if(sk.type==='parasite'){ defender.parasite={atk:attacker.atk, el:attacker.element, owner:(arguments[3]||1)}; attacker.charged=false; log(`${attacker.name} 对 ${defender.name} 施加【寄生】状态！`); return; }
  if(sk.type==='counter'){ attacker.counter=sk.turns||3; log(`${attacker.name} 进入【反制】状态，3回合内受击反击！`); return; }
  if(sk.type==='forge'){
    const power = randInt(100,200);
    const {dmg, mult} = computeDamage(attacker, defender, power, el);
    applyDamage(defender, dmg, attacker);
    attacker.defBuff = 3; attacker.charged=false;
    log(`${attacker.name} 使用【锻打】，造成 ${dmg} 点伤害${mult>1?'（克制×2）':mult<1?'（被克制×0.5）':''}，并获得3回合防御提升！`);
    return;
  }
  if(sk.type==='burn'){
    const {dmg, mult} = computeDamage(attacker, defender, sk.power, el);
    applyDamage(defender, dmg, attacker);
    defender.burn = (defender.burn||0) + 3; attacker.charged=false;
    log(`${attacker.name} 使用【引火】，造成 ${dmg} 点伤害${mult>1?'（克制×2）':mult<1?'（被克制×0.5）':''}，并使 ${defender.name} 获得3层灼烧！`);
    return;
  }
  if(sk.type==='burnMax'){
    const extra = Math.floor(defender.maxHp * 10 / 100);
    const {dmg, mult} = computeDamage(attacker, defender, sk.power, el);
    const total = Math.max(0, dmg + extra);
    applyDamage(defender, total, attacker);
    attacker.charged=false;
    log(`${attacker.name} 使用【灼香火】，造成 ${total} 点伤害${mult>1?'（克制×2）':mult<1?'（被克制×0.5）':''}！`);
    return;
  }
  if(sk.type==='guard'){ const sh=Math.floor(attacker.maxHp*20/100); attacker.shieldHp=sh; log(`${attacker.name} 使用【守护】，获得护盾 ${sh}（最大生命20%）！`); return; }
  if(sk.type==='berserk'){ attacker.atkBuff=2; attacker.atkBuffTurns=2; log(`${attacker.name} 使用【狂暴】，接下来2回合攻击+100%！`); return; }
  if(sk.type==='charge_up'){ attacker.charged=true; log(`${attacker.name} 使用【蓄力】，下回合伤害大幅提升！`); return; }
  if(sk.type==='echo'){ const {dmg,mult}=computeDamage(attacker,defender,sk.power,el); const dealt=applyDamage(defender,dmg,attacker); defender.weak=(defender.weak||0)+3; attacker.charged=false; log(`${attacker.name} 使用【回声】，造成 ${dealt} 点伤害${mult>1?'（克制×2）':''}，并使 ${defender.name} 获得3层虚弱！`); return; }
  if(sk.type==='charge'){ const {dmg,mult}=computeDamage(attacker,defender,sk.power,el); const dealt=applyDamage(defender,dmg,attacker); defender.weak=(defender.weak||0)+1; attacker.charged=false; log(`${attacker.name} 使用【冲锋】，造成 ${dealt} 点伤害${mult>1?'（克制×2）':''}，并使 ${defender.name} 获得1层虚弱！`); return; }
  if(sk.type==='fear'){ if((defender.weak||0)>0){ const {dmg}=computeDamage(attacker,defender,100,el); const dealt=applyDamage(defender,dmg,attacker); attacker.charged=false; log(`${attacker.name} 使用【惊吓】，对已有虚弱的 ${defender.name} 造成 ${dealt} 点伤害！`); } else { defender.weak=(defender.weak||0)+4; log(`${attacker.name} 使用【惊吓】，使 ${defender.name} 获得4层虚弱！`); } return; }
  if(sk.type==='drain'){ const {dmg,mult}=computeDamage(attacker,defender,sk.power,el); const dealt=applyDamage(defender,dmg,attacker); const heal=Math.min(dealt, attacker.maxHp-attacker.hp); attacker.hp+=heal; attacker.charged=false; log(`${attacker.name} 使用【汲取】，造成 ${dealt} 点伤害${mult>1?'（克制×2）':''}，回复自身 ${heal} 点血量！`); return; }
  if(sk.type==='root'){ const heal=Math.min(Math.floor(attacker.maxHp*10/100), attacker.maxHp-attacker.hp); attacker.hp+=heal; attacker.shieldHp=Math.floor(attacker.maxHp*30/100); attacker.charged=false; log(`${attacker.name} 使用【扎根】，回复 ${heal} 点血量，并获得护盾（最大生命30%）！`); return; }
  if(sk.type==='infect'){ const {dmg,mult}=computeDamage(attacker,defender,sk.power,el); const dealt=applyDamage(defender,dmg,attacker); if((defender.poison||0)>0) defender.poison+=5; else defender.poison=5; defender.poisonAtk=attacker.atk; defender.poisonEl='木'; attacker.charged=false; log(`${attacker.name} 使用【传染】，造成 ${dealt} 点伤害${mult>1?'（克制×2）':''}，并使 ${defender.name} 获得5层中毒！`); return; }
  if(sk.type==='menace'){ defender.weak=(defender.weak||0)+1; const layers=(defender.weak||0); const {dmg}=computeDamage(attacker,defender, layers*50, el); const dealt=applyDamage(defender,dmg,attacker); attacker.charged=false; log(`${attacker.name} 使用【恐吓】，使 ${defender.name} 获得1层虚弱，并造成 ${dealt} 点伤害（虚弱层数×50）！`); return; }
  if(sk.type==='pollute'){ const {dmg}=computeDamage(attacker,defender,100,el); const dealt=applyDamage(defender,dmg,attacker); defender.weak=(defender.weak||0)+3; defender.vuln=(defender.vuln||0)+3; attacker.charged=false; log(`${attacker.name} 使用【污染】，造成 ${dealt} 点伤害，并使 ${defender.name} 获得3层虚弱与3层易伤！`); return; }
  if(sk.type==='regen'){ const heal=Math.min(Math.floor(attacker.maxHp*40/100), attacker.maxHp-attacker.hp); attacker.hp+=heal; attacker.charged=false; log(`${attacker.name} 使用【回春】，回复 ${heal} 点血量（最大生命40%）！`); return; }
  if(sk.type==='bleed'){ const {dmg,mult}=computeDamage(attacker,defender,100,'无'); const dealt=applyDamage(defender,dmg,attacker); defender.weak=(defender.weak||0)+2; attacker.charged=false; log(`${attacker.name} 使用【流血】，造成 ${dealt} 点伤害，并使 ${defender.name} 获得2层虚弱！`); return; }
  if(sk.type==='wave'){ const {dmg,mult}=computeDamage(attacker,defender,150,'水'); const dealt=applyDamage(defender,dmg,attacker); attacker.inspire=(attacker.inspire||0)+3; attacker.atkBuff=Math.max(attacker.atkBuff,1.5); attacker.charged=false; log(`${attacker.name} 使用【逐浪】，造成 ${dealt} 点水系伤害，并获得3层鼓舞！`); return; }
  if(sk.type==='thorn'){ const {dmg,mult}=computeDamage(attacker,defender,85,'金'); const dealt=applyDamage(defender,dmg,attacker); if(Math.random()<0.5) defender.weak=(defender.weak||0)+1; else defender.vuln=(defender.vuln||0)+1; attacker.charged=false; log(`${attacker.name} 使用【刺击】，造成 ${dealt} 点金系伤害，并使 ${defender.name} 随机获得1层虚弱或易伤！`); return; }
  if(sk.type==='sturdy'){ attacker.defend=1; attacker.defendMult=3; attacker.tenacity=(attacker.tenacity||0)+2; attacker.charged=false; log(`${attacker.name} 使用【顽固】，本回合防御×3，并获得2层坚韧！`); return; }
  if(sk.type==='stealth'){ attacker.evade=(attacker.evade||0)+3; attacker.charged=false; log(`${attacker.name} 使用【潜行】，获得3层闪避（每段伤害50%概率闪避）！`); return; }
  if(sk.type==='static'){ attacker.tenacity=(attacker.tenacity||0)+1; const layers=(attacker.tenacity||0); const {dmg,mult}=computeDamage(attacker,defender, layers*50, '土'); const dealt=applyDamage(defender,dmg,attacker); attacker.charged=false; log(`${attacker.name} 使用【以静制动】，获得1层坚韧，并造成 ${dealt} 点土系伤害（50×${layers}坚韧层数）！`); return; }
  if(sk.type==='acid'){ const {dmg,mult}=computeDamage(attacker,defender,225,'木'); const dealt=applyDamage(defender,dmg,attacker); defender.poison=(defender.poison||0)+3; defender.poisonAtk=attacker.atk; defender.poisonEl='木'; attacker.charged=false; log(`${attacker.name} 使用【酸液喷吐】，造成 ${dealt} 点木系伤害，并使 ${defender.name} 获得3层中毒！`); return; }
  if(sk.type==='gravity'){ defender.weak=(defender.weak||0)+3; defender.vuln=(defender.vuln||0)+2; attacker.tenacity=(attacker.tenacity||0)+1; attacker.charged=false; log(`${attacker.name} 使用【重力领域】，使对方获得3层虚弱与2层易伤，自身获得1层坚韧！`); return; }
  if(sk.type==='heavy'){ const {dmg,mult}=computeDamage(attacker,defender,200, el); const dealt=applyDamage(defender,dmg,attacker); defender.vuln=(defender.vuln||0)+2; attacker.charged=false; log(`${attacker.name} 使用【重伤】，造成 ${dealt} 点伤害，并使 ${defender.name} 获得2层易伤！`); return; }
  if(sk.type==='softarmor'){ attacker.defBuff=3; attacker.tenacity=(attacker.tenacity||0)+2; attacker.charged=false; log(`${attacker.name} 使用【软甲】，防御提高20%（3回合），并获得2层坚韧！`); return; }
  if(sk.type==='erupt'){ const {dmg,mult}=computeDamage(attacker,defender,125,'火'); const dealt=applyDamage(defender,dmg,attacker); defender.burn=(defender.burn||0)+4; defender.burnAtk=attacker.atk; defender.burnEl='火'; attacker.charged=false; log(`${attacker.name} 使用【喷发】，造成 ${dealt} 点火系伤害，并使 ${defender.name} 获得4层灼烧！`); return; }
  if(sk.type==='swift'){ attacker.evade=(attacker.evade||0)+2; attacker.charged=false; log(`${attacker.name} 使用【迅捷】，获得2层闪避（每段伤害50%概率闪避）！`); return; }
  if(sk.type==='acidrain'){ const {dmg,mult}=computeDamage(attacker,defender,125,'木'); const dealt=applyDamage(defender,dmg,attacker); defender.poison=(defender.poison||0)+3; defender.poisonAtk=attacker.atk; defender.poisonEl='木'; defender.weak=(defender.weak||0)+3; attacker.charged=false; log(`${attacker.name} 使用【酸雨】，造成 ${dealt} 点木系伤害，并使 ${defender.name} 获得3层中毒与3层虚弱！`); return; }
  if(sk.type==='earthwall'){ const sh=Math.floor(attacker.maxHp*30/100); attacker.shieldHp=sh; attacker.tenacity=(attacker.tenacity||0)+1; attacker.charged=false; log(`${attacker.name} 使用【土墙】，获得护盾 ${sh}（最大生命30%）与1层坚韧！`); return; }
  if(sk.type==='hardarmor'){ attacker.defend=1; attacker.defendMult=4; const sh=Math.floor(attacker.maxHp*30/100); attacker.shieldHp=sh; attacker.tenacity=(attacker.tenacity||0)+5; attacker.charged=false; log(`${attacker.name} 使用【硬甲】，防御×4，获得护盾 ${sh}（最大生命30%）与5层坚韧！`); return; }
  if(sk.type==='counterattack'){ if((attacker.tenacity||0)>0){ const layers=attacker.tenacity; const {dmg}=computeDamage(attacker,defender, layers*100, '无'); const dealt=applyDamage(defender,dmg,attacker); attacker.tenacity=0; attacker.charged=false; log(`${attacker.name} 使用【转守为攻】，以 ${layers} 层坚韧发动攻击，造成 ${dealt} 点伤害（坚韧层数×100%），并清空所有坚韧！`); } else { attacker.inspire=(attacker.inspire||0)+5; attacker.atkBuff=Math.max(attacker.atkBuff,1.5); attacker.vuln=(attacker.vuln||0)+1; attacker.charged=false; log(`${attacker.name} 使用【转守为攻】，无坚韧可转，自身获得5层鼓舞与1层易伤！`); } return; }
  if(sk.type==='overweight'){ attacker.atkUp=3; attacker.tenacity=(attacker.tenacity||0)+3; attacker.shieldHp=Math.floor(attacker.maxHp*10/100); attacker.charged=false; log(`${attacker.name} 使用【超重】，攻击提高20%（3回合），获得3层坚韧与护盾（生命10%）！`); return; }
  const hits = sk.hits||1;
  const power = (typeof sk.power==='number') ? sk.power : randInt(100,200);
  const mult = elementMultiplier(el, defender.element);
  let total=0;
  for(let i=0;i<hits;i++){
    const {dmg} = computeDamage(attacker, defender, power, el);
    total+=dmg; applyDamage(defender, dmg, attacker);
    if(defender.hp<=0) break;
  }
  attacker.charged=false;
  log(`${attacker.name} 使用【${skillName}】，造成 ${total} 点伤害${mult>1?'（克制×2！）':mult<1?'（被克制×0.5）':''}！`);
}
function tickBurn(m){
  if((m.burn||0)<=0) return;
  m.burn--;
  const raw = Math.floor(10 * 50 / 100);
  const mult = elementMultiplier('火', m.element);
  const real = Math.max(0, Math.floor((raw - curDef(m)) * mult));
  applyDamage(m, real, {atk:10, element:'火'}, false);
  if(real>0) log(`🔥 ${m.name} 受到灼烧，损失 ${real} 点血量！`);
}
function tickPoison(m){
  if((m.poison||0)<=0) return;
  m.poison--;
  const atk = m.poisonAtk||10; const el = m.poisonEl||'木';
  const fake = {atk:atk, atkBuff:1, weak:0, charged:false, shield:0, shieldHp:0, defend:0, defendMult:3, defBuff:0, counter:0, element:el};
  const { dmg } = computeDamage(fake, m, 50, el);
  applyDamage(m, dmg, fake, false);
  if(dmg>0) log(`☠️ ${m.name} 受到中毒，损失 ${dmg} 点血量！`);
}
function tickParasite(m, healer){
  if(!m.parasite) return;
  const {atk, el} = m.parasite;
  const mult = elementMultiplier(el, m.element);
  let dmg = Math.max(0, Math.floor(atk * 10 / 100 * mult));
  m.hp = Math.max(0, m.hp - dmg);
  let healed = 0;
  if(healer){ healed = Math.min(dmg, healer.maxHp - healer.hp); healer.hp += healed; }
  if(dmg>0) log(`🩸 ${m.name} 受到寄生，损失 ${dmg} 点生命（回复 ${healed}）！`);
}
function startTurn(m){
  if(m.shield>0) m.shield--;
  if(m.defend>0){ m.defend--; if(m.defend===0) m.defendMult=3; }
  if(m.defBuff>0) m.defBuff--;
  if((m.inspire||0)>0) m.inspire--;
  if(m.atkBuffTurns>0) m.atkBuffTurns--;
  let buff=1; if((m.inspire||0)>0) buff=Math.max(buff,1.5); if(m.atkBuffTurns>0) buff=Math.max(buff, 2);
  m.atkBuff=buff;
  if(m.counter>0) m.counter--;
  if((m.weak||0)>0) m.weak--;
  if((m.poison||0)>0) m.poison--;
  if((m.vuln||0)>0) m.vuln--;
  if((m.evade||0)>0) m.evade--;
  if((m.atkUp||0)>0) m.atkUp--;
}
function endCd(m, used){
  for(const s of m.skills){ if(s===used) m.cd[s] = (SKILLS[s]?SKILLS[s].cd:0); else m.cd[s]=Math.max(0,(m.cd[s]||0)-1); }
}
function firstAlive(team){ for(let i=0;i<team.length;i++) if(team[i].hp>0) return i; return -1; }
function hydrate(raw){
  const skills = (raw.skills||[]).slice();
  const m = {
    name:raw.name, level:raw.level||1, element: raw.element || MON_ELEMENT[raw.name] || '木',
    maxHp:raw.maxHp, hp: (raw.curHp!=null?raw.curHp:raw.maxHp), atk:raw.atk, def:raw.def,
    skills,
    shield:0, shieldHp:0, defend:0, defendMult:3, defBuff:0, atkBuff:1, atkBuffTurns:0, berserkMult:2, counter:0, burn:0, weak:0, charged:false, inspire:0, tenacity:0, parasite:null, poison:0, poisonAtk:0, poisonEl:'木', vuln:0, evade:0, atkUp:0, cd:{}
  };
  for(const s of skills) m.cd[s]=0;
  return m;
}

/* ============ 房间 / 战斗管理 ============ */
const rooms = new Map();
function genRoom(){ let r; do{ r = Math.random().toString(36).slice(2,8).toUpperCase(); }while(rooms.has(r)); return r; }
function send(ws, obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }
function publicMonster(m){ return { name:m.name, level:m.level, element:m.element, hp:m.hp, maxHp:m.maxHp, atk:m.atk, def:m.def, skills:m.skills, cur:!!(m.hp>0), cd:m.cd, shieldHp:(m.shieldHp||0), weak:(m.weak||0), charged:!!m.charged, inspire:(m.inspire||0), tenacity:(m.tenacity||0), poison:(m.poison||0), vuln:(m.vuln||0), parasite:!!m.parasite }; }
function snapshot(room){
  return {
    type:'state', room:room.code, turn:room.turn, over:room.over, winner:room.winner,
    p1: room.p1team.map(publicMonster), p2: room.p2team.map(publicMonster),
    p1cur: room.p1cur, p2cur: room.p2cur,
    names: { 1:room.names[1], 2:room.names[2] }, log: BATTLE_LOG.slice(-40), msg: room.msg || ''
  };
}
function startMatch(room){
  BATTLE_LOG = [];
  room.battle = true; room.over=false; room.winner=0;
  room.turn = Math.random()<0.5 ? 1 : 2;   // 开局随机一方先手
  room.p1cur = firstAlive(room.p1team); room.p2cur = firstAlive(room.p2team);
  log(`⚔️ 对战开始！${room.turn===1?room.names[1]:room.names[2]} 先手（击杀对方怪物的一方将保持先手）。`);
  broadcast(room);
}
function broadcast(room){ send(room.p1, snapshot(room)); send(room.p2, snapshot(room)); }
function sideMonster(room, side){ return side===1 ? room.p1team[room.p1cur] : room.p2team[room.p2cur]; }
function doAction(room, side, action){
  if(room.over || room.turn!==side) return;
  const myTeam = side===1?room.p1team:room.p2team;
  const myCur = side===1?room.p1cur:room.p2cur;
  const opTeam = side===1?room.p2team:room.p1team;
  const opCur  = side===1?room.p2cur:room.p1cur;
  const actor = myTeam[myCur]; const defender = opTeam[opCur];
  if(!actor || actor.hp<=0 || !defender) return;
  if(action.type==='switch'){
    const idx = action.idx;
    if(idx<0||idx>=myTeam.length||myTeam[idx].hp<=0||idx===myCur) return;
    if(side===1) room.p1cur=idx; else room.p2cur=idx;
    log(`🔄 ${room.names[side]} 切换为 ${myTeam[idx].name}！`);
    if(myTeam[idx].cd) for(const s of myTeam[idx].skills) myTeam[idx].cd[s]=Math.max(0,(myTeam[idx].cd[s]||0)-1);
    room.turn = side===1?2:1; broadcast(room); return;
  }
  if(action.type==='skill'){
    const sk = action.skill;
    if((actor.cd[sk]||0)>0) return;
    startTurn(actor); performSkill(actor, defender, sk, side); endCd(actor, sk);
    const killed = defender.hp<=0;          // 本次行动是否击杀对方怪物
    if(defender.hp<=0) handleDeath(room, side===1?2:1);
    if(actor.hp<=0) handleDeath(room, side);
    if(room.over){ broadcast(room); return; }
    tickBurn(actor);
    if(actor.hp<=0) handleDeath(room, side);
    if(room.over){ broadcast(room); return; }
    tickPoison(actor);
    if(actor.hp<=0) handleDeath(room, side);
    if(room.over){ broadcast(room); return; }
    if(actor.parasite){ const hs = actor.parasite.owner===1 ? room.p1team[room.p1cur] : room.p2team[room.p2cur]; tickParasite(actor, hs); }
    if(actor.hp<=0) handleDeath(room, side);
    if(room.over){ broadcast(room); return; }
    // 击杀方保持先手（被击杀方换上新怪占用其回合）；否则正常交替
    room.turn = killed ? side : (side===1?2:1);
    broadcast(room); return;
  }
}
function handleDeath(room, deadSide){
  const team = deadSide===1?room.p1team:room.p2team;
  const next = firstAlive(team);
  if(next===-1){ room.over=true; room.winner = deadSide===1?2:1; log(`🏆 ${room.names[room.winner]} 获得胜利！`); return; }
  if(deadSide===1) room.p1cur=next; else room.p2cur=next;
  log(`💀 ${room.names[deadSide]} 的怪物倒下，${team[next].name} 上场！`);
}

/* ============ WebSocket ============ */
const wss = new WebSocketServer({ noServer:true });
wss.on('connection', (ws)=>{
  ws.roomCode=null; ws.side=0;
  ws.on('message', (raw)=>{
    let msg; try{ msg=JSON.parse(raw); }catch(e){ return; }
    try{
      if(msg.type==='create'){
        const code=genRoom();
        const room={ code, p1:ws, p2:null, p1team:null, p2team:null, p1cur:0, p2cur:0,
          turn:1, over:false, winner:0, battle:false, names:{1:msg.name||'玩家1',2:''}, msg:'' };
        rooms.set(code, room); ws.roomCode=code; ws.side=1;
        send(ws, { type:'created', room:code, you:1 }); return;
      }
      if(msg.type==='join'){
        const room=rooms.get(msg.room);
        if(!room){ send(ws,{type:'error',msg:'房间不存在'}); return; }
        if(room.p2){ send(ws,{type:'error',msg:'房间已满'}); return; }
        room.p2=ws; room.names[2]=msg.name||'玩家2'; ws.roomCode=msg.room; ws.side=2;
        send(ws,{type:'joined',room:msg.room,you:2});
        send(room.p1,{type:'peer_joined', name:room.names[2]});
        send(room.p2,{type:'peer_joined', name:room.names[1]}); return;
      }
      if(msg.type==='save'){
        cloudSave(msg.nick, msg.pass, msg.data).then(r=> send(ws, {type:'saved', ok:r.ok, msg:r.msg}));
        return;
      }
      if(msg.type==='load'){
        cloudLoad(msg.nick, msg.pass).then(r=> send(ws, {type:'loaded', ok:r.ok, msg:r.msg, data:r.ok?r.data:null}));
        return;
      }
      if(msg.type==='team'){
        const room=rooms.get(ws.roomCode); if(!room) return;
        const team=Array.isArray(msg.team)?msg.team.slice(0,4).map(hydrate):[];
        if(team.length===0){ send(ws,{type:'error',msg:'阵容为空'}); return; }
        if(ws.side===1){ room.p1team=team; } else { room.p2team=team; }
        if(room.p1team && room.p2team){ startMatch(room); }
        else { send(ws,{type:'waiting', msg:'等待对手提交阵容…'}); }
        return;
      }
      if(msg.type==='action'){
        const room=rooms.get(ws.roomCode); if(!room||!room.battle) return;
        doAction(room, ws.side, msg.action); return;
      }
      if(msg.type==='leave'){
        const room=rooms.get(ws.roomCode); if(room){ notifyOpponentLeft(room, ws.side); }
        return;
      }
    }catch(err){ console.error('HANDLER ERROR:', err); }
  });
  ws.on('close', ()=>{ const room=rooms.get(ws.roomCode); if(room){ notifyOpponentLeft(room, ws.side); } });
});
function notifyOpponentLeft(room, side){
  const other = side===1?room.p2:room.p1;
  if(other && other.readyState===1) send(other, {type:'opponent_left'});
  rooms.delete(room.code);
}

/* ============ HTTP：排行榜 ============ */
const LB_FILE = path.join(__dirname, 'leaderboard.json');
let leaderboard = [];
try{ leaderboard = JSON.parse(fs.readFileSync(LB_FILE,'utf8')); }catch(e){ leaderboard=[]; }
function saveLB(){ try{ fs.writeFileSync(LB_FILE, JSON.stringify(leaderboard.slice(0,50))); }catch(e){} }

const server = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS'){ res.end(); return; }
  if(req.url.startsWith('/leaderboard') && req.method==='GET'){
    const by = req.url.includes('by=wins') ? 'wins' : 'gold';
    leaderboard.sort((a,b)=> (b[by]||0) - (a[by]||0));
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(leaderboard.slice(0,20))); return;
  }
  if(req.url==='/score' && req.method==='POST'){
    let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
      try{
        const o=JSON.parse(body);
        if(typeof o.gold!=='number' && typeof o.wins!=='number') throw 0;
        leaderboard.push({ name:String(o.name||'无名').slice(0,12), gold:o.gold|0, wins:o.wins|0, level:o.level||0, time:Date.now() });
        leaderboard.sort((a,b)=> (b.gold||0)-(a.gold||0));
        leaderboard = leaderboard.slice(0,50); saveLB();
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({ok:true}));
      }catch(e){ res.statusCode=400; res.end(JSON.stringify({ok:false})); }
    }); return;
  }
  res.setHeader('Content-Type','text/plain'); res.end('mushroom battle server ok');
});
server.on('upgrade', (req, socket, head)=>{ wss.handleUpgrade(req, socket, head, (ws)=>wss.emit('connection', ws, req)); });
server.listen(PORT, HOST, ()=>{ console.log(`🍄 蘑菇村联机服务器已启动: http://${HOST}:${PORT}  (ws 同端口)`); });
