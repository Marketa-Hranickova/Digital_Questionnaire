/* VFQ-25 iPad UI (Person A).
 *
 * Renders questionnaire.json one item per screen, applies enableWhen branching, and submits a
 * FHIR QuestionnaireResponse to the proxy server described in server/README.md.
 *
 * Privacy rules (TASKS.md): nothing is written to localStorage, sessionStorage, cookies or
 * IndexedDB. Session token, PIN and answers live only in the state object `S` and are wiped
 * when staff starts the next patient.
 */
(function () {
'use strict';

/* ---------- Configuration ---------- */
const params = new URLSearchParams(location.search);
const QUESTIONNAIRE_URL = params.get('questionnaire') || '../questionnaire.json';
const PSEUDONYM_SYSTEM = 'urn:4health:pseudonym';
const PID_RE = /^P[0-9]{4,6}$/;            // must match PID_PATTERN on the server
const SCALES = [1, 1.2, 1.4, 1.65];
const SCALE_LABELS = ['Normal', 'Groß', 'Größer', 'Am größten'];
const SCHEMES = [['light', 'Schwarz auf Weiß'], ['dark', 'Weiß auf Schwarz'], ['yellow', 'Gelb auf Schwarz']];
const RATES = [0.8, 1, 1.2];
const RATE_LABELS = ['Langsamer', 'Normal', 'Schneller'];

// Set this to the real server address when deploying (e.g. 'https://vfq.example.at').
// When set, ?api= and the address field are ignored, so a crafted link cannot send the
// PIN and answers to another server. Leave empty for local development.
const DEPLOYED_API = '';

function defaultApi() {
  if (DEPLOYED_API) return DEPLOYED_API;
  if (params.get('api')) return params.get('api');
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return 'http://localhost:8080';
  return '';
}

/* ---------- State (memory only) ---------- */
function fresh(keep) {
  return {
    screen: 'staff', api: keep ? keep.api : defaultApi(), demo: keep ? keep.demo : false,
    pid: '', includeAppendix: false, skipQ1: false, token: null, pin: null,
    mode: null, scale: 0, scheme: null, rate: 1,
    cur: null, answers: {}, armed: null, howCount: 0,
    settings: false, nurse: false, fromReview: false,
    error: null, busy: false, health: '', stored: 0, sent: null, pdfUrl: null,
    focusHeading: true
  };
}
let S = fresh(null);
S.screen = 'loading';

let Q = null;          // the FHIR Questionnaire
let CHOICES = [];      // every choice item with its group: [{item, group}]

/* ---------- Helpers ---------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (d, w) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w || 2.2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  back: svg('<path d="M19 12H5M12 19l-7-7 7-7"/>', 2.6),
  next: svg('<path d="M5 12h14M12 5l7 7-7 7"/>', 2.6),
  check: svg('<path d="M20 6L9 17l-5-5"/>', 3.2),
  help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
  sliders: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  speaker: svg('<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>'),
  phones: svg('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>')
};

/** Question text with the paper form's underlining. Only <u> and <br> survive; everything else is escaped. */
function richText(it) {
  const ext = ((it._text && it._text.extension) || []).find((e) => /rendering-xhtml$/.test(e.url));
  if (!ext) return esc(it.text).replace(/\n/g, '<br>');
  const inner = ext.valueString.replace(/^\s*<div[^>]*>/, '').replace(/<\/div>\s*$/, '');
  return esc(inner)
    .replace(/&lt;u&gt;/g, '<u>').replace(/&lt;\/u&gt;/g, '</u>')
    .replace(/&lt;br\s*\/?&gt;/g, '<br>');
}
const optLabel = (it, code) => {
  const o = (it.answerOption || []).find((o) => o.valueCoding.code === code);
  return o ? o.valueCoding.display : null;
};
const qNumber = (it) => (it.prefix || '').replace(/\.$/, '');

/* ---------- Branching ---------- */
function indexChoices(items, group) {
  for (const it of items || []) {
    if (it.type === 'group') indexChoices(it.item, it);
    else if (it.type === 'choice') CHOICES.push({ item: it, group });
  }
}
function excluded(it, group) {
  return (group && group.linkId === 'appendix' && !S.includeAppendix) || (it.linkId === 'q01' && S.skipQ1);
}
function enabled(it) {
  const conds = it.enableWhen || [];
  if (!conds.length) return true;
  const results = conds.map((c) => {
    const given = S.answers[c.question];
    const want = c.answerCoding && c.answerCoding.code;
    return c.operator === '!=' ? given !== want : given === want;
  });
  return (it.enableBehavior || 'all') === 'all' ? results.every(Boolean) : results.some(Boolean);
}
/** Remove answers of items that are no longer shown (repeat until stable: 15b depends on 15a). */
function prune() {
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of CHOICES) {
      const id = c.item.linkId;
      if (S.answers[id] !== undefined && (excluded(c.item, c.group) || !enabled(c.item))) {
        delete S.answers[id]; changed = true;
      }
    }
  }
}
/** The screens the patient walks through: display texts and enabled choice items, in order. */
function flow() {
  const out = [];
  (function walk(items, group) {
    for (const it of items || []) {
      if (it.type === 'group') {
        if (it.linkId === 'appendix' && !S.includeAppendix) continue;
        walk(it.item, it);
      } else if (it.type === 'display') {
        if (it.linkId !== 'outro') out.push({ kind: 'display', item: it, group });
      } else if (it.type === 'choice') {
        if (!excluded(it, group) && enabled(it)) out.push({ kind: 'choice', item: it, group });
      }
    }
  })(Q.item, null);
  return out;
}
function position() {
  const f = flow();
  let i = f.findIndex((s) => s.item.linkId === S.cur);
  if (i < 0) i = 0;
  return { f, i, step: f[i] };
}
const outro = () => (Q.item || []).find((it) => it.linkId === 'outro');

