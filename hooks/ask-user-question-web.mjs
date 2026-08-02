#!/usr/bin/env node
// PreToolUse hook for AskUserQuestion: renders the questions as a local HTML page, waits for
// the answers, and hands them back by pre-filling the tool's own `answers` field.
//
// Any failure — bad payload, no browser, no answer in time — emits `defer`, which drops
// Claude Code back to its normal in-terminal picker. The hook must never wedge the session.

import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('./ask-user-question.html', import.meta.url));
// Shell command used to open the page, with `{url}` substituted. Naming a browser explicitly
// (`open -a ...`) bypasses the default handler, so a chooser like Choosy never prompts. The
// default consults the handler, which is the portable behaviour on a machine without Chrome.
const BROWSER = process.env.CLAUDE_ASK_BROWSER || 'open "{url}"';
// Application to bring to the front once the page is open, e.g. "Google Chrome". Claude is
// blocked until the question is answered, so raising the window is usually wanted — but it
// steals focus, so it is opt-in.
// Keep focus where it was when the question arrived. Opening a URL raises the browser whether you
// asked for it or not, which interrupts whatever you were typing in another app.
const KEEP_FOCUS = process.env.CLAUDE_ASK_KEEP_FOCUS === '1';
// The two want opposite things, so KEEP_FOCUS wins: a stale ACTIVATE left in the environment by a
// long-running session must not quietly defeat the setting you just turned on.
const ACTIVATE = (!KEEP_FOCUS && process.env.CLAUDE_ASK_ACTIVATE) || '';
// How long focus is held. Long enough to outlast the browser's own raises (measured at just over
// a second on a warm Chrome), short enough that deliberately clicking into the page still works.
const KEEP_FOCUS_MS = Number(process.env.CLAUDE_ASK_KEEP_FOCUS_MS) || 3000;
// Just inside the hook's own timeout in settings.json, so we surrender before the harness kills
// us — a killed hook emits nothing, so there is no graceful fallback. Raise BOTH together.
const WAIT_MS = Number(process.env.CLAUDE_ASK_WAIT_MS) || 570_000;
// Idle, rather than absolute: interacting with the page pushes the deadline back, so a question
// you are actively working through does not expire mid-thought. WAIT_MS remains the hard ceiling.
const IDLE_MS = Math.min(Number(process.env.CLAUDE_ASK_IDLE_MS) || 300_000, WAIT_MS);
// Sound played when a question opens, as a name from /System/Library/Sounds ("Submarine") or a
// path to an audio file. Empty by default: a hook that makes noise uninvited is a bad neighbour.
// A terminal bell was tried here and removed: Claude Code spawns hooks without a controlling
// terminal, so /dev/tty is "device not configured" every time and the write only ever throws.
const SOUND = process.env.CLAUDE_ASK_SOUND || '';
// Seconds after opening at which the sound plays again, for a question that goes unanswered. One
// chime is easy to miss if you were away from the desk; a nag every minute forever is not.
const SOUND_REPEATS = (process.env.CLAUDE_ASK_SOUND_REPEATS ?? '60,120')
  .split(',')
  .map((s) => Number(s.trim()) * 1000)
  .filter((ms) => ms > 0);
// Off switch, for when the machine running the session is not the machine you are sitting at —
// /remote-control and /teleport being the cases that matter. A page opened on a laptop you have
// walked away from is a question nobody can answer, and Claude waits until it times out.
//
// Usually nothing to set: `/remote-control` is detected and the hook stands down on its own.
// The manual forms below remain for the cases detection cannot see.
const OFF_FILE = process.env.CLAUDE_ASK_OFF_FILE || `${process.env.HOME}/.claude/ask-web-off`;
// Claude Code keeps live per-session state here, one file per process, rewritten as the session
// changes. It is the only place remote control is observable from outside the process.
const SESSIONS_DIR = process.env.CLAUDE_ASK_SESSIONS_DIR || `${process.env.HOME}/.claude/sessions`;
// Undocumented internal state, so treat it as a courtesy that may vanish in a future release:
// every read is best-effort, and anything unexpected leaves the page enabled rather than
// silently swallowing questions.
const AUTO_DETECT = process.env.CLAUDE_ASK_DETECT_REMOTE !== '0';

