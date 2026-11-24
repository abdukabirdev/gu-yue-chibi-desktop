// Chibi Walker для рабочего стола — движок маскота.
// Порт логики из браузерного расширения: те же позы, якоря кадров, физика броска, лазание, вис, полёт
// и «маски» настроения. Пол — верх панели задач (низ окна), стены — края экрана.
"use strict";
(() => {
  const TAURI = window.__TAURI__;
  const call = (cmd, args) => (TAURI ? TAURI.core.invoke(cmd, args) : Promise.reject(new Error("no tauri")));

  // ================= Константы =================
  const SKINS = ["cloak", "disciple"];
  const CUTE_SKINS = { cloak: "cloak_cute", disciple: "disciple_cute" };
  const POSES = ["idle", "sit", "sleep", "cool", "wave", "laugh", "think", "derp", "shock"]; // есть в каждом образе
  const FALLBACK = { held: "shock", fall: "shock", fly: "shock", tumble: "shock", splat: "crouch", dizzy: "derp", rub: "think", crouch: "idle",
    pout: "think", blink: "idle", pet: "laugh", eat: "tea", read: "tea", tea: "think", point: "wave", leap: "crouch", meditate: "sit" };
  const BASE_CFG = { walk: ["idle"], walkFps: 4.5, faces: { walk: -1 }, has: [], ax: {} };

  const EMOTES = ["cool", "think", "read", "laugh", "sit", "idle", "tea"];
  const CLICK_REACT = ["cool", "shock", "think", "pout", "wave"];
  const PHRASES = ["…", "Работай.", "Не отвлекайся.", "Хм.", "Тишина.", "Сосредоточься.", "Я наблюдаю."];
  const DESK_PHRASES = ["Панель задач — неплохая тропа.", "Слишком много окон.", "Я охраняю этот экран.", "Рабочий стол. Хм.", "Закрой лишнее."];
  const CUTE_EMOTES = ["laugh", "wave", "pet", "tea", "sit", "idle"];
  const CUTE_CLICK = ["laugh", "pet", "wave", "laugh"];
  const CUTE_PHRASES = ["Ты сегодня такой умный~", "Я самый послушный ученик ♡", "Хи-хи~", "Я ведь хороший, да? ✨",
    "Не смотри так. Я милый.", "Отдохни со мной чуть-чуть?", "Ещё пять минуточек ничего не делать~", "Ты лучший ♡ (запомни, что я это сказал)"];
  const SCHEME_LINES = ["Похвали меня. Ну пожааалуйста~", "Давай сегодня закончим пораньше? ✨", "Тебе нужен перерыв. Со мной~",
    "Ты самый лучший хозяин. Правда-правда ♡", "Купишь мне данго? Одно. Маленькое~"];
  const REVEAL = ["Попался.", "Ха. Повёлся.", "…Маска спала. Неважно.", "Это была проверка. Не прошёл.", "Кхм. Ты ничего не видел."];
  const HELD_CUTE = ["Отпусти~ ну пожалуйста ♡", "Я хороший, поставь меня~", "Ай-ай, высоко~ (нет)"];
  const AFTER_HELD = ["…Забудь, что видел.", "Тц. Сработало.", "Хитрость — тоже путь Дао."];
  const BACK_CUTE = ["Ты вернулся~ я скучал ♡", "Наконец-то~", "Я ждал. Совсем чуть-чуть~"];
  const TO_CUTE = { break: ["Перерыв~ теперь можно быть милым ♡", "Отдыхаем~ я заслужил."], off: ["Рабочий день всё. Я снова милый~", "Свобода~ ✨"],
    mood: ["Ладно, побуду милым~", "Сегодня я добрый. Пока что~", "Настроение сменилось ✨"] };
  const TO_STERN = ["Маска снята. Работаем.", "Хватит. За дело.", "Кхм. Серьёзно."];

  const G = 2600;                 // гравитация, px/с²
  const PHY = { airDrag: 0.82, wallBounce: 0.62, floorBounce: 0.48, bounceMin: 520, slideFriction: 0.06, hardHit: 1500 };
  const SLEEP_AFTER = 2 * 60000;  // засыпает, если пользователь 2 минуты ничего не трогает
  const AWAY_AFTER = 5 * 60000;   // «ушёл от компьютера»

  const DEFAULTS = { skin: "random", size: 140, mood: "auto", speed: 1 };

  // ================= Утилиты =================
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const vw = () => innerWidth;
  const vh = () => innerHeight;
  const now = () => performance.now();

  let s = loadSettings();
  function loadSettings() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("chibi") || "{}") }; } catch { return { ...DEFAULTS }; }
  }
  function saveSettings() { try { localStorage.setItem("chibi", JSON.stringify(s)); } catch {} }

  // ================= DOM =================
  const el = document.getElementById("c");
  const spinEl = el.querySelector(".sp");
  const img = el.querySelector("img");
  const bubble = document.getElementById("b");

  // ================= Состояние =================
  let skin = "cloak", mask = "stern", maskUntil = 0, maskWhy = "";
  const cfgCache = {};
  let skinCfg = { ...BASE_CFG };
  let curPose = "", curW = 100, curH = 140, curAx = 0.5, wantUrl = "", wantFlip = false;
  let x = 0, yb = 0, vx = 0, vy = 0, rot = 0, spin = 0, dir = 1;
  let ground = true;                         // стоит на полу (верх панели задач)
  let state = "idle", until = 0, seq = null;
  let walkPhase = 0, jumping = false, sliding = false, thrown = false, bounces = 0, maxImpact = 0, fallFrom = 0;
  let entering = false, airPeak = 0, airAt = 0, airPoseAt = 0, lastBonk = 0;
  let dragging = false, moved = false, dragDX = 0, dragDY = 0, downAt = 0, samples = [], pleadTimer = 0;
  let blinkAt = 0, blinkEnd = 0, wallSide = 0, climbTarget = 0, climbPhase = 0, hangPhase = 0, fl = null, runTo = 0;
  let lastClick = 0, clickTimer = 0, idleMs = 0, wasAway = false, sleepManual = false, mood = null;
  let cursor = null;                         // { x, y, at } — где мышь (в координатах окна)
  const bornAt = now();

  const face = () => (mask === "cute" && CUTE_SKINS[skin] ? CUTE_SKINS[skin] : skin);
  const url = (p, k = face()) => "poses/" + k + "/" + p + ".webp";
  const has = (p) => skinCfg.has.includes(p);
  const H = () => clamp(Number(s.size) || 140, 60, 320);
  const feetPad = () => 6 * H() / 320;      // прозрачный отступ под ногами в картинках
  const speed = () => clamp(Number(s.speed) || 1, 0.3, 3);

  // какой файл рисовать для позы с учётом того, что есть в образе
  function frameOf(p) {
    for (let i = 0; i < 4 && p; i++) { if (has(p) || POSES.includes(p)) return p; p = FALLBACK[p]; }
    return "idle";
  }
  // куда смотрит нарисованная поза: 1 — вправо, -1 — влево, 0 — анфас (не отражаем)
  function facingOf(p) {
    const f = skinCfg.faces || {};
    if (p in f) return f[p];
    if (/^w\d|^walk/.test(p)) return f.walk ?? -1;
    if (/^r\d/.test(p)) return f.run ?? f.walk ?? -1;
    return 0;
  }

  // ================= Кадры =================
  // Кадры храним готовыми (уже декодированными) и меняем картинку, только когда новый кадр готов — без мигания.
  const frameCache = new Map();
  function frameImg(u) {
    let it = frameCache.get(u);
    if (!it) {
      const im = new Image(); im.decoding = "async"; im.src = u;
      it = { im, ready: false };
      im.decode().then(() => { it.ready = true; if (wantUrl === u) showUrl(u); }, () => {});
      frameCache.set(u, it);
    }
    return it;
  }
  function preload(k) {
    const c = cfgCache[k]; if (!c) return;
    for (const n of new Set(["idle", "blink", ...POSES, ...c.walk, ...(c.run || []), ...c.has])) frameImg(url(n, k));
  }
  // «якорь» кадра — где по ширине картинки голова (доля 0..1, из skin.json). При смене кадра
  // сдвигаем x так, чтобы голова осталась на месте: картинки разной ширины не дёргают его вбок.
  const axOf = (u, flip) => { const a = skinCfg.ax?.[u.slice(u.lastIndexOf("/") + 1, -5)] ?? 0.5; return flip ? 1 - a : a; };
  function showUrl(u) {
    if (img.getAttribute("src") === u) return;
    const it = frameCache.get(u);
    if (it && it.ready && it.im.naturalHeight) {      // размер нового кадра ставим сразу, до смены картинки
      const h = H() * it.im.naturalHeight / 320, w = H() * it.im.naturalWidth / 320, ax = axOf(u, wantFlip);
      if (img.getAttribute("src") && !dragging) x += curAx * curW - ax * w;
      img.style.height = h + "px"; curH = h; curW = w; curAx = ax;
    }
    el.classList.toggle("flip", wantFlip);
    img.src = u;
  }
  img.addEventListener("load", () => {
    curH = H() * img.naturalHeight / 320; curW = H() * img.naturalWidth / 320;
    curAx = axOf(img.getAttribute("src") || "", wantFlip);
    img.style.height = curH + "px";
  });
  function pose(p, look) {
    const f = frameOf(p);
    const fc = facingOf(f), lw = look ?? dir;
    const flip = fc !== 0 && lw !== 0 && Math.sign(lw) !== fc;
    if (f !== curPose) {
      curPose = f; wantFlip = flip;
      const u = url(f); wantUrl = u;
      const it = frameImg(u);
      if (it.ready || !img.getAttribute("src")) showUrl(u);
      return;
    }
    if (flip === wantFlip) return;
    wantFlip = flip;
    if (img.getAttribute("src") !== wantUrl) return;
    const ax = axOf(wantUrl, flip);
    if (!dragging) x += (curAx - ax) * curW;
    curAx = ax;
    el.classList.toggle("flip", flip);
  }
  function setAnim(a) {
    el.classList.toggle("walk", a === "walk");
    el.classList.toggle("breathe", a === "breathe");
    el.classList.toggle("happy", a === "happy");
    el.classList.toggle("sleeping", state === "sleep");
  }
  function squash() { el.classList.remove("squash"); void el.offsetWidth; el.classList.add("squash"); }
  function particles(ch, n = 3, color = "#ff4d6d") {
    for (let i = 0; i < n; i++) {
      const p = document.createElement("span");
      p.className = "pt"; p.textContent = ch; p.style.color = color;
      p.style.left = (35 + Math.random() * 30) + "%";
      p.style.animationDelay = (i * 0.12) + "s";
      p.style.setProperty("--dx", rnd(-18, 18).toFixed(0) + "px");
      p.addEventListener("animationend", () => p.remove());
      el.appendChild(p);
    }
  }
  function dust(n = 5) {
    for (let i = 0; i < n; i++) {
      const d = document.createElement("div");
      d.className = "dust";
      d.style.left = (x + curW / 2 + rnd(-curW * 0.3, curW * 0.3)) + "px";
      d.style.bottom = Math.max(0, yb) + "px";
      d.style.setProperty("--dx", rnd(-24, 24).toFixed(0) + "px");
      d.addEventListener("animationend", () => d.remove());
      document.body.appendChild(d);
    }
  }

  // ================= Образ и маски =================
  function chooseSkin(keep) {
    skin = SKINS.includes(s.skin) ? s.skin : keep && SKINS.includes(keep) ? keep : pick(SKINS);
    applyFace();
  }
  function applyFace() {
    const p = curPose;
    curPose = "";
    skinCfg = cfgCache[face()] || { ...BASE_CFG };
    el.classList.toggle("cycle", skinCfg.walk.length >= 4);
    preload(face());
    const other = face() === skin ? CUTE_SKINS[skin] : skin;    // вторая маска — заранее, чтобы смена была мгновенной
    if (other) setTimeout(() => preload(other), 1500);
    pose(/^(w|r)\d/.test(p) && state !== "walk" && state !== "run" ? "idle" : p || "idle");
  }
  function workPhase() {
    const d = new Date(), t = d.getHours() * 60 + d.getMinutes();
    if (d.getDay() === 0) return "off";
    if (t < 9 * 60 || t >= 18 * 60) return "off";
    if (t >= 13 * 60 && t < 14 * 60) return "break";
    return "work";
  }
  // Само выпадает раз в 8–22 минуты; в работу чаще суровый, в перерыв и после работы — милый.
  function baseMask() {
    if (s.mood === "cute" || s.mood === "stern") return s.mood;
    const ph = workPhase();
    if (!mood || Date.now() > mood.until || mood.phase !== ph) {
      const pCute = ph === "work" ? 0.3 : 0.75;
      mood = { m: Math.random() < pCute ? "cute" : "stern", until: Date.now() + rnd(8, 22) * 60000, phase: ph };
    }
    return mood.m;
  }
  function setMask(m, why, ms, line) {
    maskUntil = ms ? Date.now() + ms : 0; maskWhy = why || "";
    if (m === mask || !CUTE_SKINS[skin]) return false;
    mask = m;
    applyFace();
    particles(m === "cute" ? "✨" : "…", m === "cute" ? 3 : 1, m === "cute" ? "#ff8fb1" : "#888");
    if (line) say(line, { force: true });
    return true;
  }
  function trickScheme() {
    if (mask === "cute" || !ground || state === "sleep" || dragging || bubbleOn()) return;
    setMask("cute", "scheme", rnd(40000, 80000));
    pose(pick(["pet", "laugh", "wave"])); go("react", 2600);
    say(pick(SCHEME_LINES), { force: true });
  }
  function trickClick() {
    if (maskWhy !== "scheme" || mask !== "cute" || Math.random() < 0.45) return false;
    setMask("stern", "", 0);
    pose("cool"); go("react", 2000); say(pick(REVEAL), { force: true });
    return true;
  }
  function trickPlead() {
    if (mask === "cute" && maskWhy !== "held") return;
    setMask("cute", "held", 30000);
    pose("held", 0);
    say(pick(HELD_CUTE), { force: true });
  }
  function maskTick() {
    if (dragging || state === "held") return;
    if (maskUntil && Date.now() > maskUntil) {                 // маска «спала» сама
      const why = maskWhy, b = baseMask();
      maskUntil = 0; maskWhy = "";
      if (b !== mask) setMask(b, "", 0, why === "scheme" || why === "back" ? pick(REVEAL) : b === "cute" ? pick(TO_CUTE.mood) : pick(TO_STERN));
      return;
    }
    if (maskUntil) return;
    const b = baseMask();
    if (b !== mask) { setMask(b, "", 0, b === "cute" ? pick(TO_CUTE[workPhase()] || TO_CUTE.mood) : pick(TO_STERN)); return; }
    if (s.mood === "auto" && mask === "stern" && idleMs < 60000 && Math.random() < 0.012) trickScheme();
  }

  // ================= Облачко =================
  // Каждая реплика висит минимум 5 с, новые ждут в очереди (лишняя болтовня выбрасывается).
  const MIN_SHOW = 5000;
  let bubbleMin = 0, bubbleEnd = 0, sayQueue = [];
  const bubbleOn = () => bubble.classList.contains("on");
  function say(text, opt = {}) {
    if (!text) return;
    const t = now();
    if (bubbleOn() && t < bubbleMin && !opt.force) { if (sayQueue.length < 2) sayQueue.push(text); return; }
    bubble.textContent = text;
    bubble.classList.add("on");
    bubbleMin = t + MIN_SHOW;
    bubbleEnd = t + clamp(2500 + text.length * 75, MIN_SHOW, 30000);
  }
  function bubbleTick(t) {
    if (!bubbleOn()) return;
    if (t > bubbleEnd) {
      bubble.classList.remove("on");
      if (sayQueue.length) say(sayQueue.shift(), { force: true });
      return;
    }
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    const head = x + curAx * curW;
    const left = clamp(head - bw / 2, 6, Math.max(6, vw() - bw - 6));
    const bottom = Math.min(yb - feetPad() + curH * 0.96 + 10, vh() - bh - 6);
    bubble.style.left = left + "px";
    bubble.style.bottom = bottom + "px";
    bubble.style.setProperty("--s", clamp(head - (left + bw / 2), -bw / 2 + 12, bw / 2 - 12) + "px");
  }
  function hideBubble() { bubble.classList.remove("on"); sayQueue = []; }

  // ================= Поведение =================
  function go(next, ms) {
    state = next;
    until = now() + ms;
    el.classList.remove("aura");
    switch (next) {
      case "walk":
        if (Math.random() < 0.5) dir = -dir;
        if (x < 20) dir = 1;
        if (x > vw() - curW - 20) dir = -1;
        walkPhase = 0;
        setAnim("walk");
        break;
      case "idle": pose("idle"); setAnim("breathe"); break;
      case "sleep": pose("sleep", 0); setAnim("breathe"); break;
      case "meditate": pose("meditate", 0); setAnim("breathe"); el.classList.add("aura"); break;
      case "emote": {
        const e = pick(mask === "cute" ? CUTE_EMOTES : EMOTES);
        pose(e);
        setAnim(e === "laugh" || e === "cool" || e === "wave" || e === "pet" ? "happy" : "breathe");
        if (Math.random() < 0.25 && !bubbleOn()) say(mask === "cute" ? pick(CUTE_PHRASES) : pick(Math.random() < 0.4 ? DESK_PHRASES : PHRASES));
        break;
      }
      case "react": setAnim("happy"); break;    // позу ставит тот, кто вызвал
      case "run": case "chase": walkPhase = 0; setAnim(""); break;
    }
  }
  function nextState() {
    const age = now() - bornAt;
    if (age < 7000) { Math.random() < 0.7 ? go("idle", rnd(2000, 3500)) : go("emote", rnd(2500, 4000)); return; }
    if (idleMs > SLEEP_AFTER) { sleepManual = false; go("sleep", 30000); return; }
    const r = Math.random();
    if (canFly() && age > 15000 && r < 0.06) { flyRandom(); return; }
    if (r < 0.04) { go("meditate", rnd(8000, 15000)); if (Math.random() < 0.5) say(pick(["Дыши.", "Ци течёт.", "Тишина ума."])); return; }
    if (age > 15000 && r > 0.86 && cursor && Date.now() - cursor.at < 4000 && cursor.y > vh() * 0.5) { go("chase", 6000); return; }
    if (r < 0.14 && skinCfg.run) { runTo = clamp(rnd(0, vw() - curW), 0, vw() - curW); go("run", 7000); return; }
    if (r < 0.55) go("walk", rnd(3000, 9000));
    else if (r < 0.78) go("idle", rnd(2500, 6000));
    else go("emote", rnd(3500, 7000));
  }
  function sleepNow(manual) {
    if (!ground || dragging) return;
    sleepManual = manual; seq = null; go("sleep", 30000);
    if (manual) say(pick(["Отдохну.", "Разбуди, если что.", "…"]));
  }
  function wake(line = "Я не спал.") {
    if (state !== "sleep") return;
    sleepManual = false;
    pose("shock"); go("react", 1200); say(line);
  }

  // Последовательность кадров: [{p: поза, ms, say, until}], потом done()
  function play(steps, done) {
    seq = { steps, i: -1, t: 0, done };
    state = "seq";
    setAnim("breathe");
    nextStep();
  }
  function nextStep() {
    seq.i++;
    const st = seq.steps[seq.i];
    if (!st) { const d = seq.done; seq = null; d && d(); return; }
    seq.t = now() + st.ms;
    pose(st.p, dir);
    if (st.say) say(st.say);
  }

  // --- моргание в покое ---
  function blinkTick(t) {
    if (!has("blink")) return;
    if (blinkEnd && t > blinkEnd) { blinkEnd = 0; if (curPose === "blink") pose("idle"); }
    if (state === "idle" && curPose === "idle" && t > blinkAt) {
      pose("blink"); blinkEnd = t + 140;
      blinkAt = t + (Math.random() < 0.2 ? 260 : rnd(2500, 5500)); // иногда моргает дважды
    }
  }

  // --- бег: к случайной точке или к курсору ---
  const runFrames = () => skinCfg.run || skinCfg.walk;
  const runFps = () => (skinCfg.run ? skinCfg.runFps || 13 : skinCfg.walkFps * 1.5);
  const runSpeed = () => (skinCfg.run ? 190 : 120) * speed() * (H() / 140);
  function runTick(dt, t) {
    const maxX = Math.max(0, vw() - curW);
    const target = state === "chase" && cursor ? clamp(cursor.x - curW / 2, 0, maxX) : runTo;
    const dx = target - x;
    if (Math.abs(dx) < 14 || t > until) {
      pose("idle"); go("react", 1600);
      if (state === "react" && Math.random() < 0.4) say(pick(["Здесь.", "Что?", "Звал?"]));
      return;
    }
    dir = Math.sign(dx);
    walkPhase += dt * runFps();
    const fr = runFrames();
    pose(fr[Math.floor(walkPhase) % fr.length], dir);
    x += dir * Math.min(Math.abs(dx), runSpeed() * dt);
  }

  // --- лазание по краю экрана ---
  function startClimb(side) {
    wallSide = side; climbPhase = 0; dir = side;
    climbTarget = rnd(140, Math.max(160, vh() - H() * 1.05));
    ground = false; vy = vx = 0; state = "climb"; setAnim("");
  }
  function climbTick(dt) {
    x = wallSide > 0 ? Math.max(0, vw() - curW) : 0;
    climbPhase += dt * 3.2 * Math.sqrt(speed());
    pose(Math.floor(climbPhase) % 2 ? "climb2" : "climb1", wallSide);
    yb += 42 * speed() * dt * (H() / 140);
    const top = vh() - curH;
    if (yb >= top - 2) { yb = top; startHang(); return; }
    if (yb >= climbTarget) {
      if (Math.random() < 0.5 && has("hang1")) { climbTarget = top; return; } // лезет до самого верха
      say(pick(["Хм.", "Спускаюсь.", "…"]));
      launch(-wallSide * rnd(120, 320), rnd(150, 450), false);
    }
  }
  // --- вис на верхнем краю экрана ---
  function startHang() {
    state = "hang"; hangPhase = 0; until = now() + rnd(3500, 8000);
    ground = false; vy = vx = 0; setAnim("");
    if (Math.random() < 0.5) say(pick(["Обзор неплох.", "…", "Тренировка хвата."]));
  }
  function hangTick(dt, t) {
    hangPhase += dt * 1.8;
    pose(Math.floor(hangPhase) % 2 ? "hang2" : "hang1", 0);
    yb = vh() - curH;
    x = clamp(x + (wallSide ? -wallSide * 30 * dt : 0), 0, Math.max(0, vw() - curW)); // чуть отползает от угла
    if (t > until) { say(pick(["Хватит.", "…", "Спуск."])); launch(rnd(-80, 80), 0, false); }
  }

  // --- полёт (цингун) — только «Плащ» ---
  const canFly = () => skin === "cloak" && has("fly");
  function flyTo(tx, then) {
    const maxX = Math.max(0, vw() - curW);
    tx = clamp(tx, 0, maxX);
    const top = Math.max(H() * 0.6, vh() - curH - 40);
    fl = { tx, then, t: 0, alt: clamp(Math.max(yb, 0) + rnd(H() * 0.7, H() * 1.6), H() * 0.6, top), up: true, wait: 0.18 };
    ground = false; state = "flight"; seq = null; sliding = false; jumping = false; entering = false;
    thrown = false; spin = 0; rot = 0;
    dir = Math.sign(tx - x) || dir;
    setAnim(""); pose("crouch");
  }
  function flyRandom(asked) {
    const w = Math.max(0, vw() - curW);
    const tx = x < w / 2 ? rnd(Math.min(w, x + w * 0.45), w) : rnd(0, Math.max(0, x - w * 0.45));
    flyTo(tx, () => { if (asked || Math.random() < 0.3) say(pick(["Лёгкость тела — основа.", "Цингун.", "Ветер сегодня хороший.", "Хм. Неплохо."])); });
  }
  function flightTick(dt) {
    const f = fl;
    if (!f) { launch(0, 0, false); return; }
    if (f.wait > 0) { f.wait -= dt; return; }             // присел перед взлётом
    f.t += dt;
    const dx = f.tx - x, dist = Math.abs(dx);
    dir = Math.sign(dx) || dir;
    const near = H() * 1.3;
    const sp = 360 * (H() / 140) * Math.sqrt(speed());
    const want = dist > near ? f.alt : f.alt * (dist / near) ** 1.4;
    const bob = dist > near ? Math.sin(f.t * 3.2) * H() * 0.035 : 0;
    yb += (want + bob - yb) * Math.min(1, dt * (dist > near ? 2.6 : 4.5));
    x += dir * Math.min(dist, sp * dt * (dist > near ? Math.min(1, 0.35 + f.t * 0.9) : 0.45 + 0.55 * dist / near));
    if (f.up && f.t < 0.35) pose("leap", dir);
    else if (dist > near * 0.7) pose("fly", dir);
    else pose("leap", dir);
    if (dist < 3 && yb < 3) {                               // сел
      x = f.tx; yb = 0; ground = true; fl = null; fallFrom = 0;
      squash(); dust(5);
      const then = f.then;
      play([{ p: "crouch", ms: 260 }], () => { go("idle", rnd(900, 1600)); then && then(); });
    }
  }

  // ================= Физика =================
  function launch(nvx, nvy, wasThrown) {
    ground = false; vx = nvx; vy = nvy; thrown = wasThrown; bounces = 0; fallFrom = yb;
    airPeak = yb; airAt = now();
    state = "air"; seq = null;
    setAnim("");
  }
  function bonk(force) {
    const t = now();
    if (t - lastBonk < 500) return;
    lastBonk = t;
    squash();
    if (force > 900 && Math.random() < 0.6) say(pick(["Тц.", "Край экрана.", "…", "Хм."]));
  }
  function airPoseSet(p, look) {
    const t = now();
    if (p !== curPose && curPose !== "crouch" && t - airPoseAt < 180 && p !== "tumble") return;
    if (p !== curPose) airPoseAt = t;
    pose(p, look);
  }
  function airPose() {
    if (yb > airPeak) airPeak = yb;
    const look = Math.sign(vx) || dir;
    // «падение с раскрытым плащом» — только при настоящем падении с высоты
    const big = airPeak - yb > H() * 1.2 || vy < -1000;
    if (Math.abs(spin) > 260) { airPoseSet("tumble"); return; }
    if (entering) { airPoseSet(big ? "fall" : "leap", look); return; }
    if (jumping) { airPoseSet(big && vy < 0 ? "fall" : "leap", look); return; }
    if (thrown) {
      if (Math.abs(vx) > 520 && Math.abs(vx) > Math.abs(vy) * 0.6) { airPoseSet("fly", look); return; }
      airPoseSet(big ? "fall" : "held", look);
      return;
    }
    if (!big || now() - airAt < 160) return;
    airPoseSet("fall", look);
  }
  function air(dt) {
    vy -= G * dt;
    x += vx * dt; yb += vy * dt;
    vx *= Math.pow(PHY.airDrag, dt);
    rot += spin * dt; spin *= Math.pow(0.7, dt);
    if (Math.abs(spin) < 260 && Math.abs(rot % 360) > 1) rot += (Math.round(rot / 360) * 360 - rot) * Math.min(1, dt * 8); // докручиваемся ровно
    const maxX = Math.max(0, vw() - curW);
    if (x < 0 || x > maxX) {
      const f = Math.abs(vx);
      x = clamp(x, 0, maxX);
      vx = (x <= 0 ? 1 : -1) * f * PHY.wallBounce;
      if (f > 900) spin = clamp(-spin * 0.6 + (x <= 0 ? 1 : -1) * 400, -1100, 1100);
      bonk(f);
    }
    const ceil = vh() - H() * 0.95;
    if (yb > ceil && !entering) { yb = ceil; bonk(Math.abs(vy)); vy = -Math.abs(vy) * 0.35; }
    airPose();
    if (vy > 0 || yb > 0) return;
    // приземление на пол
    yb = 0;
    const impact = -vy;
    if (thrown && impact > PHY.bounceMin && bounces < 6) {   // отскок, как у мячика
      bounces++; airPeak = 0;
      vy = impact * PHY.floorBounce;
      vx *= 0.8;
      spin = spin * 0.6 + vx * 0.25;
      maxImpact = Math.max(maxImpact, impact);
      squash(); dust(4);
      if (impact > PHY.hardHit && bounces === 1) say(pick(["Тц.", "…", "Хм."]));
      return;
    }
    maxImpact = Math.max(maxImpact, impact);
    touchDown();
  }
  function touchDown() {
    ground = true; vy = 0; spin = 0; rot = 0; jumping = false;
    if (entering) {
      entering = false; vx = 0; squash(); dust(6);
      x = clamp(x, 0, Math.max(0, vw() - curW));
      play([{ p: "crouch", ms: 260 }], () => { pose("wave"); go("react", 1600); say(greeting()); });
      return;
    }
    const hard = thrown && (maxImpact > PHY.hardHit || bounces >= 2);
    const wasThrown = thrown;
    thrown = false; maxImpact = 0; bounces = 0;
    squash();
    if (hard || (wasThrown && Math.abs(vx) > 250)) {
      // шлёпнулся: скользит лицом по полу, лежит, сидит со звёздочками, потирает шишку
      sliding = Math.abs(vx) > 60;
      dust(8);
      play([
        { p: "splat", ms: 1300, until: () => !sliding },
        { p: "dizzy", ms: 1700, say: pick(["…Неплохой бросок.", "Тц.", "…", "Не повторяй."]) },
        { p: "rub", ms: 1400, say: Math.random() < 0.5 ? pick(["Хватит.", "Зачем?", "Тц."]) : "" },
      ], () => go("idle", rnd(800, 1600)));
      return;
    }
    vx = 0;
    if (wasThrown) play([{ p: "crouch", ms: 220 }, { p: "shock", ms: 700, say: pick(["Тц.", "Приземлился.", "Зачем?"]) }], () => go("idle", 1200));
    else if (fallFrom - yb > 160) play([{ p: "crouch", ms: 240 }], () => go("idle", rnd(800, 1500)));
    else go("idle", rnd(800, 1800));
  }
  function greeting() {
    const h = new Date().getHours();
    if (mask === "cute") return pick(["Я тут~ ✨", "Привет-привет ♡", "Скучал? Я — да~"]);
    if (h < 6) return pick(["Ночь. Почему не спишь?", "Поздно."]);
    if (h < 12) return pick(["Утро. За работу.", "Доброе утро. Работаем."]);
    if (h < 18) return pick(["Здесь.", "На месте.", "…"]);
    return pick(["Вечер. Заканчивай.", "Ещё работаешь?"]);
  }

  function onGround(dt, t, pdt) {
    yb = 0;
    if (sliding) {                       // скольжение после падения
      x += vx * pdt;
      vx *= Math.pow(PHY.slideFriction, pdt);
      const maxX = Math.max(0, vw() - curW);
      if (x < 0 || x > maxX) { x = clamp(x, 0, maxX); vx = -vx * 0.4; bonk(Math.abs(vx)); }
      if (Math.abs(vx) < 40) { sliding = false; vx = 0; }
    }
    if (state === "run" || state === "chase") { runTick(dt, t); return; }
    blinkTick(t);
    if (state === "seq") {
      const st = seq && seq.steps[seq.i];
      if (!st) { go("idle", 1000); return; }
      if (t > seq.t && (!st.until || st.until())) nextStep();
      return;
    }
    if (state === "sleep") {
      if (t > until) { if (sleepManual || idleMs > SLEEP_AFTER) until = t + 30000; else wake("…Я просто моргнул."); }
      return;
    }
    if (state === "walk") {
      const frames = skinCfg.walk;
      walkPhase += dt * skinCfg.walkFps * speed();   // ноги в такт шагу: без «скольжения»
      pose(frames[Math.floor(walkPhase) % frames.length], dir);
      x += dir * 55 * speed() * dt * (H() / 140);
      const maxX = Math.max(0, vw() - curW);
      if (x < 0 || x > maxX) x = clamp(x, 0, maxX);
      if ((x <= 0 && dir < 0) || (x >= maxX && dir > 0)) {
        // упёрся в край экрана — иногда лезет вверх
        if (has("climb1") && Math.random() < 0.4) { startClimb(x <= 0 ? -1 : 1); return; }
        dir = -dir;
      }
    }
    if (t > until) nextState();
  }

  // ================= Главный цикл =================
  let lastT = now();
  function loop(t) {
    const dt = Math.min(50, t - lastT) / 1000;
    lastT = t;
    const pdt = dt * 0.8;              // полёт и падение чуть замедлены — смотрится мягче
    if (!dragging) {
      if (state === "climb") climbTick(dt);
      else if (state === "hang") hangTick(dt, t);
      else if (state === "flight") flightTick(dt);
      else if (!ground) { if (state !== "air") state = "air"; air(pdt); }
      else onGround(dt, t, pdt);
    }
    el.style.transform = `translate(${x}px, ${-yb + feetPad()}px)`;
    spinEl.style.transform = rot ? `rotate(${rot}deg)` : "";
    bubbleTick(t);
    syncHit(t);
    requestAnimationFrame(loop);
  }

  // Сообщаем Rust, где сейчас чиби: там окно ловит мышь, в остальных местах клики проходят насквозь.
  let lastHit = "", lastHitAt = 0;
  function syncHit(t, force) {
    const r = img.getBoundingClientRect();
    const hx = r.left + r.width * 0.12, hy = r.top + r.height * 0.06, hw = r.width * 0.76, hh = r.height * 0.94;
    const key = [hx, hy, hw, hh].map((v) => Math.round(v / 3)).join(",") + dragging;
    if (key === lastHit || (!force && t - lastHitAt < 40)) return;
    lastHit = key; lastHitAt = t;
    call("set_hit", { x: hx, y: hy, w: hw, h: hh, drag: dragging }).catch(() => {});
  }

  // ================= Мышь: клик, двойной клик, перетаскивание, бросок =================
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true; moved = false; downAt = now();
    dragDX = e.clientX - x;
    dragDY = (vh() - e.clientY) - yb;
    samples = [{ t: downAt, x, y: yb }];
    el.classList.add("drag");
    try { el.setPointerCapture(e.pointerId); } catch {}
    syncHit(now(), true);
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const nx = e.clientX - dragDX, ny = (vh() - e.clientY) - dragDY;
    if (!moved && Math.abs(nx - x) + Math.abs(ny - yb) > 4) {
      moved = true; ground = false; rot = 0; spin = 0; state = "held"; seq = null; sliding = false; jumping = false; fl = null; entering = false;
      el.classList.remove("aura", "sleeping");
      pose("held", 0); setAnim(""); hideBubble();
      if (Math.random() < 0.35) say(pick(["Поставь.", "Руки.", "Не за шкирку."]));
      clearTimeout(pleadTimer);
      pleadTimer = setTimeout(() => { if (dragging && state === "held") trickPlead(); }, 1600);
    }
    if (!moved) return;
    x = nx; yb = Math.max(0, ny);
    const t = now();
    samples.push({ t, x, y: yb });
    while (samples.length > 2 && t - samples[0].t > 100) samples.shift();
  });
  function onUp() {
    if (!dragging) return;
    dragging = false;
    clearTimeout(pleadTimer);
    el.classList.remove("drag");
    syncHit(now(), true);
    if (maskWhy === "held") setTimeout(() => { if (maskWhy === "held") setMask(baseMask(), "", 0, pick(AFTER_HELD)); }, 2600);
    if (!moved) { if (now() - downAt < 450) onClick(); return; }
    // скорость броска — по последним ~100 мс движения
    const a = samples[0], b = samples[samples.length - 1];
    const dt = Math.max(16, b.t - a.t) / 1000;
    let tvx = (b.x - a.x) / dt, tvy = (b.y - a.y) / dt;
    if (now() - b.t > 120) { tvx = 0; tvy = 0; }       // остановил мышь перед отпусканием
    tvx = clamp(tvx, -4200, 4200); tvy = clamp(tvy, -4200, 4200);
    const sp = Math.hypot(tvx, tvy);
    launch(tvx, tvy, true);
    // сильный бросок — кувырком, средний — летит «суперменом»
    spin = sp > 1900 && Math.random() < 0.6 ? clamp(tvx * 0.35, -1000, 1000) || 450 : 0;
  }
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("contextmenu", (e) => e.preventDefault());

  function onClick() {
    const t = now();
    if (t - lastClick < 330) {                          // двойной клик
      clearTimeout(clickTimer); lastClick = 0;
      if (canFly() && ground) flyRandom(true);
      else { pose("laugh"); go("react", 1600); say(mask === "cute" ? "Хи-хи~ ещё!" : "Хватит тыкать."); }
      return;
    }
    lastClick = t;
    if (state === "sleep") { wake(); return; }
    if (state === "seq") { say(pick(["Дай встать.", "Подожди.", "…"])); return; }
    clickTimer = setTimeout(() => {
      if (trickClick()) return;
      const r = pick(mask === "cute" ? CUTE_CLICK : CLICK_REACT);
      pose(r); go("react", 1600);
      if (Math.random() < 0.6) say(mask === "cute" ? pick(CUTE_PHRASES) : pick(Math.random() < 0.3 ? DESK_PHRASES : PHRASES));
    }, 280);
  }

  // ================= Система: бездействие пользователя, курсор, трей =================
  async function pollIdle() {
    try { idleMs = Number(await call("idle_ms")) || 0; } catch { idleMs = 0; }
    if (idleMs > AWAY_AFTER) wasAway = true;
    else if (wasAway && idleMs < 4000) {                // вернулся к компьютеру — встречает мило
      wasAway = false;
      if (state === "sleep") { wake(mask === "cute" ? pick(BACK_CUTE) : "Я не спал."); return; }
      if (ground && !dragging && s.mood === "auto") { setMask("cute", "back", 9000, pick(BACK_CUTE)); pose("wave"); go("react", 2200); }
    }
  }
  async function pollCursor() {
    try {
      const p = await call("cursor_pos");
      if (!p) return;
      const [cx, cy] = p;
      if (!cursor || Math.abs(cursor.x - cx) + Math.abs(cursor.y - cy) > 3) cursor = { x: cx, y: cy, at: Date.now() };
    } catch {}
  }

  function callDown() {
    if (dragging) return;
    fl = null; seq = null; sliding = false; el.classList.remove("aura", "sleeping");
    x = clamp(vw() / 2 - curW / 2 + rnd(-vw() * 0.2, vw() * 0.2), 0, Math.max(0, vw() - curW));
    yb = vh() - curH * 0.2;
    entering = true;
    launch(0, 0, false);
    entering = true;
  }
  function onTray(id) {
    const [k, v] = String(id).split(":");
    if (k === "skin") {
      s.skin = v; saveSettings();
      chooseSkin(skin);
      pose("wave"); if (ground) go("react", 1600);
      say(skin === "cloak" ? "Плащ. Хорошо." : "Ученик. Как скажешь.");
    } else if (k === "mood") {
      s.mood = v; saveSettings();
      mood = null; maskUntil = 0; maskWhy = "";
      const b = baseMask();
      if (!setMask(b, "", 0, b === "cute" ? pick(TO_CUTE.mood) : pick(TO_STERN))) say(v === "auto" ? "Буду по настроению." : "Хм.");
    } else if (k === "size") {
      s.size = +v || 140; saveSettings();
      const u = img.getAttribute("src");
      const it = u && frameCache.get(u);
      if (it && it.im.naturalHeight) { curH = H() * it.im.naturalHeight / 320; curW = H() * it.im.naturalWidth / 320; img.style.height = curH + "px"; }
      x = clamp(x, 0, Math.max(0, vw() - curW));
    } else if (k === "call") callDown();
    else if (k === "fly") { if (canFly() && ground) flyRandom(true); else say(skin === "cloak" ? "Дай сначала встать." : "Без плаща не летаю."); }
    else if (k === "sleep") { if (state === "sleep") wake("Проснулся."); else sleepNow(true); }
  }

  addEventListener("resize", () => { x = clamp(x, 0, Math.max(0, vw() - curW)); if (yb > vh() - curH) yb = Math.max(0, vh() - curH); });

  // ================= Запуск =================
  async function loadCfg(k) {
    let j = {};
    try { const r = await fetch("poses/" + k + "/skin.json"); if (r.ok) j = await r.json(); } catch {}
    cfgCache[k] = { ...BASE_CFG, ...j, faces: { ...BASE_CFG.faces, ...(j.faces || {}) }, has: [...(j.has || []), ...(j.walk || [])] };
  }
  async function start() {
    await Promise.all(["cloak", "cloak_cute", "disciple", "disciple_cute"].map(loadCfg));
    mask = baseMask();
    chooseSkin();
    x = rnd(0.2, 0.8) * Math.max(0, vw() - H() * 0.6);
    callDown();                                  // появляется: падает сверху и приземляется на панель задач
    if (TAURI) {
      TAURI.event.listen("tray", (e) => onTray(e.payload));
      setInterval(pollIdle, 2000);
      setInterval(pollCursor, 400);
    }
    setInterval(maskTick, 15000);
    requestAnimationFrame((t) => { lastT = t; loop(t); });
  }
  start();
})();
