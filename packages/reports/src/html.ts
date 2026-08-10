export interface PrototypeAction {
  label: string;
  target: string;
}

export interface PrototypeScreen {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  actions: PrototypeAction[];
}

export interface PrototypeDocument {
  title: string;
  summary: string;
  screens: PrototypeScreen[];
}

const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function validateDocument(document: PrototypeDocument): void {
  boundedText(document.title, "title", 160);
  boundedText(document.summary, "summary", 1_000);
  if (!Array.isArray(document.screens) || document.screens.length < 1 || document.screens.length > 24) {
    throw new TypeError("screens must contain between 1 and 24 entries");
  }
  const ids = new Set<string>();
  for (const screen of document.screens) {
    if (!SAFE_ID.test(screen.id)) throw new TypeError("screen id is invalid");
    if (ids.has(screen.id)) throw new TypeError("duplicate screen id");
    ids.add(screen.id);
    boundedText(screen.eyebrow, "screen eyebrow", 80);
    boundedText(screen.title, "screen title", 160);
    boundedText(screen.body, "screen body", 2_000);
    if (!Array.isArray(screen.actions) || screen.actions.length > 8) throw new TypeError("screen actions are invalid");
    for (const action of screen.actions) boundedText(action.label, "action label", 80);
  }
  for (const screen of document.screens) {
    for (const action of screen.actions) {
      if (!ids.has(action.target)) throw new TypeError("action target is missing");
    }
  }
}

function renderScreen(screen: PrototypeScreen, index: number): string {
  const actions = screen.actions.map((action) =>
    `<a class="action" href="#${escapeHtml(action.target)}">${escapeHtml(action.label)}<span aria-hidden="true">↗</span></a>`,
  ).join("");
  return `<section class="screen" id="${escapeHtml(screen.id)}" aria-labelledby="${escapeHtml(screen.id)}-title">
    <div class="screen-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</div>
    <div class="screen-copy">
      <p class="eyebrow">${escapeHtml(screen.eyebrow)}</p>
      <h2 id="${escapeHtml(screen.id)}-title">${escapeHtml(screen.title)}</h2>
      <p class="body">${escapeHtml(screen.body)}</p>
      <div class="actions">${actions}</div>
    </div>
  </section>`;
}

export function renderPrototypeHtml(document: PrototypeDocument): string {
  validateDocument(document);
  const navigation = document.screens.map((screen, index) =>
    `<a href="#${escapeHtml(screen.id)}"><span>${String(index + 1).padStart(2, "0")}</span>${escapeHtml(screen.title)}</a>`,
  ).join("");
  const screens = document.screens.map(renderScreen).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
  <title>${escapeHtml(document.title)}</title>
  <style>
    :root{color-scheme:light;--ink:#171710;--paper:#f2efe5;--signal:#e34b32;--line:#b8b29f;--muted:#686451}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Iowan Old Style","Palatino Linotype",Palatino,serif}
    body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.18;background-image:radial-gradient(#171710 0.45px,transparent .45px);background-size:5px 5px}
    a{color:inherit}.skip{position:fixed;left:1rem;top:-4rem;z-index:5;background:var(--ink);color:var(--paper);padding:.7rem 1rem}.skip:focus{top:1rem}
    header{min-height:70vh;padding:clamp(2rem,7vw,7rem);display:grid;align-content:end;border-bottom:1px solid var(--line)}
    .kicker,.eyebrow{font-family:"Avenir Next Condensed","Arial Narrow",sans-serif;text-transform:uppercase;letter-spacing:.18em;font-size:.72rem;font-weight:700}
    h1{font-size:clamp(3.4rem,11vw,10rem);font-weight:500;line-height:.82;letter-spacing:-.065em;max-width:10ch;margin:.3em 0}.lede{font-size:clamp(1.1rem,2vw,1.55rem);line-height:1.45;max-width:42rem;color:var(--muted)}
    nav{display:flex;gap:.7rem;overflow:auto;padding:1rem clamp(1rem,4vw,4rem);position:sticky;top:0;z-index:3;background:rgba(242,239,229,.94);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}
    nav a{white-space:nowrap;text-decoration:none;padding:.55rem .8rem;border:1px solid transparent}nav a:hover,nav a:focus-visible{border-color:var(--ink)}nav span{color:var(--signal);margin-right:.5rem;font-family:monospace}
    main{padding:0 clamp(1rem,4vw,4rem)}.screen{min-height:78vh;display:grid;grid-template-columns:minmax(5rem,18vw) 1fr;gap:clamp(1rem,5vw,6rem);align-items:center;border-bottom:1px solid var(--line);scroll-margin-top:4.5rem}
    .screen-index{font-size:clamp(5rem,18vw,17rem);line-height:.75;color:transparent;-webkit-text-stroke:1px var(--line);letter-spacing:-.09em}.screen-copy{max-width:56rem}.eyebrow{color:var(--signal)}h2{font-size:clamp(2.5rem,7vw,6rem);line-height:.93;letter-spacing:-.045em;margin:.2em 0}.body{font-size:clamp(1.1rem,2vw,1.5rem);line-height:1.55;max-width:42rem;color:var(--muted)}
    .actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:2rem}.action,button{display:inline-flex;gap:2rem;justify-content:space-between;align-items:center;border:1px solid var(--ink);padding:.85rem 1rem;background:transparent;text-decoration:none;font:700 .78rem/1 "Avenir Next Condensed","Arial Narrow",sans-serif;text-transform:uppercase;letter-spacing:.12em}.action:hover,.action:focus-visible,button:hover,button:focus-visible,button[aria-pressed="true"]{background:var(--ink);color:var(--paper)}
    aside{margin:5rem clamp(1rem,4vw,4rem);padding:clamp(1.5rem,4vw,4rem);border:1px solid var(--ink);display:grid;grid-template-columns:1fr auto;gap:2rem;align-items:center}aside h2{font-size:clamp(2rem,5vw,4rem)}.feedback-actions{display:flex;flex-wrap:wrap;gap:.6rem}output{display:block;margin-top:1rem;color:var(--signal);min-height:1.2em}
    footer{padding:2rem clamp(1rem,4vw,4rem);border-top:1px solid var(--line);font-family:monospace;font-size:.75rem}
    @media(max-width:700px){header{min-height:60vh}.screen{grid-template-columns:1fr;padding:5rem 0}.screen-index{font-size:5rem}aside{grid-template-columns:1fr}}
    @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
  </style>
</head>
<body>
  <a class="skip" href="#prototype">Skip to prototype</a>
  <header><p class="kicker">Disposable decision artifact · local only</p><h1>${escapeHtml(document.title)}</h1><p class="lede">${escapeHtml(document.summary)}</p></header>
  <nav aria-label="Prototype screens">${navigation}</nav>
  <main id="prototype">${screens}</main>
  <aside aria-label="Prototype feedback"><div><p class="kicker">Decision checkpoint</p><h2>What should happen next?</h2><output id="feedback-status" aria-live="polite"></output></div><div class="feedback-actions"><button type="button" data-feedback="Keep">Keep</button><button type="button" data-feedback="Change">Change</button><button type="button" data-feedback="Stop">Stop</button></div></aside>
  <footer>Prototype—not production code. No network requests or external assets.</footer>
  <script>document.querySelectorAll('[data-feedback]').forEach(function(button){button.addEventListener('click',function(){document.querySelectorAll('[data-feedback]').forEach(function(item){item.setAttribute('aria-pressed','false')});button.setAttribute('aria-pressed','true');document.getElementById('feedback-status').textContent='Recorded locally in this page: '+button.dataset.feedback;});});</script>
</body>
</html>`;
}