/**
 * True when this session is currently driven from another device.
 *
 * `bridgeSessionId` is the connection to the phone or browser acting as the remote: it holds an
 * id for exactly as long as remote control is connected, gets a fresh id on each reconnect, and
 * returns to null on disconnect. Files are matched on session id rather than pid, because the
 * hook's own pid is not the session's and CLAUDE_PID is not guaranteed to reach a hook.
 */
function remoteControlled(id) {
  if (!AUTO_DETECT || !id) return false;
  try {
    for (const name of readdirSync(SESSIONS_DIR)) {
      if (!name.endsWith('.json')) continue;
      let state;
      try {
        state = JSON.parse(readFileSync(`${SESSIONS_DIR}/${name}`, 'utf8'));
      } catch {
        continue; // Half-written or not ours; the next file may still match.
      }
      if (state?.sessionId === id) return Boolean(state.bridgeSessionId);
    }
  } catch {
    // No sessions directory, or no permission to read it. Fall through to the manual switches.
  }
  return false;
}

const disabled = (id) => {
  if (process.env.CLAUDE_ASK_DISABLE === '1') return 'disabled by CLAUDE_ASK_DISABLE';
  if (existsSync(OFF_FILE)) return `disabled by ${OFF_FILE}`;
  // Per-session form, so one session can opt out without silencing the rest.
  if (id && existsSync(`/tmp/claude-ask-off-${id}`)) return `disabled for session ${id}`;
  if (remoteControlled(id)) return 'remote control is connected; asking in the session instead';
  return '';
};

const emit = (hookSpecificOutput) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
};
const defer = (reason) => {
  if (reason) process.stderr.write(`ask-user-question-web: ${reason}\n`);
  emit({ hookEventName: 'PreToolUse', permissionDecision: 'defer' });
  process.exit(0);
};

/** Record where the question is waiting; surfaced by Claude Code only if the hook fails. */
function announce(url) {
  process.stderr.write(`Question waiting at ${url}\n`);
}

// Flag file read by the status line, so the chat pane shows an outstanding question even when
// the browser tab is buried. Hard-coded /tmp rather than TMPDIR, so the hook and the status
// line agree on the path regardless of how each was launched.
const flagPath = (id) => `/tmp/claude-ask-waiting-${id || 'unknown'}`;

// Session whose flag is currently raised, so the teardown handlers below can find it without
// threading it through every call.
let flagged = '';

// URL on the first line, question count on the second. A status line that only reads the first
// line — as every version before the count existed did — still works unchanged.
const raiseFlag = (id, url, count) => {
  try {
    writeFileSync(flagPath(id), `${url}\n${count}\n`);
    flagged = id;
  } catch {
    // The status line is a courtesy; never fail the prompt over it.
  }
};

/**
 * Deleting the flag file is the escape hatch when the browser is unreachable: nothing about the
 * page can be clicked from a terminal, but `rm` always works. Skipped if the flag was never
 * written, since a missing file would otherwise read as an instant cancel.
 */
const watchFlag = (id, onGone) => {
  if (!existsSync(flagPath(id))) return;
  const timer = setInterval(() => {
    if (existsSync(flagPath(id))) return;
    clearInterval(timer);
    onGone();
  }, 1000);
  timer.unref();
};

const clearFlag = (id) => {
  try {
    unlinkSync(flagPath(id));
  } catch {
    // Already gone, or never written.
  } finally {
    if (id === flagged) flagged = '';
  }
};

// Ctrl-C in the terminal, or anything else that kills the hook, skips the normal cleanup and
// leaves the status line advertising a question whose server has already died. These handlers
// catch every ending we can observe; only SIGKILL escapes them, and a stray flag can always be
// removed by hand.
process.on('exit', () => {
  if (flagged) clearFlag(flagged);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (flagged) clearFlag(flagged);
    process.exit(0);
  });
}

/**
 * Bundle path of the frontmost application, or '' if it cannot be determined. `lsappinfo` is used
 * rather than AppleScript because reading the front app via System Events needs an Automation
 * permission the user has to grant by hand, and a focus nicety must not depend on a permission
 * prompt.
 *
 * The path, not the display name: VS Code reports its name as "Code" while its bundle is
 * "Visual Studio Code.app", so `open -a Code` fails and focus is never handed back. A path always
 * resolves.
 */
