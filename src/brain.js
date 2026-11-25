// Понимание кода и текста без нейросети — перенесено из расширения Chibi Walker.
// Используется для кода из открытого в редакторе файла и для текста из буфера обмена.
"use strict";
window.Brain = (() => {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const short = (t, n = 26) => (t.length > n ? t.slice(0, n - 1).trim() + "…" : t);
  const fmtDur = (sec) => { const m = Math.round(sec / 60); return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60 ? (m % 60) + " мин" : ""}`.trim(); };

  // ================= Понимание кода и текста (офлайн, без нейросети) =================
  const STOP = new Set(("и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее её мне было вот от меня еще ещё нет о из ему теперь когда даже ну ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех можно при об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя свою этой перед иногда лучше чуть том такой более всегда конечно между это также такие которые который которая которых является может году года лет очень просто " +
    "the and for that this with from have are was were will would your you they them their there what which when where who how why not but can all any been more most other some such than then into over also just only its our out about after before between both each few here same very these those through under while being does doing did had has having should could may might must one two use used using make made get got new like time") .split(/\s+/));

  function langOfText(t) {
    const cyr = (t.match(/[а-яё]/gi) || []).length, lat = (t.match(/[a-z]/gi) || []).length;
    if (/[oʻgʻ]ʻ|o'z|g'|\b(va|bilan|uchun|emas|ham|bu|men|siz|qilish|bo'lib|yoki)\b/i.test(t) && lat > cyr) return "uz";
    if (/[ўқғҳ]/i.test(t)) return "uz";
    if (cyr > lat * 1.5) return "ru";
    if (lat > cyr * 1.5) return "en";
    return "mixed";
  }
  function keywords(t, n = 4) {
    const f = new Map();
    for (const w of (t.toLowerCase().match(/[a-zа-яёўқғҳ][a-zа-яёўқғҳ'-]{3,}/g) || [])) {
      if (STOP.has(w) || w.length > 22) continue;
      f.set(w, (f.get(w) || 0) + 1);
    }
    return [...f.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
  }
  const wordCount = (t) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  const readMin = (w) => Math.max(1, Math.round(w / 200));
  function firstSentence(t, max = 150) {
    const m = t.replace(/\s+/g, " ").trim().match(/^.{20,}?[.!?](\s|$)/);
    const s1 = (m ? m[0] : t).trim();
    return s1.length > max ? s1.slice(0, max - 1) + "…" : s1;
  }

  // --- код ---
  const LANGS = [
    ["Python", /^\s*(def|class|import|from|elif|async def)\b|^\s*@\w+|self\.|print\(|:\s*$/m],
    ["TypeScript", /:\s*(string|number|boolean|any|void|unknown)\b|\binterface\s+\w+|\btype\s+\w+\s*=|<\w+>\(/],
    ["JavaScript", /\b(const|let|var|function|=>|console\.log|require\(|document\.|window\.)|import .* from|export (default|const|function)/],
    ["PHP", /<\?php|\$\w+\s*=|->\w+\(|\becho\s|\bfunction\s+\w+\s*\(\$/],
    ["SQL", /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE|WHERE|JOIN|GROUP BY)\b/i],
    ["HTML", /<\/?(div|span|html|body|head|a|p|ul|li|section|button|input|script)\b[^>]*>/i],
    ["CSS", /^[\s.#\w-]+[\w\])-]\s*\{[^}]*:[^}]*;?\s*\}?/m],
    ["Bash", /^\s*(\$ |sudo |apt(-get)? |cd |ls |chmod |chown |echo |export |npm |pip |git |docker |curl |wget |systemctl )/m],
    ["JSON", /^\s*[[{]\s*"[^"]+"\s*:/],
    ["Go", /\bfunc\s+(\(\w+ \*?\w+\)\s*)?\w+\(|\bpackage\s+\w+|:=/],
    ["Rust", /\bfn\s+\w+|\blet\s+mut\b|\bimpl\b|println!\(/],
    ["Java/C#", /\b(public|private|protected)\s+(static\s+)?(void|class|int|String|bool|var)\b/],
    ["C/C++", /#include\s*[<"]|\bstd::|\bprintf\(|\bint\s+main\s*\(/],
  ];
  function looksLikeCode(t) {
    const lines = t.split("\n");
    const sig = (t.match(/[;{}()=<>[\]]/g) || []).length / Math.max(1, t.length);
    return (lines.length > 1 && sig > 0.03) || LANGS.some(([, re]) => re.test(t)) && sig > 0.015;
  }
  function stripStrings(code) {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/^\s*#(?!include).*$/gm, "")
      .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""');
  }
  function analyzeCode(code) {
    // большой файл анализируем по началу, но строки считаем по всему; скобки на обрезке не проверяем
    const fullLoc = code.split("\n").filter((l) => l.trim()).length, cut = code.length > 20000;
    code = code.slice(0, 20000);
    let lang = "код", best = 0;
    for (const [name, re] of LANGS) {
      const n = (code.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) || []).length;
      if (n > best) { best = n; lang = name; }
    }
    if (lang === "JavaScript" && /:\s*(string|number|boolean)\b|\binterface\s/.test(code)) lang = "TypeScript";
    const lines = code.split("\n");
    const loc = cut ? fullLoc : lines.filter((l) => l.trim()).length;
    const funcs = [...new Set([...code.matchAll(/(?:\bdef|\bfunction|\bfunc|\bfn)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g)].map((m) => m[1] || m[2]))];
    const classes = [...new Set([...code.matchAll(/\bclass\s+([A-Z]\w*)/g)].map((m) => m[1]))];
    const issues = [];
    const bare = stripStrings(code);
    const bal = (o, c) => (bare.split(o).length - 1) - (bare.split(c).length - 1);
    const br = [["(", ")", "круглых"], ["{", "}", "фигурных"], ["[", "]", "квадратных"]].map(([o, c, nm]) => [bal(o, c), nm]).filter(([d]) => d !== 0);
    if (/(api[_-]?key|secret|passw(or)?d|token|private[_-]?key)\s*[:=]\s*["'`][^"'`\s]{6,}/i.test(code)) issues.push("ключ или пароль прямо в коде — убери в .env");
    if (/\b(SELECT|UPDATE|DELETE|INSERT)\b[^;\n]*(["'`]\s*\+\s*\w|\$\{|%s|\{\w+\})/i.test(code)) issues.push("SQL склеивается из переменных — риск инъекции, используй параметры");
    if (br.length && loc > 2 && !cut) issues.push(br.map(([d, nm]) => `${nm} скобок ${d > 0 ? "открыто" : "закрыто"} на ${Math.abs(d)} больше`).join(", ") + " — проверь");
    if (/\beval\s*\(/.test(bare)) issues.push("eval() — опасно, лучше без него");
    if (/catch\s*\([^)]*\)\s*\{\s*\}|except\s*:\s*pass|except\s+\w+\s*:\s*pass/.test(code)) issues.push("ошибка ловится и молча глотается — хотя бы залогируй");
    if (/def\s+\w+\([^)]*=\s*(\[\]|\{\})/.test(code)) issues.push("изменяемое значение по умолчанию (=[] или ={}) — классическая ловушка Python");
    if (/\bexcept\s*:/.test(code)) issues.push("голый except: ловит вообще всё, даже Ctrl+C");
    const todo = (code.match(/\b(TODO|FIXME|HACK|XXX)\b/g) || []).length;
    if (todo) issues.push(`вижу ${todo > 1 ? todo + " " : ""}TODO/FIXME — не забудь доделать`);
    const dbg = (code.match(/console\.(log|debug)\(|\bprint\(|var_dump\(|\bdd\(|\bdebugger\b/g) || []).length;
    if (dbg >= 2 || (dbg && lang !== "Python")) issues.push(`${dbg} отладочных вывод${dbg === 1 ? "" : "а"} (console.log/print) — убери перед коммитом`);
    if ((lang === "JavaScript" || lang === "TypeScript") && /[^=!<>]==[^=]/.test(bare)) issues.push("== вместо === — сравнение с приведением типов");
    if ((lang === "JavaScript" || lang === "TypeScript") && /\bvar\s/.test(bare)) issues.push("var? в 2026-м лучше let/const");
    if (/:\s*any\b/.test(code) && lang === "TypeScript") issues.push("any в TypeScript — типизация теряется");
    const longL = lines.filter((l) => l.length > 120).length;
    if (longL >= 2) issues.push(`${longL} длинных строк (>120 символов) — читать тяжело`);
    const depth = Math.max(0, ...lines.map((l) => (l.match(/^\s*/)[0].replace(/\t/g, "    ").length)));
    if (depth >= 24) issues.push("очень глубокая вложенность — может, вынести в функции?");
    const comments = (code.match(/^\s*(\/\/|#(?!include)|--|\/\*|\*)/gm) || []).length;
    const praise = [];
    if (!issues.length) {
      if (loc <= 25 && funcs.length) praise.push("Короткая функция. Правильно.");
      if (comments >= 2) praise.push("Комментарии есть. Хорошо.");
      if (/\b(test|it|describe|assert)\s*\(|def test_/.test(code)) praise.push("Тесты есть. Достойно.");
      if (!praise.length) praise.push(pick(["Чисто.", "Ошибок не вижу.", "Аккуратно.", "Сойдёт."]));
    }
    return { lang, loc, funcs, classes, issues, praise };
  }
  function codeComment(code) {
    const a = analyzeCode(code);
    const what = [a.lang === "код" ? "это код" : `это ${a.lang}`, `${a.loc} строк${a.loc % 10 === 1 && a.loc % 100 !== 11 ? "а" : [2, 3, 4].includes(a.loc % 10) && ![12, 13, 14].includes(a.loc % 100) ? "и" : ""}`];
    if (a.classes.length) what.push(`класс ${a.classes.slice(0, 2).join(", ")}`);
    if (a.funcs.length) what.push(`функци${a.funcs.length > 1 ? "и" : "я"} ${a.funcs.slice(0, 3).map((f) => f + "()").join(", ")}${a.funcs.length > 3 ? "…" : ""}`);
    return what.join(", ") + ".\n" + (a.issues.length ? "⚠ " + a.issues.slice(0, 2).join("\n⚠ ") : a.praise[0]);
  }

  // --- выделенный текст: маленькие помощники для программиста ---
  function selectionFacts(t) {
    const s1 = t.trim();
    // JSON
    if (/^[[{]/.test(s1) && /[\]}]$/.test(s1)) {
      try {
        const j = JSON.parse(s1);
        const keys = Array.isArray(j) ? `массив из ${j.length} элементов` : `${Object.keys(j).length} ключей: ${Object.keys(j).slice(0, 4).join(", ")}${Object.keys(j).length > 4 ? "…" : ""}`;
        return { auto: true, text: `JSON валидный ✅ ${keys}` };
      } catch (e) {
        const pos = /position (\d+)/.exec(e.message)?.[1];
        return { auto: true, text: `JSON с ошибкой ❌${pos ? ` около символа ${pos}` : ""}: ${short(e.message, 60)}` };
      }
    }
    // время Unix
    if (/^\d{10}(\d{3})?$/.test(s1)) {
      const ms = s1.length === 13 ? +s1 : +s1 * 1000;
      const d = new Date(ms);
      if (d.getFullYear() > 1990 && d.getFullYear() < 2100) return { auto: true, text: `🕒 ${d.toLocaleString("ru-RU")}` };
    }
    // цвет
    const col = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s1) || /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s1);
    if (col) return { auto: true, text: `🎨 цвет ${s1} — ${colorName(s1)}`, color: s1 };
    // base64
    if (s1.length >= 12 && s1.length <= 4000 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(s1) && s1.length % 4 !== 1) {
      try {
        const bin = atob(s1.replace(/-/g, "+").replace(/_/g, "/"));
        const txt = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
        if (/^[\p{L}\p{N}\p{P}\p{Zs}\n\r\t{}<>$=+*/\\|~^`'"-]+$/u.test(txt) && txt.length > 3) return { auto: true, text: `base64 → «${short(txt, 80)}»` };
      } catch {}
    }
    // JWT
    if (/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/.test(s1)) {
      try { const p = JSON.parse(atob(s1.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); return { auto: true, text: `JWT 🔑 поля: ${Object.keys(p).slice(0, 5).join(", ")}${p.exp ? `, истекает ${new Date(p.exp * 1000).toLocaleString("ru-RU")}` : ""}` }; } catch {}
    }
    const dev = devFacts(t);
    if (dev) return dev;
    // ссылка
    if (/^https?:\/\/\S+$/i.test(s1)) {
      try { const u = new URL(s1); const q = [...u.searchParams.keys()]; return { auto: false, text: `ссылка на ${u.hostname}${u.pathname.length > 1 ? `, путь ${short(u.pathname, 30)}` : ""}${q.length ? `, параметры: ${q.slice(0, 4).join(", ")}` : ""}` }; } catch {}
    }
    if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(s1)) return { auto: false, text: `это почта, домен ${s1.split("@")[1]} ✉️` };
    // список чисел
    const nums = s1.match(/-?\d+(?:[.,]\d+)?/g);
    if (nums && nums.length >= 3 && nums.join("").length > s1.replace(/[\s,;|]/g, "").length * 0.6) {
      const v = nums.map((n) => parseFloat(n.replace(",", ".")));
      const sum = v.reduce((a, b) => a + b, 0), r = (x) => parseFloat(x.toPrecision(10));
      return { auto: true, text: `${v.length} чисел: сумма ${r(sum)}, среднее ${r(sum / v.length)}, мин ${Math.min(...v)}, макс ${Math.max(...v)}` };
    }
    // код
    if (looksLikeCode(t)) return { auto: false, text: codeComment(t), long: true };
    // текст
    const w = wordCount(t);
    if (w >= 25) {
      const kw = keywords(t, 3), lang = { ru: "по-русски", en: "по-английски", uz: "по-узбекски", mixed: "на смеси языков" }[langOfText(t)];
      return { auto: false, long: true, text: `${w} слов ${lang}, ~${readMin(w)} мин чтения.${kw.length ? `\nглавные слова: ${kw.join(", ")}` : ""}\nначало: «${firstSentence(t, 110)}»` };
    }
    if (w >= 1) return { auto: false, text: `${w} ${w === 1 ? "слово" : w < 5 ? "слова" : "слов"}, ${s1.length} символов${/\d/.test(s1) ? ", есть цифры" : ""}` };
    return null;
  }
  function colorName(c) {
    let r, g, b;
    const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (h) { let x = h[1]; if (x.length === 3) x = x.replace(/./g, "$&$&"); [r, g, b] = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); }
    else [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 510;
    if (mx - mn < 18) return l > 0.85 ? "почти белый" : l < 0.15 ? "почти чёрный" : "серый";
    let hue = mx === r ? ((g - b) / (mx - mn)) * 60 : mx === g ? (2 + (b - r) / (mx - mn)) * 60 : (4 + (r - g) / (mx - mn)) * 60;
    hue = (hue + 360) % 360;
    const names = [[15, "красный"], [40, "оранжевый"], [65, "жёлтый"], [160, "зелёный"], [200, "бирюзовый"], [250, "синий"], [290, "фиолетовый"], [335, "розовый"], [360, "красный"]];
    const nm = names.find(([hh]) => hue < hh)[1];
    return (l > 0.75 ? "светло-" : l < 0.3 ? "тёмно-" : "") + nm;
  }


  // ================= Помощники программиста для выделенного текста =================
  const HTTP = { 200: "OK — всё хорошо", 201: "создано", 204: "успех, но без тела ответа", 301: "переехало навсегда (редирект)", 302: "временный редирект", 304: "не изменилось — бери из кэша",
    400: "кривой запрос — проверь параметры/JSON", 401: "не авторизован — нет или протух токен", 403: "запрещено — прав не хватает", 404: "не найдено — проверь URL", 405: "метод не тот (GET/POST?)",
    408: "сервер не дождался запроса", 409: "конфликт — данные уже изменились", 413: "слишком большой запрос/файл", 415: "не тот Content-Type", 418: "я чайник 🫖", 422: "данные не прошли валидацию",
    429: "слишком часто — притормози, лимит", 500: "сервер упал внутри — смотри логи", 502: "прокси/шлюз не достучался до бэкенда", 503: "сервис недоступен/перегружен", 504: "шлюз не дождался ответа — таймаут" };
  const ERRS = [
    [/ECONNREFUSED|Connection refused|SQLSTATE\[HY000\] \[2002\]/i, "соединение отклонено: сервис не запущен или не тот порт/хост"],
    [/ETIMEDOUT|timed out|timeout/i, "таймаут: сервер не ответил вовремя — сеть, файрвол или он завис"],
    [/ENOTFOUND|getaddrinfo|Name or service not known/i, "домен не найден — опечатка в адресе или DNS"],
    [/EADDRINUSE|address already in use/i, "порт уже занят — найди процесс: lsof -i :ПОРТ (или netstat -ano на Windows)"],
    [/ENOENT|No such file or directory/i, "файла или папки нет — проверь путь"],
    [/EACCES|Permission denied(?! \(publickey)/i, "нет прав — проверь владельца/права (chmod/chown)"],
    [/Permission denied \(publickey\)/i, "SSH-ключ не подошёл: ssh-add, проверь ключ в GitHub/на сервере"],
    [/CORS|Access-Control-Allow-Origin/i, "CORS: сервер не разрешил запрос с этого домена — нужен заголовок Access-Control-Allow-Origin"],
    [/non-fast-forward|\[rejected\]|Updates were rejected/i, "git: на сервере есть новые коммиты — сделай git pull --rebase, потом push"],
    [/CONFLICT|Merge conflict|<<<<<<<|>>>>>>>/i, "конфликт слияния: поправь файлы с <<<<<<< и сделай git add + commit"],
    [/detached HEAD/i, "ты не на ветке: git switch -c новая-ветка, чтобы не потерять коммиты"],
    [/not a git repository/i, "тут нет git: перейди в папку проекта или git init"],
    [/Your branch is behind/i, "ветка отстаёт: git pull"],
    [/ModuleNotFoundError|No module named/i, "модуль не установлен: pip install …, или не то окружение (venv)"],
    [/Cannot find module|MODULE_NOT_FOUND/i, "модуль не найден: npm install, или проверь путь импорта"],
    [/IndentationError|unexpected indent/i, "отступы поехали — пробелы и табы перемешаны?"],
    [/KeyError/i, "такого ключа нет в словаре — используй .get()"],
    [/(TypeError|Cannot read propert(y|ies) of (undefined|null))/i, "обращение к undefined/null — где-то значение не пришло, проверь ?."],
    [/is not defined|ReferenceError|NameError/i, "переменная не объявлена или опечатка в имени"],
    [/SyntaxError/i, "синтаксическая ошибка — смотри строку и символ рядом (скобка, запятая, кавычка)"],
    [/NullPointerException/i, "NPE: объект null — проверь инициализацию"],
    [/Segmentation fault|SIGSEGV/i, "segfault: обращение к чужой памяти — указатели/выход за массив"],
    [/Allowed memory size .* exhausted/i, "PHP съел всю память: утечка в цикле или подними memory_limit"],
    [/Maximum execution time/i, "PHP: скрипт работает слишком долго — set_time_limit или оптимизируй"],
    [/out of memory|OOMKilled|JavaScript heap out of memory/i, "закончилась память — утечка или большие данные; node: --max-old-space-size"],
    [/FLOOD_WAIT_?(\d+)/i, (m) => `Telegram: подожди ${m[1]} с (${fmtDur(+m[1])}) — слишком частые запросы`],
    [/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|AUTH_KEY_DUPLICATED/i, "Telegram: сессия умерла — нужно заново войти по номеру"],
    [/PHONE_NUMBER_BANNED|USER_DEACTIVATED/i, "Telegram: номер заблокирован"],
    [/PEER_FLOOD/i, "Telegram: спам-ограничение аккаунта — сбавь темп, напиши @SpamBot"],
    [/PHONE_CODE_(INVALID|EXPIRED)/i, "Telegram: код неверный или истёк — запроси новый"],
    [/SESSION_PASSWORD_NEEDED/i, "Telegram: включена 2FA — нужен облачный пароль"],
  ];
  function devFacts(t) {
    const s1 = t.trim();
    // cron
    const cr = s1.split(/\s+/);
    if (cr.length === 5 && cr.every((p) => /^(\*|\d+)([-,/]\d+|,\d+)*$|^\*\/\d+$/.test(p))) return { auto: true, text: "⏰ " + cronText(cr) };
    // ошибки
    for (const [re, ans] of ERRS) { const m = s1.match(re); if (m && s1.length < 1500) return { auto: false, long: true, text: "🔧 " + (typeof ans === "function" ? ans(m) : ans) }; }
    // регулярка
    if (/^\/.+\/[gimsuy]*$/.test(s1) || (/[\\^$|?*+()[\]{}]/.test(s1) && /\\[dws]|\[[^\]]+\]|\(\?|[+*?]\)|\^.*\$/.test(s1) && !/\s{2,}/.test(s1) && s1.length < 200)) return { auto: false, long: true, text: "регулярка:\n" + regexText(s1.replace(/^\/(.*)\/[gimsuy]*$/, "$1")) };
    // HTTP-код
    const hc = /^(?:HTTP\/[\d.]+\s+)?([1-5]\d\d)(?:\s+[A-Za-z ]+)?$/.exec(s1);
    if (hc && HTTP[hc[1]]) return { auto: true, text: `HTTP ${hc[1]}: ${HTTP[hc[1]]}` };
    // байты
    if (/^\d{4,}$/.test(s1) && +s1 >= 1024) {
      const b = +s1, u = ["Б", "КБ", "МБ", "ГБ", "ТБ"]; let i = 0, v = b; while (v >= 1024 && i < 4) { v /= 1024; i++; }
      return { auto: false, text: `${s1} байт = ${parseFloat(v.toFixed(2))} ${u[i]}` };
    }
    // px ↔ rem, мс
    const px = /^(\d+(?:\.\d+)?)px$/.exec(s1); if (px) return { auto: true, text: `${s1} = ${parseFloat((+px[1] / 16).toFixed(3))}rem` };
    const rem = /^(\d+(?:\.\d+)?)rem$/.exec(s1); if (rem) return { auto: true, text: `${s1} = ${+rem[1] * 16}px` };
    const ms = /^(\d+)\s?ms$/.exec(s1); if (ms) return { auto: true, text: `${s1} = ${+ms[1] / 1000} с` };
    return null;
  }
  function cronText([mi, h, dom, mo, dow]) {
    const D = ["вс", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
    const part = (v, unit, names) => v === "*" ? null : v.startsWith("*/") ? `каждые ${v.slice(2)} ${unit}` : v.replace(/\d+/g, (n) => (names ? names[+n] : n));
    let when;
    if (mi.startsWith("*/")) when = `каждые ${mi.slice(2)} мин`;
    else if (h === "*") when = mi === "*" ? "каждую минуту" : `каждый час в :${mi.padStart(2, "0")}`;
    else if (h.startsWith("*/")) when = `каждые ${h.slice(2)} ч в :${mi.padStart(2, "0")}`;
    else when = `в ${h.split(",").map((x) => (x.includes("-") ? x : x.padStart(2, "0") + ":" + mi.padStart(2, "0"))).join(", ")}`;
    const days = dow !== "*" ? `, ${part(dow, "дн", D)}` : "";
    const dates = dom !== "*" ? `, ${part(dom, "дн")} числа` : "";
    const months = mo !== "*" ? `, месяц ${part(mo, "мес")}` : "";
    return when + days + dates + months;
  }
  function regexText(r) {
    const T = [[/\^/, "^ — начало строки"], [/\$/, "$ — конец строки"], [/\\d/, "\\d — цифра"], [/\\w/, "\\w — буква/цифра/_"], [/\\s/, "\\s — пробел"], [/\\b/, "\\b — граница слова"],
      [/\.(?![*+?])/, ". — любой символ"], [/\.\*/, ".* — что угодно (жадно)"], [/\.\+\?|\*\?/, "*? / +? — лениво, как можно меньше"], [/\[[^\]]+\]/, "[…] — один из символов"], [/\[\^/, "[^…] — любой, кроме"],
      [/\{\d+(,\d*)?\}/, "{n,m} — от n до m раз"], [/\+/, "+ — один или больше"], [/\*(?!\?)/, "* — ноль или больше"], [/\?(?![:=!<])/, "? — необязательно"], [/\(\?:/, "(?:…) — группа без захвата"],
      [/\(\?<\w+>/, "(?<имя>…) — именованная группа"], [/\(\?=/, "(?=…) — дальше должно идти"], [/\(\?!/, "(?!…) — дальше НЕ должно идти"], [/\|/, "| — или"], [/\((?!\?)/, "(…) — группа с захватом"]];
    const out = T.filter(([re]) => re.test(r)).map(([, d]) => "· " + d);
    try { new RegExp(r); } catch (e) { out.unshift("⚠ ошибка: " + short(e.message, 60)); }
    return out.slice(0, 8).join("\n") || "простая строка без спецсимволов";
  }


  return { analyzeCode, codeComment, selectionFacts, looksLikeCode, keywords, langOfText, short };
})();