/* ---------- FHIR output ---------- */
function buildResponse() {
  function walk(items) {
    const out = [];
    for (const it of items || []) {
      if (it.type === 'group') {
        const children = walk(it.item);
        if (children.length) out.push({ linkId: it.linkId, text: it.text, item: children });
      } else if (it.type === 'choice' && S.answers[it.linkId] !== undefined) {
        const code = S.answers[it.linkId];
        out.push({ linkId: it.linkId, answer: [{ valueCoding: { code, display: optLabel(it, code) } }] });
      }
    }
    return out;
  }
  return {
    resourceType: 'QuestionnaireResponse',
    questionnaire: Q.version ? `${Q.url}|${Q.version}` : Q.url,
    status: 'completed',
    subject: { identifier: { system: PSEUDONYM_SYSTEM, value: S.pid } },
    authored: new Date().toISOString(),
    item: walk(Q.item)
  };
}
const missingItems = () => flow().filter((s) => s.kind === 'choice' && S.answers[s.item.linkId] === undefined);

/* ---------- Server ---------- */
async function api(path, opts) {
  const base = (S.api || '').replace(/\/+$/, '');
  try {
    const r = await fetch(base + path, Object.assign({ cache: 'no-store', credentials: 'omit' }, opts));
    let body = null;
    const type = r.headers.get('content-type') || '';
    if (type.includes('json')) { try { body = await r.json(); } catch (e) { body = null; } }
    else if (type.includes('pdf')) body = await r.blob();
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: null };
  }
}
function errText(r) {
  const detail = r.body && r.body.detail ? String(r.body.detail) : '';
  switch (r.status) {
    case 0: return 'Server nicht erreichbar. Adresse prüfen, Server starten oder Demo ohne Server wählen.';
    case 401: return 'PIN falsch.';
    case 413: return 'Anfrage zu groß.';
    case 422: return 'Vom Server abgelehnt: ' + detail;
    case 429: return 'Zu viele falsche PINs. Bitte 5 Minuten warten.';
    case 502: return 'Speichern in REDCap fehlgeschlagen. Bitte erneut senden.';
    default: return `Fehler ${r.status}${detail ? ': ' + detail : ''}`;
  }
}
const sessionBody = () => JSON.stringify({ pid: S.pid, include_appendix: S.includeAppendix, skip_q1: S.skipQ1 });

/* ---------- Speech ---------- */
const canSpeak = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
let voices = [];
function loadVoices() { try { voices = window.speechSynthesis.getVoices() || []; } catch (e) { voices = []; } }
if (canSpeak) { loadVoices(); try { window.speechSynthesis.onvoiceschanged = loadVoices; } catch (e) {} }
function germanVoice() {
  return voices.find((v) => /^de[-_]AT/i.test(v.lang)) || voices.find((v) => /^de[-_]DE/i.test(v.lang)) ||
    voices.find((v) => /^de/i.test(v.lang)) || null;
}
function stopSpeech() { if (canSpeak) { try { window.speechSynthesis.cancel(); } catch (e) {} } }
/** Speaks sentence by sentence: some browsers cut off long single utterances. */
function speak(text) {
  if (!canSpeak || !text) return;
  try {
    stopSpeech();
    const voice = germanVoice();
    const parts = String(text).match(/[^.!?]+[.!?]*/g) || [text];
    for (const p of parts) {
      const t = p.trim(); if (!t) continue;
      const u = new SpeechSynthesisUtterance(t);
      u.lang = voice ? voice.lang : 'de-AT';
      if (voice) u.voice = voice;
      u.rate = S.rate;
      window.speechSynthesis.speak(u);
    }
  } catch (e) {}
}
const tts = () => S.mode === 'audio' && canSpeak;
const MODE_SPEECH = 'Willkommen. Bitte setzen Sie die Kopfhörer auf. Wie möchten Sie den Fragebogen beantworten? ' +
  'Oberer Knopf: Ich lese Ihnen die Fragen vor. Mittlerer Knopf: Sie nutzen Ihren eigenen Screenreader. ' +
  'Unterer Knopf: Sie lesen die Fragen selbst. Tippen Sie einmal, um eine Auswahl zu hören. Tippen Sie noch einmal, um sie zu wählen.';
