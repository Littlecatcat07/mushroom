// 蘑菇村·怪物捕捉 —— 联机对战后端
// 职责：WebSocket 房间管理 + 服务端权威回合制战斗 + 排行榜接口
// 依赖：npm i ws
// 运行：node server.js   （默认端口 3000；可用 PORT 环境变量覆盖）

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

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
};
const SKILLS = {
  '攻击':     { power:100, cd:0, type:'single', element:'无' },
  '猛击':     { power:150, cd:2, type:'single', element:'无' },
  '剑舞':     { power:70, hits:3, cd:2, type:'multi', element:'金' },
  '盾反':     { power:0, cd:3, type:'shield', element:'无' },
  '连续猛击': { power:100, hits:2, cd:3, type:'multi', element:'无' },
  '防御':     { power:0, cd:3, type:'defend', mult:3, element:'火' },
  '高级防御': { power:0, cd:3, type:'defend', mult:4, element:'无' },
  '重斩':     { power:200, cd:3, type:'single', element:'金' },
  '锻打':     { power:0, cd:3, type:'forge', element:'金' },
  '火球术':   { power:100, cd:0, type:'single', element:'火' },
  '引火':     { power:100, cd:2, type:'burn', element:'火' },
  '鼓舞':     { power:0, cd:3, type:'buff_atk', mult:1.5, turns:3, element:'无' },
  '三连火球术':{ power:100, hits:3, cd:3, type:'multi', element:'火' },
  '反制':     { power:0, cd:3, type:'counter', turns:3, element:'无' },
  '灼香火':   { power:100, cd:5, type:'burnMax', element:'火' },
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
  target.hp = Math.max(0, target.hp - dmg);
  if(target.shield>0 && dmg>0){
    const reflect = Math.min(dmg, target.atk*5);
    attacker.hp = Math.max(0, attacker.hp - reflect);
    if(reflect>0) log(`  🛡️ ${target.name}盾反反弹 ${reflect} 点伤害！`);
  }
  if(triggerCounter && dmg>0 && (target.counter||0)>0){
    const cdmg = Math.max(0, Math.floor(target.atk*50/100) - curDef(attacker));
    if(cdmg>0){ attacker.hp = Math.max(0, attacker.hp - cdmg); log(`  🔁 ${target.name}【反制】反击 ${cdmg} 点伤害！`); }
  }
}
function computeDamage(attacker, defender, power, el){
  const mult = elementMultiplier(el, defender.element);
  const effAtk = attacker.atk * (attacker.atkBuff||1);
  const base = Math.floor(effAtk * power / 100);
  const dmg = Math.max(0, Math.floor((base - curDef(defender)) * mult));
  return { dmg, mult };
}
let BATTLE_LOG = [];
function log(s){ BATTLE_LOG.push(s); }

