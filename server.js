// ─── GHOST CRAWLER — AUTHORITATIVE MULTIPLAYER SERVER ────────────────────────
// Node.js + ws  |  Deploy to Railway: connect GitHub repo, auto-deploys.
// Each "room" (lobby) is independent. Server owns all simulation.
// Clients send inputs; server ticks at 60fps and broadcasts full state.

const { WebSocketServer, WebSocket } = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });
console.log(`Ghost Crawler server listening on :${PORT}`);

// ─── CONSTANTS (must match client) ───────────────────────────────────────────
const W = 800, H = 600, TILE = 32;
const ROOM_X = 2, ROOM_Y = 2, ROOM_W = 21, ROOM_H = 14;
const MAP_COLS = 5, MAP_ROWS = 4;
const TICK_MS = 1000 / 60;

const WEAPONS = {
  pistol:   { name:'PISTOL',    damage:15, speed:9,  rate:18, ammo:-1,  spread:0.06, burst:1, color:'#f39c12', bullet:'circle', size:4 },
  shotgun:  { name:'SHOTGUN',   damage:20, speed:7,  rate:50, ammo:24,  spread:0.25, burst:5, color:'#e74c3c', bullet:'circle', size:5 },
  smg:      { name:'SMG',       damage:8,  speed:11, rate:6,  ammo:60,  spread:0.12, burst:1, color:'#3498db', bullet:'circle', size:3 },
  laser:    { name:'LASER',     damage:5,  speed:14, rate:3,  ammo:40,  spread:0,    burst:1, color:'#00ff88', bullet:'laser',  size:3 },
  rocket:   { name:'ROCKET',    damage:60, speed:5,  rate:80, ammo:8,   spread:0.03, burst:1, color:'#ff6b35', bullet:'rocket', size:8 },
  crossbow: { name:'CROSSBOW',  damage:40, speed:12, rate:40, ammo:15,  spread:0,    burst:1, color:'#9b59b6', bullet:'arrow',  size:6 },
  dualGuns: { name:'DUAL GUNS', damage:12, speed:10, rate:10, ammo:80,  spread:0.1,  burst:2, color:'#f1c40f', bullet:'circle', size:4 },
};
const WEAPON_KEYS = Object.keys(WEAPONS);