const TAP_AGAIN = 'Noch einmal tippen zum Auswählen';

function stepSpeech(step, o) {
  o = o || {};
  const it = step.item;
  let s = o.prefix || '';
  if (o.part && step.group) s += step.group.text + '. ';
  if (step.kind === 'display') {
    s += it.text + ' ';
    if (S.mode === 'audio') s += 'Tippen Sie zweimal auf den großen Knopf Weiter, um fortzufahren.';
    return s;
  }
  s += `Frage ${qNumber(it)}. ${it.text} `;
  (it.answerOption || []).forEach((opt, k) => { s += `Antwort ${k + 1}: ${opt.valueCoding.display}. `; });
  if (o.withAnswer && S.answers[it.linkId] !== undefined) s += `Ihre bisherige Antwort: ${optLabel(it, S.answers[it.linkId])}. `;
  if (o.how) s += 'Tippen Sie auf eine Antwort, um sie zu hören. Tippen Sie noch einmal, um sie zu wählen.';
  return s;
}
function sayStep(step, o) {
  if (!tts()) return;
  o = o || {};
  if (step.kind === 'choice' && S.howCount < 2) { o.how = true; S.howCount += 1; }
  speak(stepSpeech(step, o));
}

/* ---------- Theme ---------- */
function applyTheme() {
  const r = document.documentElement;
  r.style.setProperty('--scale', SCALES[S.scale]);
  if (S.scheme) r.setAttribute('data-scheme', S.scheme); else r.removeAttribute('data-scheme');
}

/* ---------- View pieces ---------- */
function patientHeader(progress, withBack, noSettings) {
  return `<header class="bar">
    ${withBack ? `<button class="btn" data-act="back" data-key="back">${I.back}<span>Zurück</span></button>` : '<span></span>'}
    <div class="bar-actions">
      ${noSettings ? '' : `<button class="btn" data-act="settings" data-key="settings" aria-expanded="${S.settings}">${I.sliders}<span>Einstellungen</span></button>`}
      <button class="btn btn-help" data-act="nurse" data-key="nurse" aria-pressed="${S.nurse}">${I.help}<span>${S.nurse ? 'Ruf abbrechen' : 'Pflege rufen'}</span></button>
    </div>
  </header>${progress || ''}
  ${S.nurse ? '<div class="banner" role="alert">Eine Pflegekraft kommt. Bitte bleiben Sie, wo Sie sind.</div>' : ''}
  ${S.mode === 'audio' && !canSpeak ? '<div class="error" role="alert">Dieses Tablet kann gerade nicht vorlesen. Bitte tippen Sie auf Pflege rufen.</div>' : ''}
  ${S.settings ? settingsPanel() : ''}`;
}
function seg(act, items, current) {
  return `<div class="seg">${items.map(([v, label]) =>
    `<button class="btn" data-act="${act}" data-v="${esc(v)}" data-key="${act}-${esc(v)}" aria-pressed="${String(v) === String(current)}">${esc(label)}</button>`).join('')}</div>`;
}
function sizeRow() {
  return `<div class="setrow">
    <div class="setlabel"><span class="sl-title">Schriftgröße</span><span class="sl-sub">${SCALE_LABELS[S.scale]} (${S.scale + 1} von ${SCALES.length})</span></div>
    <div class="seg">
      <button class="btn sq" data-act="size" data-v="-1" data-key="size-" aria-label="Kleinere Schrift" ${S.scale === 0 ? 'disabled' : ''}>A−</button>
      <button class="btn sq btn-accent" data-act="size" data-v="1" data-key="size+" aria-label="Größere Schrift" ${S.scale === SCALES.length - 1 ? 'disabled' : ''}>A+</button>
    </div></div>`;
}
function schemeRow() {
  return `<div class="setrow"><div class="setlabel"><span class="sl-title">Farben</span><span class="sl-sub">Gelb auf Schwarz hilft bei Blendung</span></div>
    ${seg('scheme', SCHEMES, S.scheme)}</div>`;
}
function settingsPanel() {
  return `<section class="panel" aria-labelledby="set-h">
    <h2 id="set-h">Einstellungen</h2>
    ${sizeRow()}
    ${schemeRow()}
    <div class="setrow"><div class="setlabel"><span class="sl-title">Wie die Fragen gelesen werden</span></div>
      ${seg('setmode', [['audio', 'Vorlesen'], ['sr', 'Mein Screenreader'], ['visual', 'Selbst lesen']], S.mode)}</div>
    <div class="setrow"><div class="setlabel"><span class="sl-title">Lesetempo</span></div>
      ${seg('speed', RATE_LABELS.map((l, i) => [i, l]), RATES.indexOf(S.rate))}</div>
    <p class="small">Mit Tastatur: Ziffern 1 bis 6 wählen eine Antwort, R liest die Frage noch einmal vor.</p>
    <button class="btn btn-accent" data-act="settings" data-key="close-settings">Einstellungen schließen</button>
  </section>`;
}