function frontApp() {
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    if (!asn) return '';
    const info = execFileSync('lsappinfo', ['info', '-only', 'bundlepath', asn], { encoding: 'utf8' });
    return info.match(/"LSBundlePath"="((?:[^"\\]|\\.)*)"/)?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * Hold the front on `app`, a bundle path, for a short window after launch. A browser raises
 * itself more than once — on launch, then again when the window renders — so restoring a single
 * time loses to the second raise. The window is deliberately brief: once it closes, focus is
 * yours to move, and clicking into the page a couple of seconds later behaves normally.
 *
 * The poll interval is the flicker you see: the browser holds the front until the next tick
 * notices. 100ms keeps that blink short without making `lsappinfo` calls a nuisance.
 */
const POLL_MS = 100;

function guardFocus(app) {
  const until = KEEP_FOCUS_MS / POLL_MS;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = frontApp();
    if (now && now !== app) {
      // `open -a` needs no Automation permission; AppleScript `activate` does.
      const back = spawn('open', ['-a', app], { stdio: 'ignore', detached: true });
      back.on('error', () => {}); // Focus is a nicety; never fail the prompt over it.
      back.unref();
    }
    if (++ticks >= until) clearInterval(timer);
  }, POLL_MS);
  timer.unref();
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Last value of a string field in the transcript, which appends as the session goes on. */
const lastField = (transcript, field) => {
  const hits = transcript.match(new RegExp(`"${field}":"(?:[^"\\\\]|\\\\.)*"`, 'g'));
  return hits?.length ? JSON.parse(`{${hits.at(-1)}}`)[field] : '';
};

/**
 * Header context for the page. The session name Claude Code displays is written into the
 * transcript as `aiTitle`; the branch rides along as `gitBranch`. All fields are optional —
 * the page renders whatever it is given, so a title-less or unreadable transcript is not
 * worth failing the prompt over.
 */
async function context(payload) {
  const dir = payload.cwd ? payload.cwd.split('/').filter(Boolean).at(-1) : '';
  let title = '';
  let branch = '';
  try {
    const transcript = await readFile(payload.transcript_path, 'utf8');
    title = lastField(transcript, 'aiTitle');
    branch = lastField(transcript, 'gitBranch');
  } catch {
    // Fall through to whatever the payload alone can tell us.
  }
  return { title: title || dir, project: dir, branch, cwd: payload.cwd ?? '' };
}

/**
 * Make some noise, so a question that opens in a background tab is not missed. A courtesy: it is
 * never allowed to fail the prompt, and never blocks the wait.
 */