const ENEMY_TYPES = {
  goblin:   { hp:30,  speed:1.4, damage:10, size:14, color:'#27ae60', xp:10,  ai:'chase',  shootInterval:0,   bulletDmg:0  },
  orc:      { hp:80,  speed:0.9, damage:20, size:20, color:'#16a085', xp:25,  ai:'chase',  shootInterval:0,   bulletDmg:0  },
  skeleton: { hp:40,  speed:1.1, damage:12, size:15, color:'#bdc3c7', xp:15,  ai:'strafe', shootInterval:90,  bulletDmg:8  },
  wizard:   { hp:60,  speed:0.8, damage:15, size:16, color:'#8e44ad', xp:30,  ai:'orbit',  shootInterval:60,  bulletDmg:12 },
  bat:      { hp:20,  speed:2.2, damage:8,  size:10, color:'#6c3483', xp:8,   ai:'zigzag', shootInterval:0,   bulletDmg:0  },
  slime:    { hp:50,  speed:0.7, damage:15, size:18, color:'#1abc9c', xp:12,  ai:'chase',  shootInterval:150, bulletDmg:10 },
  boss:     { hp:500, speed:1.2, damage:30, size:38, color:'#c0392b', xp:200, ai:'boss',   shootInterval:30,  bulletDmg:20 },
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function dist(x1,y1,x2,y2){ return Math.hypot(x2-x1,y2-y1); }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function rng(seed){ let x=Math.sin(seed+1)*10000; return x-Math.floor(x); }

function isWall(px,py){
  const col=Math.floor(px/TILE), row=Math.floor(py/TILE);
  if(col<ROOM_X||col>=ROOM_X+ROOM_W||row<ROOM_Y||row>=ROOM_Y+ROOM_H) return true;
  if(col===ROOM_X||col===ROOM_X+ROOM_W-1) return true;
  if(row===ROOM_Y||row===ROOM_Y+ROOM_H-1) return true;
  return false;
}

function moveEntity(e, dx, dy){
  const hw=(e.w||e.size)/2, hh=(e.h||e.size)/2;
  const nx=e.x+dx, ny=e.y+dy;
  if(!isWall(nx-hw,e.y-hh)&&!isWall(nx+hw,e.y-hh)&&!isWall(nx-hw,e.y+hh)&&!isWall(nx+hw,e.y+hh))
    e.x=clamp(nx,ROOM_X*TILE+hw+2,(ROOM_X+ROOM_W)*TILE-hw-2);
  if(!isWall(e.x-hw,ny-hh)&&!isWall(e.x+hw,ny-hh)&&!isWall(e.x-hw,ny+hh)&&!isWall(e.x+hw,ny+hh))
    e.y=clamp(ny,ROOM_Y*TILE+hh+2,(ROOM_Y+ROOM_H)*TILE-hh-2);
}

function seededShuffle(arr, seed){
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(rng(seed+i)*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

// ─── DUNGEON GENERATION (seeded) ─────────────────────────────────────────────
function generateDungeon(seed){
  const dungeon=[];
  for(let r=0;r<MAP_ROWS;r++){
    dungeon[r]=[];
    for(let c=0;c<MAP_COLS;c++)
      dungeon[r][c]={ exists:false, cleared:false, chest:false, spawned:false, type:'normal', pickups:[] };
  }
  // Seeded random walk
  let sr=0, r=0, c=0;
  dungeon[r][c].exists=true;
  while(r!==MAP_ROWS-1||c!==MAP_COLS-1){
    const options=[];
    if(r<MAP_ROWS-1) options.push([1,0],[1,0]);
    if(c<MAP_COLS-1) options.push([0,1],[0,1]);
    if(r>0) options.push([-1,0]);
    if(c>0) options.push([0,-1]);
    const pick=options[Math.floor(rng(seed+(sr++))*options.length)];
    r+=pick[0]; c+=pick[1];
    dungeon[r][c].exists=true;
  }
  const target=8+Math.floor(rng(seed+999)*5);
  let attempts=0;
  while(attempts<200){
    attempts++;
    const existing=[];
    for(let rr=0;rr<MAP_ROWS;rr++) for(let cc=0;cc<MAP_COLS;cc++) if(dungeon[rr][cc].exists) existing.push([rr,cc]);
    if(existing.length>=target) break;
    const [er,ec]=existing[Math.floor(rng(seed+attempts+100)*existing.length)];
    const dirs=seededShuffle([[-1,0],[1,0],[0,-1],[0,1]],seed+attempts+200);
    for(const [dr,dc] of dirs){
      const nr=er+dr, nc=ec+dc;
      if(nr>=0&&nr<MAP_ROWS&&nc>=0&&nc<MAP_COLS&&!dungeon[nr][nc].exists){ dungeon[nr][nc].exists=true; break; }
    }
  }
  dungeon[0][0].type='normal';
  dungeon[MAP_ROWS-1][MAP_COLS-1].type='boss';
  for(let r=0;r<MAP_ROWS;r++) for(let c=0;c<MAP_COLS;c++){
    if(!dungeon[r][c].exists||(r===MAP_ROWS-1&&c===MAP_COLS-1)) continue;
    dungeon[r][c].type = rng(seed+r*10+c)<0.1 ? 'shop' : 'normal';
    dungeon[r][c].chest = rng(seed+r*10+c+50)<0.25;
  }
  return dungeon;
}

// ─── LOBBIES ─────────────────────────────────────────────────────────────────
const lobbies = new Map(); // code → LobbyState

function makeLobbyCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code='';
  do { code=Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while(lobbies.has(code));
  return code;
}

function createLobby(hostWs){
  const code=makeLobbyCode();
  const lobby={
    code, state:'lobby', // lobby | playing | gameover
    seed: Math.floor(Math.random()*1000000),
    players: new Map(), // id → playerState
    bullets: [],
    floatingTexts: [],
    dungeon: null,
    floor: 1,
    kills: 0,
    tickInterval: null,
    nextId: 1,
    nextBulletId: 1,
    nextPickupId: 1,
  };
  lobbies.set(code, lobby);
  joinLobby(lobby, hostWs, true);
  return lobby;
}

function joinLobby(lobby, ws, isHost){
  const id = lobby.nextId++;
  const colors = ['#3498db','#2ecc71','#e74c3c','#f39c12'];
  const capes  = ['#8e44ad','#27ae60','#c0392b','#e67e22'];
  const ps = {
    id, ws, isHost,
    name: `P${id}`,
    bodyColor: colors[(id-1)%colors.length],
    capeColor:  capes[(id-1)%capes.length],
    // in-game state (null until game starts)
    x: W/2, y: H/2, w:22, h:22,
    facing: 0,
    hp: 100, maxHp: 100,
    speed: 3, dmgMult: 1.0,
    weapons: [{ ...WEAPONS.pistol }, null, null],
    weaponIdx: 0,
    fireCooldown: 0,
    invincible: 0,
    currentRoom: { r:0, c:0 },
    alive: true,
    // input snapshot from client
    input: { dx:0, dy:0, facing:0, shooting:false, switchTo:-1, pickup:false, dropWeapon:false },
    ready: false,
  };
  ws._lobbyCode = lobby.code;
  ws._playerId  = id;
  lobby.players.set(id, ps);

  send(ws, { type:'joined', code:lobby.code, playerId:id, isHost, seed:lobby.seed });
  broadcastLobbyState(lobby);
  return ps;
}

function broadcastLobbyState(lobby){
  const players = [...lobby.players.values()].map(p=>({
    id:p.id, name:p.name, isHost:p.isHost, ready:p.ready,
    bodyColor:p.bodyColor, capeColor:p.capeColor
  }));
  broadcast(lobby, { type:'lobby_state', players, state:lobby.state });
}

// ─── GAME START ───────────────────────────────────────────────────────────────
function startGame(lobby){
  lobby.state = 'playing';
  lobby.floor = 1;
  lobby.kills = 0;
  lobby.bullets = [];
  lobby.floatingTexts = [];
  lobby.dungeon = generateDungeon(lobby.seed);

  // Init all players
  const startPositions = [
    {x:W/2-30,y:H/2},{x:W/2+30,y:H/2},
    {x:W/2,y:H/2-30},{x:W/2,y:H/2+30}
  ];
  let pi=0;
  for(const p of lobby.players.values()){
    const sp=startPositions[pi++]||{x:W/2,y:H/2};
    p.x=sp.x; p.y=sp.y;
    p.hp=p.maxHp; p.alive=true;
    p.weapons=[{ ...WEAPONS.pistol },null,null];
    p.weaponIdx=0; p.fireCooldown=0; p.invincible=0;
    p.currentRoom={r:0,c:0};
  }

  // Spawn enemies in starting room
  spawnEnemiesInRoom(lobby, 0, 0);

  broadcast(lobby, {
    type:'game_start',
    seed: lobby.seed,
    dungeon: dungeonSnapshot(lobby.dungeon),
    floor: lobby.floor,
  });

  // Start tick
  lobby.tickInterval = setInterval(()=>tick(lobby), TICK_MS);
}

function dungeonSnapshot(dungeon){
  return dungeon.map(row=>row.map(room=>({
    exists:room.exists, cleared:room.cleared, chest:room.chest,
    type:room.type, spawned:room.spawned,
    enemies: (room.enemies||[]).map(enemySnap),
    pickups: room.pickups||[],
  })));
}

function enemySnap(e){
  return { id:e.id, type:e.type, x:e.x, y:e.y, hp:e.hp, maxHp:e.maxHp,
           size:e.size, color:e.color, ai:e.ai };
}

// ─── ENEMY SPAWNING ───────────────────────────────────────────────────────────
let _nextEnemyId = 1;
function spawnEnemiesInRoom(lobby, rr, cc){
  const room = lobby.dungeon[rr][cc];
  if(room.type==='shop'||room.spawned) return;
  room.spawned = true;
  room.enemies = [];
  if(room.type==='boss'){
    room.enemies.push(makeEnemy('boss', W/2, H/2-80, lobby.floor));
    return;
  }
  const difficulty = lobby.floor + Math.floor((rr+cc)*0.5);
  let count = Math.min(2+Math.floor(Math.random()*3)+Math.floor(difficulty*0.5), 8);
  const pool=['goblin','orc','skeleton','wizard','bat','slime'].filter((_,i)=>i<2+difficulty);
  for(let i=0;i<count;i++){
    const t=pool[Math.floor(Math.random()*pool.length)];
    let ex,ey,tries=0;
    do{
      ex=TILE*(ROOM_X+2)+Math.random()*TILE*(ROOM_W-4);
      ey=TILE*(ROOM_Y+2)+Math.random()*TILE*(ROOM_H-4);
      tries++;
    }while(tries<20&&dist(ex,ey,W/2,H/2)<150);
    room.enemies.push(makeEnemy(t,ex,ey,lobby.floor));
  }
}

function makeEnemy(type,x,y,floor){
  const t=ENEMY_TYPES[type];
  return {
    id: _nextEnemyId++,
    type, x, y, ...t,
    maxHp: t.hp*(1+(floor-1)*0.2),
    hp:    t.hp*(1+(floor-1)*0.2),
    shootTimer: Math.floor(Math.random()*(t.shootInterval||60)),
    phase: Math.random()*Math.PI*2,
    vx:0, vy:0, stunned:0,
    w: t.size*2, h: t.size*2,
  };
}

// ─── MAIN TICK ───────────────────────────────────────────────────────────────
function tick(lobby){
  if(lobby.state!=='playing') return;

  const alivePlayers = [...lobby.players.values()].filter(p=>p.alive);

  // Process each player's input
  for(const p of alivePlayers){
    processPlayerInput(lobby, p);
  }

  // Update all enemies (per-room, only rooms with players)
  const occupiedRooms = new Set();
  for(const p of alivePlayers) occupiedRooms.add(`${p.currentRoom.r},${p.currentRoom.c}`);

  const events = []; // { type, ... } — damage, kills, pickups, text, etc.

  for(const key of occupiedRooms){
    const [rr,cc] = key.split(',').map(Number);
    updateRoomEnemies(lobby, rr, cc, alivePlayers, events);
  }

  // Update bullets
  updateBullets(lobby, alivePlayers, events);

  // Process events
  for(const ev of events){
    if(ev.type==='kill'){
      lobby.kills++;
      handleEnemyDrop(lobby, ev.room, ev.enemy);
      broadcast(lobby, { type:'enemy_killed', enemyId:ev.enemy.id, room:ev.room, xp:ev.enemy.xp });
    }
    if(ev.type==='player_hit'){
      const p=ev.player;
      p.hp -= ev.damage;
      p.invincible = 60;
      broadcast(lobby, { type:'player_hit', playerId:p.id, damage:ev.damage, hp:p.hp });
      if(p.hp<=0){
        p.alive=false;
        broadcast(lobby, { type:'player_dead', playerId:p.id });
        checkGameOver(lobby);
      }
    }
    if(ev.type==='spawn_text'){
      broadcast(lobby, { type:'spawn_text', x:ev.x, y:ev.y, text:ev.text, color:ev.color });
    }
    if(ev.type==='pickup_taken'){
      broadcast(lobby, { type:'pickup_taken', pickupId:ev.pickupId, playerId:ev.playerId, room:ev.room });
    }
    if(ev.type==='weapon_dropped'){
      broadcast(lobby, { type:'weapon_dropped', pickup:ev.pickup, room:ev.room });
    }
    if(ev.type==='room_cleared'){
      broadcast(lobby, { type:'room_cleared', room:ev.room });
      if(ev.chest) dropChestLoot(lobby, ev.room);
      if(ev.isBoss) setTimeout(()=>nextFloor(lobby), 2000);
    }
  }

  // Broadcast full game state to all players (~60fps snapshot)
  const snap = buildSnapshot(lobby);
  broadcast(lobby, { type:'state', ...snap });
}

function buildSnapshot(lobby){
  const players = [...lobby.players.values()].map(p=>({
    id:p.id, x:p.x, y:p.y, facing:p.facing,
    hp:p.hp, maxHp:p.maxHp, alive:p.alive,
    bodyColor:p.bodyColor, capeColor:p.capeColor,
    invincible:p.invincible>0,
    currentRoom:p.currentRoom,
    weaponIdx:p.weaponIdx,
    weapons:p.weapons.map(w=>w?{name:w.name,color:w.color,ammo:w.ammo,bullet:w.bullet}:null),
  }));

  // Bullets
  const bullets = lobby.bullets.map(b=>({
    id:b.id, x:b.x, y:b.y, angle:b.angle,
    type:b.type, color:b.color, size:b.size, fromEnemy:b.fromEnemy,
    room:`${b.room.r},${b.room.c}`,
  }));

  // Enemies — only rooms with players
  const rooms = {};
  const occupiedRooms = new Set();
  for(const p of lobby.players.values()) if(p.alive) occupiedRooms.add(`${p.currentRoom.r},${p.currentRoom.c}`);
  for(const key of occupiedRooms){
    const [rr,cc]=key.split(',').map(Number);
    const room=lobby.dungeon[rr][cc];
    if(!room) continue;
    rooms[key]={
      enemies:(room.enemies||[]).map(enemySnap),
      pickups:(room.pickups||[]),
      cleared:room.cleared,
    };
  }

  return { players, bullets, rooms, floor:lobby.floor, kills:lobby.kills };
}

// ─── PLAYER INPUT PROCESSING ─────────────────────────────────────────────────
function processPlayerInput(lobby, p){
  const inp = p.input;

  // Movement
  let dx=inp.dx*p.speed, dy=inp.dy*p.speed;
  if(dx!==0&&dy!==0){ dx*=0.707; dy*=0.707; }
  moveEntity(p, dx, dy);
  p.facing = inp.facing;

  // Invincibility cooldown
  if(p.invincible>0) p.invincible--;

  // Weapon switch
  if(inp.switchTo>=0&&inp.switchTo<3&&p.weapons[inp.switchTo]&&inp.switchTo!==p.weaponIdx){
    p.weaponIdx=inp.switchTo;
    p.fireCooldown=10;
    inp.switchTo=-1;
  }

  // Firing
  if(p.fireCooldown>0) p.fireCooldown--;
  const w=p.weapons[p.weaponIdx];
  if(inp.shooting&&w&&p.fireCooldown<=0){
    const isPistol=w.name==='PISTOL';
    if(!isPistol&&w.ammo<=0){
      // no ammo, skip
    } else {
      for(let i=0;i<w.burst;i++){
        const spread=(Math.random()-0.5)*w.spread*2;
        const bOff=i===0?0:(Math.random()-0.5)*8;
        const bx=p.x+Math.cos(p.facing)*20;
        const by=p.y+Math.sin(p.facing)*20+bOff;
        const angle=p.facing+spread;
        lobby.bullets.push({
          id: lobby.nextBulletId++,
          x:bx, y:by,
          vx:Math.cos(angle)*w.speed, vy:Math.sin(angle)*w.speed,
          damage: Math.round(w.damage*(p.dmgMult||1)),
          fromEnemy:false, ownerId:p.id,
          type:w.bullet, color:w.color, size:w.size,
          life:80, angle,
          explosive:w.bullet==='rocket',
          room:{ r:p.currentRoom.r, c:p.currentRoom.c },
        });
      }
      if(!isPistol) w.ammo--;
      p.fireCooldown=w.rate;
    }
  }

  // Drop weapon
  if(inp.dropWeapon){
    const w=p.weapons[p.weaponIdx];
    if(w&&w.name!=='PISTOL'){
      const dropX=p.x+Math.cos(p.facing)*36;
      const dropY=p.y+Math.sin(p.facing)*36;
      const pickup={ id:lobby.nextPickupId++, x:dropX, y:dropY, type:'weapon', weapon:{...w} };
      const room=lobby.dungeon[p.currentRoom.r]?.[p.currentRoom.c];
      if(room){ room.pickups=room.pickups||[]; room.pickups.push(pickup); }
      p.weapons[p.weaponIdx]=null;
      broadcast(lobby, { type:'weapon_dropped', pickup, room:p.currentRoom });
    }
    inp.dropWeapon=false;
  }

  // Pickup
  if(inp.pickup){
    inp.pickup=false;
    tryPickup(lobby, p);
  }

  // Door check
  checkDoors(lobby, p);
}

function tryPickup(lobby, p){
  const room=lobby.dungeon[p.currentRoom.r]?.[p.currentRoom.c];
  if(!room||!room.pickups) return;
  let closest=null, closestDist=Infinity;
  for(const pu of room.pickups){
    const d=dist(p.x,p.y,pu.x,pu.y);
    if(d<50&&d<closestDist){ closest=pu; closestDist=d; }
  }
  if(!closest) return;
  if(closest.type==='health'){
    p.hp=Math.min(p.maxHp, p.hp+15);
    broadcast(lobby,{type:'spawn_text',x:closest.x,y:closest.y-20,text:'+15 HP',color:'#2ecc71'});
  } else if(closest.type==='ammo'){
    for(const w of p.weapons){
      if(w&&w.name!=='PISTOL'){
        const base=WEAPONS[WEAPON_KEYS.find(k=>WEAPONS[k].name===w.name)];
        if(base) w.ammo=Math.min(base.ammo, w.ammo+Math.ceil(base.ammo*0.4));
      }
    }
    broadcast(lobby,{type:'spawn_text',x:closest.x,y:closest.y-20,text:'+AMMO',color:'#f39c12'});
  } else if(closest.type==='weapon'){
    const slot=p.weapons.indexOf(null);
    if(slot!==-1){
      p.weapons[slot]={...closest.weapon};
      broadcast(lobby,{type:'spawn_text',x:closest.x,y:closest.y-20,text:'GOT '+closest.weapon.name,color:closest.weapon.color});
    } else {
      const dropped=p.weapons[p.weaponIdx];
      const dropX=p.x+Math.cos(p.facing)*36, dropY=p.y+Math.sin(p.facing)*36;
      const newPu={id:lobby.nextPickupId++,x:dropX,y:dropY,type:'weapon',weapon:dropped};
      room.pickups.push(newPu);
      p.weapons[p.weaponIdx]={...closest.weapon};
      broadcast(lobby,{type:'spawn_text',x:closest.x,y:closest.y-20,text:'SWAP '+closest.weapon.name,color:closest.weapon.color});
    }
  }
  room.pickups=room.pickups.filter(pu=>pu!==closest);
  broadcast(lobby,{ type:'pickup_taken', pickupId:closest.id, playerId:p.id, room:p.currentRoom });
}

// ─── DOOR / ROOM TRANSITIONS ─────────────────────────────────────────────────
function getDoors(room, cr, cc){
  const doors=[];
  const cleared=room.cleared||room.type==='shop';
  if(!cleared) return doors;
  if(cr>0&&checkRoomExists(cr-1,cc)) doors.push({dir:'up',   x:W/2,              y:TILE*ROOM_Y+16});
  if(cr<MAP_ROWS-1&&checkRoomExists(cr+1,cc)) doors.push({dir:'down', x:W/2,     y:TILE*(ROOM_Y+ROOM_H)-16});
  if(cc>0&&checkRoomExists(cr,cc-1)) doors.push({dir:'left', x:TILE*ROOM_X+16,   y:H/2});
  if(cc<MAP_COLS-1&&checkRoomExists(cr,cc+1)) doors.push({dir:'right',x:TILE*(ROOM_X+ROOM_W)-16,y:H/2});
  return doors;
}
let _dungeonForDoorCheck = null; // set per lobby call
function checkRoomExists(r,c){ return _dungeonForDoorCheck&&_dungeonForDoorCheck[r]?.[c]?.exists; }

function checkDoors(lobby, p){
  _dungeonForDoorCheck = lobby.dungeon;
  const room=lobby.dungeon[p.currentRoom.r][p.currentRoom.c];
  const doors=getDoors(room, p.currentRoom.r, p.currentRoom.c);
  for(const d of doors){
    if(dist(p.x,p.y,d.x,d.y)<30){
      let nr=p.currentRoom.r, nc=p.currentRoom.c;
      if(d.dir==='up') nr--; else if(d.dir==='down') nr++;
      else if(d.dir==='left') nc--; else nc++;
      if(nr>=0&&nr<MAP_ROWS&&nc>=0&&nc<MAP_COLS&&lobby.dungeon[nr]?.[nc]?.exists){
        enterRoom(lobby,p,nr,nc,d.dir);
      }
    }
  }
}

function enterRoom(lobby, p, nr, nc, fromDir){
  p.currentRoom={r:nr,c:nc};
  lobby.bullets=lobby.bullets.filter(b=>b.ownerId===p.id?false:true); // clear player's bullets on room change
  if(fromDir==='up')    { p.x=W/2; p.y=(ROOM_Y+ROOM_H-2)*TILE-24; }
  else if(fromDir==='down')  { p.x=W/2; p.y=(ROOM_Y+2)*TILE+24; }
  else if(fromDir==='left')  { p.x=(ROOM_X+ROOM_W-2)*TILE-24; p.y=H/2; }
  else                        { p.x=(ROOM_X+2)*TILE+24; p.y=H/2; }

  const room=lobby.dungeon[nr][nc];
  if(!room.spawned&&!room.cleared) spawnEnemiesInRoom(lobby,nr,nc);

  broadcast(lobby,{ type:'player_enter_room', playerId:p.id, room:{r:nr,c:nc}, fromDir,
    px:p.x, py:p.y });
}

// ─── ENEMY AI ─────────────────────────────────────────────────────────────────
function updateRoomEnemies(lobby, rr, cc, alivePlayers, events){
  const room=lobby.dungeon[rr]?.[cc];
  if(!room||!room.enemies||room.enemies.length===0) return;

  // Players in this room
  const roomPlayers=alivePlayers.filter(p=>p.currentRoom.r===rr&&p.currentRoom.c===cc);
  if(roomPlayers.length===0) return;

  for(let i=room.enemies.length-1;i>=0;i--){
    const e=room.enemies[i];
    if(e.stunned>0){ e.stunned--; continue; }

    // Pick nearest player as target
    let target=roomPlayers[0];
    let minD=Infinity;
    for(const p of roomPlayers){ const d=dist(e.x,e.y,p.x,p.y); if(d<minD){ minD=d; target=p; } }

    const dx=target.x-e.x, dy=target.y-e.y;
    const d=Math.hypot(dx,dy)||1;
    const nx=dx/d, ny=dy/d;

    if(e.ai==='chase'){ e.vx=nx*e.speed; e.vy=ny*e.speed; }
    else if(e.ai==='strafe'){
      e.phase=(e.phase||0)+0.03;
      e.vx=(d>160?nx*e.speed:Math.cos(e.phase)*e.speed);
      e.vy=(d>160?ny*e.speed:Math.sin(e.phase)*e.speed);
    } else if(e.ai==='orbit'){
      const approach=(d-180)*0.02; e.phase=(e.phase||0)+0.02;
      e.vx=nx*approach+Math.cos(e.phase)*e.speed;
      e.vy=ny*approach+Math.sin(e.phase)*e.speed;
    } else if(e.ai==='zigzag'){
      e.phase=(e.phase||0)+0.08;
      e.vx=nx*e.speed+Math.cos(e.phase)*2;
      e.vy=ny*e.speed+Math.sin(e.phase)*2;
    } else if(e.ai==='boss'){
      e.phase=(e.phase||0)+0.01;
      const approach=(d-200)*0.015;
      e.vx=nx*approach+Math.cos(e.phase)*1.5;
      e.vy=ny*approach+Math.sin(e.phase)*1.5;
      if(e.shootTimer<=0){
        for(let a=0;a<8;a++){
          lobby.bullets.push({
            id:lobby.nextBulletId++,
            x:e.x,y:e.y,
            vx:Math.cos(a/8*Math.PI*2)*7, vy:Math.sin(a/8*Math.PI*2)*7,
            damage:20, fromEnemy:true, ownerId:-1,
            type:'circle', color:'#e74c3c', size:5,
            life:80, angle:a/8*Math.PI*2, explosive:false,
            room:{r:rr,c:cc},
          });
        }
        e.shootTimer=e.shootInterval;
      } else e.shootTimer--;
    }

    moveEntity(e,e.vx,e.vy);

    // Ranged shooting
    if(e.shootInterval>0&&e.ai!=='boss'){
      if(e.shootTimer<=0){
        const ang=Math.atan2(target.y-e.y,target.x-e.x);
        lobby.bullets.push({
          id:lobby.nextBulletId++,
          x:e.x,y:e.y,
          vx:Math.cos(ang)*5, vy:Math.sin(ang)*5,
          damage:e.bulletDmg, fromEnemy:true, ownerId:-1,
          type:'circle', color:'#e74c3c', size:4,
          life:80, angle:ang, explosive:false,
          room:{r:rr,c:cc},
        });
        e.shootTimer=e.shootInterval;
      } else e.shootTimer--;
    }

    // Melee damage
    for(const p of roomPlayers){
      if(dist(e.x,e.y,p.x,p.y)<e.size+12&&p.invincible<=0){
        events.push({type:'player_hit', player:p, damage:e.damage});
      }
    }
  }

  // Check room cleared
  if(room.enemies.length===0&&!room.cleared){
    room.cleared=true;
    events.push({type:'room_cleared',room:{r:rr,c:cc},chest:room.chest,isBoss:room.type==='boss'});
  }
}

// ─── BULLET UPDATE ────────────────────────────────────────────────────────────
function updateBullets(lobby, alivePlayers, events){
  lobby.bullets=lobby.bullets.filter(b=>{
    b.x+=b.vx; b.y+=b.vy; b.life--;
    if(b.life<=0) return false;
    if(isWall(b.x,b.y)){
      if(b.explosive) handleExplosion(lobby,b,events);
      return false;
    }
    if(b.fromEnemy){
      // Check hit on players in same room
      for(const p of alivePlayers){
        if(p.currentRoom.r!==b.room.r||p.currentRoom.c!==b.room.c) continue;
        if(dist(b.x,b.y,p.x,p.y)<14&&p.invincible<=0){
          events.push({type:'player_hit',player:p,damage:b.damage});
          return false;
        }
      }
    } else {
      const room=lobby.dungeon[b.room.r]?.[b.room.c];
      if(!room||!room.enemies) return true;
      for(let i=room.enemies.length-1;i>=0;i--){
        const e=room.enemies[i];
        if(dist(b.x,b.y,e.x,e.y)<e.size+b.size){
          e.hp-=b.damage; e.stunned=8;
          events.push({type:'spawn_text',x:e.x,y:e.y-20,text:'-'+b.damage,color:'#fff'});
          if(b.explosive) handleExplosion(lobby,b,events,room);
          if(e.hp<=0) events.push({type:'kill',enemy:e,room:{r:b.room.r,c:b.room.c}});
          // Remove dead enemies immediately so we don't double-kill
          if(e.hp<=0) room.enemies.splice(i,1);
          return false;
        }
      }
    }
    return true;
  });
}

function handleExplosion(lobby,b,events,room){
  if(!room) room=lobby.dungeon[b.room.r]?.[b.room.c];
  if(!room||!room.enemies) return;
  const r=60;
  for(let i=room.enemies.length-1;i>=0;i--){
    const e=room.enemies[i];
    const d=dist(b.x,b.y,e.x,e.y);
    if(d<r){
      const dmg=Math.floor(60*(1-d/r)*1.5)||30;
      e.hp-=dmg;
      if(e.hp<=0){ events.push({type:'kill',enemy:e,room:{r:b.room.r,c:b.room.c}}); room.enemies.splice(i,1); }
    }
  }
  broadcast(lobby,{type:'explosion',x:b.x,y:b.y,room:b.room});
}

function handleEnemyDrop(lobby, room, enemy){
  const r=lobby.dungeon[room.r]?.[room.c];
  if(!r) return;
  r.pickups=r.pickups||[];
  const roll=Math.random();
  let pu=null;
  if(roll<0.2) pu={id:lobby.nextPickupId++,x:enemy.x+Math.random()*20-10,y:enemy.y+Math.random()*20-10,type:'health'};
  else if(roll<0.35) pu={id:lobby.nextPickupId++,x:enemy.x+Math.random()*20-10,y:enemy.y+Math.random()*20-10,type:'ammo'};
  else if(roll<0.45){
    const wkey=WEAPON_KEYS[1+Math.floor(Math.random()*(WEAPON_KEYS.length-1))];
    pu={id:lobby.nextPickupId++,x:enemy.x,y:enemy.y,type:'weapon',weapon:{...WEAPONS[wkey]}};
  }
  if(pu) r.pickups.push(pu);
}

function dropChestLoot(lobby, room){
  const r=lobby.dungeon[room.r]?.[room.c];
  if(!r) return;
  r.pickups=r.pickups||[];
  const wkey=WEAPON_KEYS[1+Math.floor(Math.random()*(WEAPON_KEYS.length-1))];
  r.pickups.push({id:lobby.nextPickupId++,x:W/2,y:H/2,type:'weapon',weapon:{...WEAPONS[wkey]}});
  r.pickups.push({id:lobby.nextPickupId++,x:W/2+30,y:H/2,type:'health'});
  broadcast(lobby,{type:'chest_opened',room});
}

function nextFloor(lobby){
  lobby.floor++;
  lobby.seed=Math.floor(Math.random()*1000000);
  lobby.dungeon=generateDungeon(lobby.seed);
  lobby.bullets=[];
  for(const p of lobby.players.values()){
    p.x=W/2; p.y=H/2;
    p.currentRoom={r:0,c:0};
    p.maxHp=Math.min(200,p.maxHp+20);
    p.hp=p.maxHp;
  }
  spawnEnemiesInRoom(lobby,0,0);
  broadcast(lobby,{type:'next_floor',floor:lobby.floor,seed:lobby.seed,dungeon:dungeonSnapshot(lobby.dungeon)});
}

function checkGameOver(lobby){
  const anyAlive=[...lobby.players.values()].some(p=>p.alive);
  if(!anyAlive){
    lobby.state='gameover';
    clearInterval(lobby.tickInterval);
    broadcast(lobby,{type:'game_over',floor:lobby.floor,kills:lobby.kills});
    // Auto-clean lobby after 30s
    setTimeout(()=>{ if(lobbies.has(lobby.code)) lobbies.delete(lobby.code); },30000);
  }
}

// ─── WEBSOCKET MESSAGING ─────────────────────────────────────────────────────
function send(ws, msg){ if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function broadcast(lobby, msg){
  const str=JSON.stringify(msg);
  for(const p of lobby.players.values()){
    if(p.ws.readyState===WebSocket.OPEN) p.ws.send(str);
  }
}

wss.on('connection', ws => {
  ws._lobbyCode = null;
  ws._playerId  = null;

  ws.on('message', raw => {
    let msg;
    try { msg=JSON.parse(raw); } catch(e){ return; }

    const { type } = msg;

    if(type==='create'){
      const lobby=createLobby(ws);
      return;
    }

    if(type==='join'){
      const code=(msg.code||'').toUpperCase().trim();
      const lobby=lobbies.get(code);
      if(!lobby){ send(ws,{type:'error',msg:'Room not found'}); return; }
      if(lobby.state!=='lobby'){ send(ws,{type:'error',msg:'Game already started'}); return; }
      if(lobby.players.size>=4){ send(ws,{type:'error',msg:'Room is full (max 4)'}); return; }
      joinLobby(lobby,ws,false);
      return;
    }

    // All other messages require being in a lobby
    const lobby=lobbies.get(ws._lobbyCode);
    if(!lobby) return;
    const player=lobby.players.get(ws._playerId);
    if(!player) return;

    if(type==='ready'){
      player.ready=!player.ready;
      // Apply cosmetic choices
      if(msg.bodyColor) player.bodyColor=msg.bodyColor;
      if(msg.capeColor) player.capeColor=msg.capeColor;
      broadcastLobbyState(lobby);
      // Auto-start when all ready and >=1 player
      const all=[...lobby.players.values()];
      if(all.length>=1&&all.every(p=>p.ready)) startGame(lobby);
      return;
    }

    if(type==='start'&&player.isHost&&lobby.state==='lobby'){
      startGame(lobby);
      return;
    }

    if(type==='input'&&lobby.state==='playing'){
      // Input: { dx, dy, facing, shooting, switchTo, pickup, dropWeapon }
      player.input.dx       = clamp(msg.dx||0,-1,1);
      player.input.dy       = clamp(msg.dy||0,-1,1);
      player.input.facing   = msg.facing||0;
      player.input.shooting = !!msg.shooting;
      if(msg.switchTo>=0) player.input.switchTo=msg.switchTo;
      if(msg.pickup)      player.input.pickup=true;
      if(msg.dropWeapon)  player.input.dropWeapon=true;
      return;
    }

    if(type==='exit'){
      // Player exits to menu — remove from lobby
      lobby.players.delete(ws._playerId);
      ws._lobbyCode=null; ws._playerId=null;
      if(lobby.players.size===0){
        clearInterval(lobby.tickInterval);
        lobbies.delete(lobby.code);
      } else {
        // Transfer host if needed
        if(player.isHost){
          const next=[...lobby.players.values()][0];
          if(next){ next.isHost=true; send(next.ws,{type:'host_transferred'}); }
        }
        broadcastLobbyState(lobby);
        checkGameOver(lobby);
      }
      return;
    }
  });

  ws.on('close', ()=>{
    const lobby=lobbies.get(ws._lobbyCode);
    if(!lobby) return;
    lobby.players.delete(ws._playerId);
    if(lobby.players.size===0){
      clearInterval(lobby.tickInterval);
      lobbies.delete(lobby.code);
    } else {
      const all=[...lobby.players.values()];
      if(!all.some(p=>p.isHost)){ all[0].isHost=true; send(all[0].ws,{type:'host_transferred'}); }
      broadcastLobbyState(lobby);
      checkGameOver(lobby);
    }
  });
});