/* ---------- Views ---------- */
const V = {};

V.loading = () => '<main class="screen center"><p class="lede">Fragebogen wird geladen …</p></main>';

V.loadError = () => `<main class="screen">
  <h1>Fragebogen konnte nicht geladen werden</h1>
  <div class="error" role="alert">${esc(S.error)}</div>
  <p class="lede">Die Seite muss über einen Webserver geöffnet werden, nicht als Datei. Anleitung: frontend/README.md.</p>
</main>`;

V.staff = () => `<main class="screen">
  <div class="stack"><span class="qnum">Für das Personal</span><h1>Neue Befragung starten</h1>
    <p class="lede">${esc(Q.title)}</p></div>
  ${S.error ? `<div class="error" role="alert">${esc(S.error)}</div>` : ''}
  <form id="staff-form" class="form" autocomplete="off" novalidate>
    <div class="field"><label for="pid">Patientencode</label>
      <input type="text" id="pid" name="pid" value="${esc(S.pid)}" placeholder="P0012" autocapitalize="characters" autocomplete="off" spellcheck="false" aria-describedby="pid-hint">
      <span class="small" id="pid-hint">P und 4 bis 6 Ziffern. Bitte keine Namen eingeben.</span></div>
    <label class="check"><input type="checkbox" id="appendix" name="appendix" ${S.includeAppendix ? 'checked' : ''}> Anhang A3 bis A8 einbeziehen</label>
    <label class="check"><input type="checkbox" id="skipq1" name="skipq1" ${S.skipQ1 ? 'checked' : ''}> Frage 1 überspringen (bei gleichzeitigem SF-36)</label>
    <label class="check"><input type="checkbox" id="demo" name="demo" ${S.demo ? 'checked' : ''}> Demo ohne Server (nichts wird gespeichert)</label>
    ${DEPLOYED_API ? `<p class="small" id="api-hint" role="status">${esc(S.health || '')}</p>` : `<div class="field"><label for="api">Server-Adresse</label>
      <input type="url" id="api" name="api" value="${esc(S.api)}" placeholder="https://…" autocomplete="off" spellcheck="false" aria-describedby="api-hint">
      <span class="small" id="api-hint" role="status">${esc(S.health || 'Im Demo-Modus nicht nötig.')}</span></div>`}
    <button type="button" class="btn btn-ghost" data-act="health" data-key="health">Verbindung prüfen</button>
    <div class="field"><label for="pin">Personal-PIN</label>
      <input type="password" id="pin" name="pin" inputmode="numeric" autocomplete="off" aria-describedby="pin-hint">
      <span class="small" id="pin-hint">Im Demo-Modus nicht nötig.</span></div>
    <button type="submit" class="btn btn-primary" data-key="start-session" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Bitte warten …' : 'Starten und Tablet übergeben'}</button>
  </form>
  <p class="small">Auf diesem Tablet wird nichts gespeichert. Nach dem Senden werden alle Antworten aus dem Speicher gelöscht.</p>
</main>`;

V.handover = () => `<main class="screen">
  <button class="zone zone-start" data-act="handover" data-key="handover" aria-label="Willkommen. Tippen Sie, um zu beginnen.">
    <span class="z-big">Willkommen</span>
    <span class="z-mid">Tippen Sie irgendwo, um zu beginnen</span>
    <span class="z-sub" style="display:flex;gap:10px;align-items:center">${I.phones.replace('<svg', '<svg width="32" height="32"')}Die Kopfhörer hängen am Tablet</span>
  </button>
  <button class="linkbtn" data-act="cancel" data-key="cancel">Personal: Befragung abbrechen</button>
</main>`;

V.mode = () => {
  const modes = {
    audio: ['Lesen Sie mir die Fragen vor', 'Über die Kopfhörer. Wenn Lesen schwerfällt.', 'zone-a'],
    sr: ['Ich nutze meinen eigenen Screenreader', 'VoiceOver ist bereits eingeschaltet', 'zone-b'],
    visual: ['Ich lese die Fragen selbst', 'Danach können Sie Schrift und Farben anpassen', 'zone-c']
  };
  return `<main class="screen"><h1>Wie möchten Sie den Fragebogen beantworten?</h1>
  ${Object.keys(modes).map((m) => `<button class="zone ${modes[m][2]} ${S.armed === 'mode-' + m ? 'armed' : ''}" data-act="mode" data-v="${m}" data-key="mode-${m}">
    <span class="z-title">${modes[m][0]}</span><span class="z-sub">${modes[m][1]}</span>
    ${S.armed === 'mode-' + m ? `<span class="armtag">${TAP_AGAIN}</span>` : ''}</button>`).join('')}
  </main>`;
};