function announceAloud() {
  if (!SOUND) return;
  const file = SOUND.includes('/') ? SOUND : `/System/Library/Sounds/${SOUND}.aiff`;
  const play = () => {
    const child = spawn('afplay', [file], { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // Missing afplay or a bad sound name is not worth a failure.
    child.unref();
  };
  play();
  // Unref'd, so answering ends the process and the pending reminders die with it.
  for (const ms of SOUND_REPEATS) setTimeout(play, ms).unref();
}

/**
 * Preferred port for a session: the same session lands on the same port every time, so a browser
 * tab can be pinned and refreshed rather than hunted for. FNV-1a over the session id, folded into
 * the ephemeral range macOS hands out anyway (49152–65535), so we are not squatting on anything
 * with a registered use.
 *
 * Nothing reserves the port between questions, so this is a preference, not a guarantee — the
 * caller falls back to an OS-assigned port if it is taken.
 */
function sessionPort(id) {
  let hash = 0x811c9dc5;
  for (const ch of String(id || 'unknown')) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 49152 + (hash % 16384);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Serve the page on this session's port and resolve with the posted answers. */
function ask(questions, meta, sessionId) {
  return new Promise((resolve, reject) => {
    let html;

    // Two clocks. `hardAt` is when the harness would kill us regardless; `idleAt` moves forward
    // every time you touch the page. Whichever comes first ends the wait, and the page is told
    // how long it has so it can count down instead of expiring without warning.
    const startedAt = Date.now();
    const hardAt = startedAt + WAIT_MS;
    let idleAt = Math.min(startedAt + IDLE_MS, hardAt);
    const remaining = () => Math.max(0, Math.min(idleAt, hardAt) - Date.now());

    let expiry;
    const armExpiry = () => {
      clearTimeout(expiry);
      expiry = setTimeout(() => {
        if (remaining() > 0) return armExpiry(); // Pushed back while we were asleep.
        server.close();
        reject(new Error('no answer within the wait window'));
      }, remaining());
      expiry.unref();
    };

    const touch = () => {
      idleAt = Math.min(Date.now() + IDLE_MS, hardAt);
      armExpiry();
    };

    const server = http.createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && req.url === '/') {
          // `<` escaped so no question text can close the <script> block early.
          // `idleMs` and the hard ceiling let the page reset its own countdown the instant you
          // type, instead of waiting for a throttled ping to come back and correct it.
          const json = JSON.stringify({
            questions,
            ...meta,
            remaining: remaining(),
            idleMs: IDLE_MS,
            hardRemaining: Math.max(0, hardAt - Date.now()),
          }).replaceAll('<', '\\u003c');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html.replace('__PAYLOAD__', () => json));
          return;
        }
        if (req.method === 'POST' && req.url === '/keepalive') {
          touch();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ remaining: remaining() }));
          return;
        }
        if (req.method === 'POST' && req.url === '/cancel') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          server.close();
          resolve({ cancelled: 'cancelled from the page' });
          return;
        }
        if (req.method === 'POST' && req.url === '/submit') {
          const body = JSON.parse(await readBody(req));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          server.close();
          resolve(body);
          return;
        }
        res.writeHead(404).end();
      } catch (err) {
        res.writeHead(500).end();
        server.close();
        reject(err);
      }
    });

    // A port already in use is the one error worth surviving: something else grabbed this
    // session's port between questions, so take whatever the OS offers instead.
    const preferred = sessionPort(sessionId);
    let fellBack = false;
    server.on('error', (err) => {
      if (err?.code === 'EADDRINUSE' && !fellBack) {
        fellBack = true;
        process.stderr.write(`ask-user-question-web: port ${preferred} taken, using any free port\n`);
        server.listen(0, '127.0.0.1', ready);
        return;
      }
      reject(err);
    });

    function ready() {
      // The URL is ours and contains only a port number, so there is nothing to escape.
      const url = `http://127.0.0.1:${server.address().port}/`;
      announce(url);
      announceAloud();
      raiseFlag(sessionId, url, questions.length);
      watchFlag(sessionId, () => {
        server.close();
        resolve({ cancelled: 'flag file removed' });
      });
      // Read before the browser launches, or the answer is already "the browser".
      const wasFront = KEEP_FOCUS ? frontApp() : '';
      const child = spawn('sh', ['-c', BROWSER.replaceAll('{url}', url)], {
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', reject);
      child.unref();

      if (wasFront) guardFocus(wasFront);

      // Raised after a beat, so the browser has taken the URL before it is brought forward.
      if (ACTIVATE) {
        setTimeout(() => {
          const raise = spawn('osascript', ['-e', `tell application ${JSON.stringify(ACTIVATE)} to activate`], {
            stdio: 'ignore',
            detached: true,
          });
          raise.on('error', () => {}); // Focus is a nicety; never fail the prompt over it.
          raise.unref();
        }, 700).unref();
      }
    }

    readFile(PAGE, 'utf8').then((contents) => {
      html = contents;
      server.listen(preferred, '127.0.0.1', ready);
    }, reject);

    armExpiry();
  });
}

try {
  const payload = JSON.parse(await readStdin());
  // Checked before anything is opened or served, so a disabled hook is indistinguishable from
  // one that was never installed: the terminal picker asks, and the remote client renders it.
  const off = disabled(payload?.session_id);
  if (off) defer(off);

  const questions = payload?.tool_input?.questions;
  if (!Array.isArray(questions) || questions.length === 0) defer('no questions in tool_input');

  const meta = await context(payload);
  const sessionId = payload.session_id;

  let answers;
  let annotations;
  let cancelled;
  try {
    ({ answers, annotations, cancelled } = await ask(questions, meta, sessionId));
  } finally {
    // However the wait ends, the status line must stop advertising a question.
    clearFlag(sessionId);
  }

  // Cancelling takes the same route as any other failure: defer, and the question reappears in
  // the terminal picker. Nothing is lost by backing out of the page.
  if (cancelled) defer(cancelled);

  if (!answers || Object.keys(answers).length === 0) defer('empty answers');

  // The terminal picker works by writing `answers`/`annotations` back into the tool's own
  // input, so pre-filling them via `updatedInput` makes the tool skip asking. `syntheticOutput`
  // is sent too but is NOT honoured for this tool — do not rely on it alone.
  const result = { questions, answers };
  if (annotations && Object.keys(annotations).length) result.annotations = annotations;

  emit({
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: result,
    syntheticOutput: result,
  });
} catch (err) {
  defer(err?.message ?? String(err));
}