function performSkill(attacker, defender, skillName){
  const sk = SKILLS[skillName];
  if(!sk){ log(`${attacker.name} 使用了无效技能。`); return; }
  const el = sk.element || '无';
  if(sk.type==='shield'){ attacker.shield=1; log(`${attacker.name} 使用【盾反】，进入盾反状态！`); return; }
  if(sk.type==='defend'){ attacker.defend=1; attacker.defendMult=sk.mult||3; log(`${attacker.name} 使用【${skillName}】，本回合防御大幅提升！`); return; }
  if(sk.type==='buff_atk'){ attacker.atkBuff=sk.mult||1.5; attacker.atkBuffTurns=sk.turns||3; log(`${attacker.name} 使用【鼓舞】，接下来3回合攻击+50%！`); return; }
  if(sk.type==='counter'){ attacker.counter=sk.turns||3; log(`${attacker.name} 进入【反制】状态，3回合内受击反击！`); return; }
  if(sk.type==='forge'){
    const power = randInt(100,200);
    const {dmg, mult} = computeDamage(attacker, defender, power, el);
    applyDamage(defender, dmg, attacker);
    attacker.defBuff = 3;
    log(`${attacker.name} 使用【锻打】，造成 ${dmg} 点伤害${mult>1?'（克制×2）':mult<1?'（被克制×0.5）':''}，并获得3回合防御提升！`);
    return;
  }
  if(sk.type==='burn'){
    const {dmg, mult} = computeDamage(attacker, defender, sk.power, el);
    applyDamage(defender, dmg, attacker);
    defender.burn = (defender.burn||0) + 3;
    log(`${attacker.name} 使用【引火】，造成 ${dmg} 点伤害${mult>1?'（克制×2）':mult<1?'（被克制×0.5）':''}，并使 ${defender.name} 获得3层灼烧！`);
    return;
  }
  if(sk.type==='burnMax'){
    const extra = Math.floor(defender.maxHp * 10 / 100);
    const {dmg, mult} = computeDamage(attacker, defender, sk.power, el);
    const total = Math.max(0, dmg + extra);
    applyDamage(defender, total, attacker);
    log(`${attacker.name} 使用【灼香火】，造成 ${total} 点伤害${mult>1?'（克制×2）':mult<1?'（被克制×0.5）':''}！`);
    return;
  }
  const hits = sk.hits||1;
  const power = (typeof sk.power==='number') ? sk.power : randInt(100,200);
  const mult = elementMultiplier(el, defender.element);
  let total=0;
  for(let i=0;i<hits;i++){
    const {dmg} = computeDamage(attacker, defender, power, el);
    total+=dmg; applyDamage(defender, dmg, attacker);
    if(defender.hp<=0) break;
  }
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
function startTurn(m){
  if(m.shield>0) m.shield--;
  if(m.defend>0){ m.defend--; if(m.defend===0) m.defendMult=3; }
  if(m.defBuff>0) m.defBuff--;
  if(m.atkBuffTurns>0){ m.atkBuffTurns--; if(m.atkBuffTurns===0) m.atkBuff=1; }
  if(m.counter>0) m.counter--;
}
function endCd(m, used){
  for(const s of m.skills){ if(s===used) m.cd[s]=SKILLS[s].cd; else m.cd[s]=Math.max(0,(m.cd[s]||0)-1); }
}
function firstAlive(team){ for(let i=0;i<team.length;i++) if(team[i].hp>0) return i; return -1; }
function hydrate(raw){
  const m = {
    name:raw.name, level:raw.level||1, element: raw.element || MON_ELEMENT[raw.name] || '木',
    maxHp:raw.maxHp, hp: (raw.curHp!=null?raw.curHp:raw.maxHp), atk:raw.atk, def:raw.def,
    skills:(raw.skills||[]).filter(s=>SKILLS[s]),
    shield:0, defend:0, defendMult:3, defBuff:0, atkBuff:1, atkBuffTurns:0, counter:0, burn:0, cd:{}
  };
  for(const s of m.skills) m.cd[s]=0;
  return m;
}

/* ============ 房间 / 战斗管理 ============ */
const rooms = new Map();
function genRoom(){ let r; do{ r = Math.random().toString(36).slice(2,8).toUpperCase(); }while(rooms.has(r)); return r; }
function send(ws, obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }
function publicMonster(m){ return { name:m.name, level:m.level, element:m.element, hp:m.hp, maxHp:m.maxHp, atk:m.atk, def:m.def, skills:m.skills, cur:!!(m.hp>0), cd:m.cd }; }
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
    startTurn(actor); performSkill(actor, defender, sk); endCd(actor, sk);
    const killed = defender.hp<=0;          // 本次行动是否击杀对方怪物
    if(defender.hp<=0) handleDeath(room, side===1?2:1);
    if(actor.hp<=0) handleDeath(room, side);
    if(room.over){ broadcast(room); return; }
    tickBurn(actor);
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
      if(msg.type==='team'){
        const room=rooms.get(ws.roomCode); if(!room) return;
        const team=Array.isArray(msg.team)?msg.team.slice(0,3).map(hydrate):[];
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