V.display = () => `<main class="screen">
  ${patientHeader('', true, true)}
  <div class="stack"><h1>So lesen Sie am besten</h1><p class="lede">Wählen Sie, was Ihnen hilft. Sie können es später unter Einstellungen ändern.</p></div>
  ${sizeRow()}
  ${schemeRow()}
  <div class="preview" aria-hidden="true"><span class="pv-label">Vorschau</span>
    <span class="pv-q">Wie oft machen Sie sich <u>Sorgen</u> um Ihr Sehvermögen?</span>
    <div class="pv-opts"><span class="pv-opt">Nie</span><span class="pv-opt">Manchmal</span></div></div>
  <div class="footer"><button class="btn btn-primary" data-act="begin" data-key="begin">Fragebogen beginnen${I.next}</button></div>
</main>`;

V.item = () => {
  const { f, i, step } = position();
  const it = step.item;
  const audio = S.mode === 'audio';
  const choices = f.filter((s) => s.kind === 'choice');
  const progress = step.kind === 'choice'
    ? (() => {
      const n = choices.length; const p = choices.findIndex((s) => s.item.linkId === it.linkId) + 1;
      return `<div class="prog"><span class="prog-text">Frage ${p} von ${n}</span>
        <div class="track" aria-hidden="true"><div class="fill" style="width:${Math.round((p / n) * 100)}%"></div></div>
        ${step.group ? `<span class="prog-part">${esc(step.group.text)}</span>` : ''}</div>`;
    })()
    : `<div class="prog">${step.group ? `<span class="prog-part">${esc(step.group.text)}</span>` : '<span class="prog-part">Einleitung</span>'}</div>`;

  if (step.kind === 'display') {
    const title = step.group ? step.group.text : 'Bevor es losgeht';
    const nextArmed = S.armed === 'next';
    return `<main class="screen">${patientHeader(progress, true)}
      <h1 id="qh">${esc(title)}</h1>
      <p class="body-text">${richText(it)}</p>
      ${S.mode !== 'sr' ? `<button class="btn btn-ghost" data-act="repeat" data-key="repeat">${I.speaker}<span>${audio ? 'Noch einmal vorlesen' : 'Vorlesen'}</span></button>` : ''}
      <div class="footer"><button class="btn btn-primary ${audio ? 'btn-huge' : ''} ${nextArmed ? 'armed' : ''}" data-act="next" data-key="next">${nextArmed ? TAP_AGAIN : 'Weiter'}${I.next}</button></div>
    </main>`;
  }

  const ans = S.answers[it.linkId];
  const lastChoice = !f.slice(i + 1).some((s) => s.kind === 'choice');
  const nextLabel = S.fromReview ? 'Zurück zur Übersicht' : (lastChoice ? 'Fertig' : 'Weiter');
  return `<main class="screen">${patientHeader(progress, true)}
    <div class="stack">
      <span class="qnum">Frage ${esc(qNumber(it))}</span>
      <h1 id="qh">${richText(it)}</h1>
      ${S.mode !== 'sr' ? `<button class="btn btn-ghost" data-act="repeat" data-key="repeat">${I.speaker}<span>${audio ? 'Frage wiederholen' : 'Vorlesen'}</span></button>` : ''}
    </div>
    <div class="opts" role="radiogroup" aria-labelledby="qh">
      ${(it.answerOption || []).map((o, k) => {
        const code = o.valueCoding.code; const sel = ans === code; const armed = S.armed === 'opt-' + code;
        return `<button class="opt ${armed ? 'armed' : ''}" role="radio" aria-checked="${sel}" data-act="pick" data-v="${esc(code)}" data-key="opt-${esc(code)}">
          <span class="dot" aria-hidden="true">${sel ? I.check : ''}</span>
          <span class="lbl">${esc(o.valueCoding.display)}</span>
          ${armed ? `<span class="tag">${TAP_AGAIN}</span>` : sel ? '<span class="tag">Ausgewählt</span>' : `<span class="num" aria-hidden="true">${k + 1}</span>`}
        </button>`;
      }).join('')}
    </div>
    ${audio ? '' : `<div class="footer"><button class="btn btn-primary" data-act="next" data-key="next" ${ans === undefined ? 'disabled aria-disabled="true"' : ''}>${nextLabel}${I.next}</button>
      ${ans === undefined ? '<p class="small" style="text-align:center">Bitte wählen Sie eine Antwort.</p>' : ''}</div>`}
  </main>`;
};

V.finished = () => {
  const o = outro();
  return `<main class="screen center">
    <div class="done-mark" aria-hidden="true">${I.check}</div>
    <h1>Vielen Dank</h1>
    <p class="body-text">${o ? richText(o) : ''}</p>
    <p class="lede"><strong>Bitte geben Sie das Tablet dem Personal zurück.</strong></p>
    <button class="btn" data-act="back" data-key="back">${I.back}<span>Zurück zur letzten Frage</span></button>
    <div class="footer" style="width:100%"><button class="btn btn-accent" data-act="to-staff" data-key="to-staff">Für das Personal: prüfen und senden</button></div>
  </main>`;
};

V.staffPin = () => `<main class="screen">
  <div class="stack"><span class="qnum">Für das Personal</span><h1>Antworten prüfen</h1>
    <p class="lede">Patientencode ${esc(S.pid)}. Bitte PIN eingeben.</p></div>
  ${S.error ? `<div class="error" role="alert">${esc(S.error)}</div>` : ''}
  <form id="pin-form" class="form" autocomplete="off" novalidate>
    <div class="field"><label for="pin2">Personal-PIN</label>
      <input type="password" id="pin2" name="pin" inputmode="numeric" autocomplete="off"></div>
    <button type="submit" class="btn btn-primary" data-key="pin-submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Bitte warten …' : 'Zur Übersicht'}</button>
  </form>
  <button class="btn" data-act="back-finished" data-key="back-finished">${I.back}<span>Zurück</span></button>
</main>`;

V.review = () => {
  const f = flow().filter((s) => s.kind === 'choice');
  const missing = f.filter((s) => S.answers[s.item.linkId] === undefined).length;
  return `<main class="screen">
  <div class="stack"><span class="qnum">Für das Personal${S.demo ? ' · Demo' : ''}</span><h1>Übersicht der Antworten</h1>
    <p class="lede">Patientencode ${esc(S.pid)} · ${f.length} Fragen</p></div>
  ${S.error ? `<div class="error" role="alert">${esc(S.error)}</div>` : ''}
  <div class="summary" role="status">${missing === 0 ? 'Alle Fragen sind beantwortet.' : `${missing} ${missing === 1 ? 'Frage fehlt' : 'Fragen fehlen'}. Bitte mit der Patientin oder dem Patienten ergänzen.`}</div>
  <ul class="rows">${f.map((s) => {
    const a = S.answers[s.item.linkId];
    return `<li class="row"><div class="rtext"><span class="rq">${esc(qNumber(s.item))} · ${esc(s.item.text)}</span>
      <span class="ra ${a === undefined ? 'missing' : ''}">${a === undefined ? 'Fehlt' : esc(optLabel(s.item, a))}</span></div>
      <button class="btn btn-ghost" style="align-self:center" data-act="change" data-v="${esc(s.item.linkId)}" data-key="change-${esc(s.item.linkId)}" aria-label="${esc('Ändern: Frage ' + qNumber(s.item))}">Ändern</button></li>`;
  }).join('')}</ul>
  <div class="footer">
    <button class="btn btn-primary" data-act="send" data-key="send" ${missing || S.busy ? 'disabled' : ''}>${I.check}${S.busy ? 'Wird gesendet …' : (S.demo ? 'Abschließen (Demo, nichts wird gesendet)' : 'An REDCap senden')}</button>
  </div>
</main>`;
};

V.sent = () => `<main class="screen center">
  <div class="done-mark" aria-hidden="true">${I.check}</div>
  <h1>${S.demo ? 'Demo abgeschlossen' : 'Gespeichert'}</h1>
  <p class="lede">${S.demo ? 'Im Demo-Modus wurde nichts gesendet.' : `Die Antworten für ${esc(S.pid)} sind gespeichert (${S.stored} Antworten).`} Die Antworten wurden aus dem Speicher des Tablets gelöscht.</p>
  ${S.error ? `<div class="error" role="alert">${esc(S.error)}</div>` : ''}
  ${!S.demo ? (S.pdfUrl
    ? `<a class="btn btn-ghost" style="align-self:center" href="${S.pdfUrl}" target="_blank" rel="noopener" download="vfq25_${esc(S.pid)}.pdf">PDF öffnen</a>`
    : `<button class="btn btn-ghost" style="align-self:center" data-act="pdf" data-key="pdf" ${S.busy ? 'disabled' : ''}>PDF für die Krankenakte laden</button>`) : ''}
  ${S.demo && S.sent ? `<details><summary>Für das Team: FHIR QuestionnaireResponse, die der Server erhalten würde</summary><pre>${esc(S.sent)}</pre></details>` : ''}
  <div class="footer" style="width:100%"><button class="btn btn-primary" data-act="restart" data-key="restart">Nächste Person starten</button></div>
</main>`;

/* ---------- Render ---------- */
const $app = document.getElementById('app');
function render() {
  const ae = document.activeElement;
  const key = ae && ae.dataset ? ae.dataset.key : null;
  $app.innerHTML = V[S.screen]();
  if (S.focusHeading) {
    S.focusHeading = false;
    window.scrollTo(0, 0);
    const h = $app.querySelector('h1');
    if (h) { h.setAttribute('tabindex', '-1'); try { h.focus({ preventScroll: true }); } catch (e) {} }
  } else if (key) {
    const el = $app.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (el && !el.disabled) { try { el.focus({ preventScroll: true }); } catch (e) {} }
  }
}
function go(screen) { S.screen = screen; S.armed = null; S.error = null; S.focusHeading = true; render(); }

/* ---------- Patient navigation ---------- */
function showStep(step, sayOpts) {
  S.cur = step.item.linkId; S.armed = null; go('item'); sayStep(step, sayOpts);
}
function begin() {
  const f = flow();
  showStep(f[0], { part: true });
}
function toFinished(prefix) {
  go('finished');
  if (tts()) {
    const o = outro();
    speak((prefix || '') + (o ? o.text + ' ' : '') + 'Bitte nehmen Sie die Kopfhörer ab und geben Sie das Tablet dem Personal zurück.');
  }
}
function toReview() { stopSpeech(); go(S.demo || S.pin ? 'review' : 'staffPin'); }
function advance(prefix) {
  const { f, i, step } = position();
  const nxt = f[i + 1];
  if (S.fromReview) {
    const followUpOpen = nxt && nxt.kind === 'choice' && S.answers[nxt.item.linkId] === undefined;
    if (!followUpOpen) { S.fromReview = false; toReview(); return; }
  }
  if (!nxt) { toFinished(prefix); return; }
  showStep(nxt, { prefix, part: nxt.group !== step.group });
}
function back() {
  if (S.screen === 'display') { go('mode'); speak(MODE_SPEECH); return; }
  if (S.screen === 'finished') { const f = flow(); showStep(f[f.length - 1], { withAnswer: true }); return; }
  const { f, i } = position();
  if (i > 0) { showStep(f[i - 1], { withAnswer: true }); return; }
  if (S.mode === 'visual') go('display'); else { go('mode'); speak(MODE_SPEECH); }
}
function pick(code, direct) {
  const { step } = position();
  if (!step || step.kind !== 'choice') return;
  const label = optLabel(step.item, code);
  if (label == null) return;
  if (S.mode === 'audio' && !direct && S.armed !== 'opt-' + code) {
    S.armed = 'opt-' + code; render(); speak(label + '. ' + TAP_AGAIN + '.'); return;
  }
  S.armed = null;
  S.answers[step.item.linkId] = code;
  prune();
  if (S.mode === 'audio') advance(`Ihre Wahl: ${label}. `);
  else render();
}
function chooseMode(m) {
  S.mode = m;
  if (m === 'visual') { stopSpeech(); go('display'); return; }
  if (m === 'sr') stopSpeech();
  begin();
}

/* ---------- Staff actions ---------- */
async function startSession(form) {
  S.pid = form.pid.value.trim().toUpperCase();
  S.includeAppendix = form.appendix.checked;
  S.skipQ1 = form.skipq1.checked;
  S.demo = form.demo.checked;
  if (!DEPLOYED_API) S.api = form.api.value.trim();
  const pin = form.pin.value;
  if (S.demo && !S.pid) S.pid = 'P0000';
  if (!PID_RE.test(S.pid)) { S.error = 'Patientencode bitte im Format P0012 (P und 4 bis 6 Ziffern), keine Namen.'; render(); return; }
  S.answers = {}; S.howCount = 0;
  if (S.demo) { S.token = null; go('handover'); return; }
  if (!S.api) { S.error = 'Bitte Server-Adresse eingeben oder Demo ohne Server wählen.'; render(); return; }
  S.busy = true; S.error = null; render();
  const r = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Staff-Pin': pin }, body: sessionBody() });
  S.busy = false;
  if (r.status === 201 && r.body && r.body.token) { S.token = r.body.token; go('handover'); return; }
  S.error = errText(r); render();
}
async function checkPin(form) {
  const pin = form.pin.value;
  if (S.demo) { go('review'); return; }
  S.busy = true; S.error = null; render();
  const r = await api('/api/staff/check', { method: 'POST', headers: { 'X-Staff-Pin': pin } });
  S.busy = false;
  if (r.status === 204) { S.pin = pin; go('review'); return; }
  S.error = errText(r); render();
}
async function send() {
  if (missingItems().length) return;
  const body = buildResponse();
  if (S.demo) { S.sent = JSON.stringify(body, null, 2); S.answers = {}; go('sent'); return; }
  S.busy = true; S.error = null; render();
  const post = () => api('/api/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token }, body: JSON.stringify(body) });
  let r = await post();
  if (r.status === 401 && S.pin) {
    // Session expired (2 h) or server restarted: open a new one for the same code and retry once
    const s = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Staff-Pin': S.pin }, body: sessionBody() });
    if (s.status === 201 && s.body && s.body.token) { S.token = s.body.token; r = await post(); }
  }
  S.busy = false;
  if (r.status === 401) {
    // Session could not be renewed (e.g. server restarted with another PIN): ask again
    S.pin = null; go('staffPin');
    S.error = 'Sitzung abgelaufen. Bitte PIN erneut eingeben und dann noch einmal senden.'; render();
    return;
  }
  if (r.status === 201) {
    S.stored = r.body && r.body.answers ? r.body.answers : 0;
    S.token = null; S.answers = {};
    go('sent'); return;
  }
  S.error = errText(r); render();
}
async function loadPdf() {
  S.busy = true; S.error = null; render();
  const r = await api(`/api/records/${encodeURIComponent(S.pid)}/pdf`, { headers: { 'X-Staff-Pin': S.pin || '' } });
  S.busy = false;
  if (r.status === 200 && r.body instanceof Blob) { S.pdfUrl = URL.createObjectURL(r.body); render(); return; }
  S.error = r.status === 404 ? 'Noch kein PDF für diesen Code vorhanden.' : errText(r); render();
}
function restart() {
  stopSpeech();
  if (S.pdfUrl) { try { URL.revokeObjectURL(S.pdfUrl); } catch (e) {} }
  S = fresh(S);
  applyTheme();
  render();
}
async function checkHealth() {
  const input = document.getElementById('api');
  if (input && !DEPLOYED_API) S.api = input.value.trim();
  S.health = 'Prüfe …'; render();
  const r = await api('/api/health', {});
  S.health = r.status === 200 && r.body ? `Verbunden (Modus: ${r.body.mode}).` : 'Keine Verbindung. ' + errText(r);
  render();
}

/* ---------- Events ---------- */
document.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'staff-form') startSession(e.target);
  else if (e.target.id === 'pin-form') checkPin(e.target);
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'pid') S.pid = t.value;
  else if (t.id === 'api' && !DEPLOYED_API) S.api = t.value;
  else if (t.id === 'appendix') S.includeAppendix = t.checked;
  else if (t.id === 'skipq1') S.skipQ1 = t.checked;
  else if (t.id === 'demo') S.demo = t.checked;
});
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act; const v = el.dataset.v;
  switch (act) {
    case 'health': checkHealth(); break;
    case 'handover': go('mode'); speak(MODE_SPEECH); break;
    case 'cancel': restart(); break;
    case 'mode': {
      const key = 'mode-' + v;
      if (S.armed === key) { S.armed = null; chooseMode(v); }
      else {
        S.armed = key; render();
        const say = { audio: 'Lesen Sie mir die Fragen vor', sr: 'Ich nutze meinen eigenen Screenreader', visual: 'Ich lese die Fragen selbst' }[v];
        speak(say + '. ' + TAP_AGAIN + '.');
      }
      break; }
    case 'begin': begin(); break;
    case 'pick': pick(v, false); break;
    case 'next': {
      const { step } = position();
      if (step.kind === 'choice' && S.answers[step.item.linkId] === undefined) break;
      if (S.mode === 'audio' && step.kind === 'display' && S.armed !== 'next') {
        S.armed = 'next'; render(); speak('Weiter. ' + TAP_AGAIN + '.'); break;
      }
      S.armed = null; advance('');
      break; }
    case 'back': back(); break;
    case 'repeat': { const { step } = position(); speak(stepSpeech(step, { withAnswer: true, how: S.mode === 'audio' && step.kind === 'choice' })); break; }
    case 'settings': {
      S.settings = !S.settings; S.armed = null; render();
      if (S.settings) { const b = $app.querySelector('.panel button'); if (b) b.focus(); }
      else if (S.screen === 'item' && tts()) { const { step } = position(); speak(stepSpeech(step, { withAnswer: true })); }
      break; }
    case 'nurse':
      S.nurse = !S.nurse; render();
      if (S.nurse && (tts() || S.mode === null)) speak('Eine Pflegekraft kommt. Bitte bleiben Sie, wo Sie sind.');
      break;
    case 'size': S.scale = Math.max(0, Math.min(SCALES.length - 1, S.scale + Number(v))); applyTheme(); render(); break;
    case 'scheme': S.scheme = v; applyTheme(); render(); break;
    case 'setmode':
      S.mode = v; S.armed = null; render();
      if (v !== 'audio') stopSpeech();
      break;
    case 'speed': S.rate = RATES[Number(v)]; render(); if (S.mode !== 'sr') speak(RATE_LABELS[Number(v)]); break;
    case 'to-staff': toReview(); break;
    case 'back-finished': go('finished'); break;
    case 'change': {
      // The iPad goes back to the patient: forget the PIN so the review asks for it again
      S.pin = null; S.fromReview = true; S.error = null;
      const step = flow().find((s) => s.item.linkId === v);
      if (step) showStep(step, { withAnswer: true });
      break; }
    case 'send': send(); break;
    case 'pdf': loadPdf(); break;
    case 'restart': restart(); break;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'Escape' && S.settings) { S.settings = false; render(); return; }
  if (S.screen !== 'item' || S.settings) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const { step } = position();
  if (/^[1-9]$/.test(e.key) && step.kind === 'choice') {
    const o = (step.item.answerOption || [])[Number(e.key) - 1];
    if (o) { e.preventDefault(); pick(o.valueCoding.code, true); }
  } else if ((e.key === 'r' || e.key === 'R') && S.mode !== 'sr') {
    e.preventDefault(); speak(stepSpeech(step, { withAnswer: true }));
  }
});

/* ---------- Start ---------- */
applyTheme();
render();
fetch(QUESTIONNAIRE_URL, { cache: 'no-store' })
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then((q) => {
    if (!q || q.resourceType !== 'Questionnaire') throw new Error('Datei ist kein FHIR Questionnaire.');
    Q = q; indexChoices(Q.item, null);
    S.screen = 'staff'; S.focusHeading = true; render();
  })
  .catch((err) => { S.screen = 'loadError'; S.error = String(err && err.message ? err.message : err); render(); });

})();
