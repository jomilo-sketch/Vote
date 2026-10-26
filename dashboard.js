/*
  BOUESTI Vote — administrator dashboard (one file).

  How it fits together
    * The page shows only what the server's permission list for your role
      allows. The server checks every request again, so hiding a button here
      is a convenience, never the protection.
    * Sensitive actions ask for a fresh 2FA code ("step-up"). The request is
      sent, the server answers "step-up-required", this file asks for the
      code and then repeats the request once.
    * Background refreshes ("polls") never touch a form you are editing and
      never keep an idle session alive. Only your own clicks and typing do.

  Sections of this file
      1  helpers, dialogs and the server wrapper
      2  session, navigation and polling
      3  Dashboard, Election, Voters/Students, Candidates
      4  Voting Statistics, Results, Notifications, Audit
      5  Settings, Administrators, Operations, My account, start-up
*/

"use strict";

/* ====================================================================== */
/* 1. Helpers, dialogs and the server wrapper                               */
/* ====================================================================== */

const $ = (id) => document.getElementById(id);
const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  admin: null,
  perms: new Set(),
  idleSec: 900,
  idleDeadline: 0,
  absoluteDeadline: 0,
  lastTouch: Date.now(),
  currentView: null,
  built: new Set(),
  election: null,
  views: []
};

const can = (permission) => state.perms.has(permission);

function pill(text, kind) {
  return `<span class="pill pill--${escapeHtml(kind)}">${escapeHtml(text)}</span>`;
}

/* "5 minutes ago". Accepts an ISO date string or a number of milliseconds
   since 1970 (session times are stored that way). */
function agoText(when) {
  if (when === null || when === undefined || when === "") return "never";

  const moment = typeof when === "number" ? when : Date.parse(when);
  const seconds = (Date.now() - moment) / 1000;
  if (!Number.isFinite(seconds)) return "—";

  return seconds < 45 ? "just now" : `${formatDuration(seconds)} ago`;
}

function tableHtml({ head, rows, empty = "Nothing to show yet." }) {
  if (!rows.length) return `<p class="admin-table-empty">${escapeHtml(empty)}</p>`;

  return `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr>${head.map((label) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>`;
}

function statCard(label, value, sub = "") {
  return `
    <div class="stat-card">
      <p class="stat-sub">${escapeHtml(label)}</p>
      <p class="stat-value">${escapeHtml(value)}</p>
      ${sub ? `<p class="stat-sub">${escapeHtml(sub)}</p>` : ""}
    </div>`;
}

function toast(text, kind = "ok") {
  const item = document.createElement("div");

  item.className = `toast${kind === "error" ? " toast--error" : ""}`;
  item.setAttribute("role", kind === "error" ? "alert" : "status");
  item.textContent = text;
  $("toasts").appendChild(item);

  setTimeout(() => item.remove(), kind === "error" ? 9000 : 4500);
}

function fail(error) {
  if (error && error.cancelled) return;
  toast(error && error.message ? error.message : "Something went wrong. Please try again.", "error");
}

async function withBusy(button, task) {
  if (button) button.disabled = true;

  try {
    return await task();
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}

function debounce(task, wait = 300) {
  let timer = null;

  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => task(...args), wait);
  };
}

/* Read a chosen text file in the browser (nothing is uploaded until you press the button). */
function readTextFile(file, maxBytes = 3_000_000) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("Choose a file first."));
    if (file.size > maxBytes) return reject(new Error("That file is too large (limit 3 MB)."));

    const reader = new FileReader();

    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsText(file);
  });
}

/* A small, compressed picture that can be stored with the candidate. */
function pictureToDataUrl(file, size = 160) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      return reject(new Error("Choose a PNG, JPEG, WebP or GIF picture."));
    }

    const reader = new FileReader();

    reader.onerror = () => reject(new Error("The picture could not be read."));
    reader.onload = () => {
      const image = new Image();

      image.onerror = () => reject(new Error("That file is not a usable picture."));
      image.onload = () => {
        const scale = Math.min(1, size / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");

        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };

      image.src = String(reader.result);
    };

    reader.readAsDataURL(file);
  });
}

/* ---------- dialogs ---------- */

function runDialog(id, setup) {
  return new Promise((resolve) => {
    const dialog = $(id);
    const controller = new AbortController();
    const { signal } = controller;
    let finished = false;

    const done = (value) => {
      if (finished) return;

      finished = true;
      controller.abort();
      if (dialog.open) dialog.close();
      resolve(value);
    };

    if (dialog.open) dialog.close();

    dialog.addEventListener("close", () => done(null), { signal });
    setup(dialog, done, signal);
    dialog.showModal();
  });
}

function confirmDialog({ title, body, confirmText = "Confirm", danger = false, phrase = null }) {
  return runDialog("confirmDialog", (dialog, done, signal) => {
    $("confirmTitle").textContent = title;
    $("confirmBody").textContent = body;
    $("confirmPhraseBox").hidden = !phrase;
    $("confirmPhrase").value = "";
    $("confirmMessage").textContent = "";
    $("confirmPhraseLabel").textContent = phrase ? `Type ${phrase} to confirm` : "";

    const ok = $("confirmOk");

    ok.textContent = confirmText;
    ok.classList.toggle("danger", danger);

    $("confirmForm").addEventListener("submit", (event) => {
      event.preventDefault();

      if (phrase && $("confirmPhrase").value.trim().toUpperCase() !== phrase) {
        $("confirmMessage").textContent = `Type ${phrase} exactly as shown.`;
        return;
      }

      done(true);
    }, { signal });

    $("confirmCancel").addEventListener("click", () => done(false), { signal });
    if (phrase) setTimeout(() => $("confirmPhrase").focus(), 30);
  }).then((value) => value === true);
}

/* Resolves to the typed text, or null if cancelled. */
function promptDialog({ title, intro = "", label, confirmText = "Save", minLength = 0, multiline = true, value = "" }) {
  return runDialog("promptDialog", (dialog, done, signal) => {
    $("promptTitle").textContent = title;
    $("promptIntro").textContent = intro;
    $("promptLabel").textContent = label;
    $("promptOk").textContent = confirmText;
    $("promptMessage").textContent = "";
    $("promptInput").rows = multiline ? 3 : 1;
    $("promptInput").value = value;

    $("promptForm").addEventListener("submit", (event) => {
      event.preventDefault();

      const text = $("promptInput").value.trim();

      if (text.length < minLength) {
        $("promptMessage").textContent = `Please write at least ${minLength} characters.`;
        return;
      }

      done(text);
    }, { signal });

    $("promptCancel").addEventListener("click", () => done(null), { signal });
    setTimeout(() => $("promptInput").focus(), 30);
  });
}

/* Shows something exactly once. Escape does not close it, so it cannot be lost by accident. */
function secretDialog({ title, intro, text, note = "" }) {
  return runDialog("secretDialog", (dialog, done, signal) => {
    $("secretTitle").textContent = title;
    $("secretIntro").textContent = intro;
    $("secretBox").textContent = text;
    $("secretNote").textContent = note;
    $("secretCopy").textContent = "Copy";

    dialog.addEventListener("cancel", (event) => event.preventDefault(), { signal });

    $("secretCopy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        $("secretCopy").textContent = "Copied ✓";
      } catch (error) {
        $("secretCopy").textContent = "Select the text and copy it by hand";
      }
    }, { signal });

    $("secretClose").addEventListener("click", () => done(true), { signal });
  });
}

function infoDialog(title, html) {
  return runDialog("infoDialog", (dialog, done, signal) => {
    $("infoTitle").textContent = title;
    $("infoBody").innerHTML = html;
    $("infoClose").addEventListener("click", () => done(true), { signal });
  });
}

/* ---------- step-up: a fresh 2FA code for sensitive actions ---------- */

let stepUpInFlight = null;

function askStepUp() {
  if (stepUpInFlight) return stepUpInFlight;

  stepUpInFlight = runDialog("stepUpDialog", (dialog, done, signal) => {
    const input = $("stepUpCode");
    const message = $("stepUpMessage");

    input.value = "";
    message.textContent = "";
    setTimeout(() => input.focus(), 30);

    $("stepUpForm").addEventListener("submit", async (event) => {
      event.preventDefault();

      const code = input.value.trim();

      if (!code) {
        message.textContent = "Type the code from your authenticator app.";
        return;
      }

      try {
        await api("POST", "/api/admin/stepup", { code });
        noteTouched();
        done(true);
      } catch (error) {
        if (error.code === "unauthenticated") {
          done(false);
          redirectToSignIn("Your session has ended. Please sign in again.");
          return;
        }

        message.textContent = error.message;
        input.value = "";
        input.focus();
      }
    }, { signal });

    $("stepUpCancel").addEventListener("click", () => done(false), { signal });
  }).then((value) => {
    stepUpInFlight = null;
    return value === true;
  });

  return stepUpInFlight;
}

/* ---------- the server wrapper every view uses ---------- */

function noteTouched() {
  state.idleDeadline = Date.now() + state.idleSec * 1000;
  state.lastTouch = Date.now();
}

function cancelled(error) {
  error.cancelled = true;
  return error;
}

async function call(method, path, body, options = {}) {
  try {
    const data = await api(method, path, body);

    if (!options.passive) noteTouched();
    return data;
  } catch (error) {
    if (error.code === "unauthenticated") {
      redirectToSignIn("Your session has ended. Please sign in again.");
      throw cancelled(error);
    }

    if (error.code === "step-up-required" && !options.retried) {
      if (await askStepUp()) return call(method, path, body, { ...options, retried: true });
      throw cancelled(error);
    }

    throw error;
  }
}

async function download(path, retried = false) {
  try {
    const name = await downloadFile(path);

    noteTouched();
    return name;
  } catch (error) {
    if (error.code === "unauthenticated") {
      redirectToSignIn("Your session has ended. Please sign in again.");
      throw cancelled(error);
    }

    if (error.code === "step-up-required" && !retried) {
      if (await askStepUp()) return download(path, true);
      throw cancelled(error);
    }

    throw error;
  }
}

/* Attach one click handler to a view body; buttons say what they do with data-act. */
function onAct(container, handlers) {
  container.addEventListener("click", (event) => {
    const target = event.target.closest("[data-act]");

    if (!target || !container.contains(target) || target.disabled) return;

    const handler = handlers[target.dataset.act];
    if (!handler) return;

    event.preventDefault();
    Promise.resolve(handler(target, event)).catch(fail);
  });
}

function formMessage(id, text, ok = false) {
  const element = $(id);

  if (!element) return;

  element.textContent = text || "";
  element.classList.toggle("form-message--ok", Boolean(ok && text));
}

/* ====================================================================== */
/* 2. Session, navigation and polling                                       */
/* ====================================================================== */

function redirectToSignIn(reason) {
  try {
    if (reason) sessionStorage.setItem("bouesti-flash", reason);
  } catch (error) {
    /* storage can be unavailable; the sign-in page still works */
  }

  window.location.replace("/admin.html");
}

function applySession(described) {
  if (!described || !described.signedIn || described.stage !== "full" || !described.session || !described.admin) {
    redirectToSignIn();
    return false;
  }

  const now = Date.now();

  state.idleSec = (described.session.idleMinutes || 15) * 60;
  state.idleDeadline = now + described.session.idleExpiresInSec * 1000;
  state.absoluteDeadline = now + described.session.absoluteExpiresInSec * 1000;
  state.admin = described.admin;
  state.perms = new Set(described.admin.permissions);

  return true;
}

/* Re-read the server's idea of the session without extending it. */
async function syncSession() {
  try {
    applySession(await api("GET", "/api/admin/session"));
  } catch (error) {
    if (error.status === 401) redirectToSignIn();
  }
}

/* Called when you click or type (at most once a minute): this DOES extend the session. */
async function keepAlive() {
  state.lastTouch = Date.now();

  try {
    if (applySession(await api("POST", "/api/admin/keepalive", {}))) tick();
  } catch (error) {
    if (error.code === "unauthenticated") redirectToSignIn("Your session has ended. Please sign in again.");
  }
}

function tick() {
  const now = Date.now();
  const idleLeft = Math.floor((state.idleDeadline - now) / 1000);
  const absoluteLeft = Math.floor((state.absoluteDeadline - now) / 1000);
  const left = Math.min(idleLeft, absoluteLeft);

  if (left <= 0) {
    redirectToSignIn(
      absoluteLeft <= 0
        ? "Your session reached its maximum length. Please sign in again."
        : "You were signed out because of inactivity."
    );
    return;
  }

  $("sessionTimer").textContent = left <= 300 ? `Session ends in ${formatClock(left)}` : "";

  const warn = left <= 120;
  const limitedByMaximum = absoluteLeft <= idleLeft;

  $("sessionBanner").hidden = !warn;
  $("sessionStay").hidden = limitedByMaximum;

  if (warn) {
    $("sessionBannerText").textContent = limitedByMaximum
      ? `Your session reaches its maximum length in ${formatClock(left)}. Save your work and sign in again.`
      : `You will be signed out for inactivity in ${formatClock(left)}.`;
  }
}

async function logout() {
  try {
    await api("POST", "/api/admin/logout", {});
  } catch (error) {
    /* the cookie is cleared by the server when it can; either way we leave */
  }

  try {
    sessionStorage.setItem("bouesti-flash", "You have been signed out.");
  } catch (error) {
    /* ignore */
  }

  window.location.replace("/admin.html");
}

/* ---------- which sections exist (the server re-checks every request) ---------- */

function buildViews() {
  return [
    { id: "dashboard", label: "Dashboard", allowed: () => can("election.view"), enter: enterDashboard, poll: pollDashboard },
    { id: "election", label: "Election", allowed: () => can("election.view"), enter: enterElection, poll: pollElection },
    { id: "students", label: "Voters / Students", allowed: () => can("voters.view"), enter: enterStudents },
    { id: "candidates", label: "Candidates", allowed: () => can("election.view"), enter: enterCandidates },
    { id: "statistics", label: "Voting Statistics", allowed: () => can("stats.view"), enter: enterStatistics, poll: pollStatistics },
    { id: "results", label: "Results", allowed: () => can("results.view"), enter: enterResults },
    { id: "notifications", label: "Notifications", allowed: () => can("election.view") || can("reports.view"), enter: enterNotifications },
    { id: "audit", label: "Activity / Audit Logs", allowed: () => can("audit.view"), enter: enterAudit },
    { id: "settings", label: "Settings", allowed: () => can("settings.manage"), enter: enterSettings },
    { id: "admins", label: "Administrators", allowed: () => can("admins.view"), enter: enterAdmins },
    { id: "ops", label: "Operations", allowed: () => can("ops.view"), enter: enterOps, poll: pollOps },
    { id: "account", label: "My account", allowed: () => true, enter: enterAccount }
  ];
}

function buildNav() {
  const items = state.views
    .filter((view) => view.allowed())
    .map((view) => `<li><button class="admin-nav-button" type="button" data-view="${view.id}">${escapeHtml(view.label)}</button></li>`)
    .join("");

  $("adminNav").innerHTML = `${items}<li><button class="admin-nav-button logout" type="button" data-action="logout">Logout</button></li>`;
}

async function showView(requested) {
  const allowed = state.views.filter((view) => view.allowed());
  const view = allowed.find((candidate) => candidate.id === requested) || allowed[0];

  if (!view) return;

  state.currentView = view.id;

  qsa(".admin-view").forEach((section) => {
    section.classList.toggle("active-view", section.id === `view-${view.id}`);
  });

  qsa(".admin-nav-button[data-view]").forEach((button) => {
    const active = button.dataset.view === view.id;

    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  document.title = `${view.label} · BOUESTI Vote`;

  try {
    await view.enter();
  } catch (error) {
    fail(error);
  }
}

function go(id) {
  try {
    history.pushState(null, "", `#${id}`);
  } catch (error) {
    /* some embedded browsers refuse; the view still changes */
  }

  window.scrollTo({ top: 0 });
  return showView(id);
}

function startBackgroundWork() {
  // Refresh what is on screen. These calls are "passive": they never extend an idle session.
  setInterval(() => {
    if (document.hidden) return;

    const view = state.views.find((candidate) => candidate.id === state.currentView);

    if (view && view.poll) view.poll().catch(() => { /* a missed refresh is quietly retried */ });
  }, 15_000);

  setInterval(() => {
    if (!document.hidden) syncSession();
  }, 60_000);

  setInterval(tick, 1000);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;

    syncSession().then(() => {
      const view = state.views.find((candidate) => candidate.id === state.currentView);
      if (view && view.poll) view.poll().catch(() => {});
    });
  });

  ["pointerdown", "keydown"].forEach((type) => {
    document.addEventListener(type, () => {
      if (Date.now() - state.lastTouch > 60_000) keepAlive();
    }, { passive: true });
  });
}

/* ====================================================================== */
/* 3a. Dashboard                                                            */
/* ====================================================================== */

const PHASE_TEXT = { open: "Voting open", upcoming: "Not open yet", closed: "Closed" };
const STATUS_TEXT = { upcoming: "Upcoming", active: "Active", closed: "Closed" };

function phasePill(phase) {
  return pill(PHASE_TEXT[phase] || phase, phase === "open" ? "active" : phase);
}

function modePill(mode) {
  return mode === "live" ? pill("LIVE election", "live") : pill("Rehearsal", "rehearsal");
}

function alertItems(alerts) {
  if (!alerts.length) return `<li class="alert alert--ok">Nothing needs attention.</li>`;

  return alerts
    .map((alert) => `<li class="alert alert--${escapeHtml(alert.level)}">${escapeHtml(alert.message)}</li>`)
    .join("");
}

async function enterDashboard() {
  const body = $("body-dashboard");

  if (!state.built.has("dashboard")) {
    state.built.add("dashboard");

    body.innerHTML = `
      <div class="stat-grid" id="dashCards"></div>

      <div class="admin-panel">
        <div class="admin-panel-heading">
          <h3>This election</h3>
          <span id="dashElectionPills"></span>
        </div>
        <dl class="kv-grid" id="dashElection"></dl>
      </div>

      <div class="admin-panel" id="dashHealthPanel" hidden>
        <div class="admin-panel-heading">
          <h3>System health</h3>
          <span id="dashHealthPill"></span>
        </div>
        <ul class="alert-list" id="dashAlerts"></ul>
        <div class="admin-controls">
          <button class="button secondary small" type="button" data-act="goto" data-view="ops">Open Operations</button>
        </div>
      </div>

      <div class="admin-panel">
        <div class="admin-panel-heading">
          <h3>Notice on the voting page</h3>
        </div>
        <p id="dashAnnouncement" class="muted"></p>
        <div class="admin-controls">
          <button class="button secondary small" type="button" data-act="goto" data-view="notifications">Open Notifications</button>
        </div>
      </div>

      <div class="admin-panel" id="dashFeedPanel" hidden>
        <div class="admin-panel-heading">
          <h3>Recent activity</h3>
          <button class="text-button" type="button" data-act="feed">Refresh</button>
        </div>
        <ul class="activity-list" id="dashFeed"></ul>
      </div>`;

    onAct(body, {
      goto: (element) => go(element.dataset.view),
      feed: () => loadFeed()
    });
  }

  await pollDashboard();
  if (can("audit.view")) await loadFeed();
}

async function pollDashboard() {
  const data = await call("GET", "/api/admin/dashboard", undefined, { passive: true });

  state.election = data.election;
  renderDashboard(data);
}

function renderDashboard(data) {
  const { election, counts, structure } = data;

  $("dashCards").innerHTML = [
    statCard("Students on the roster", counts.total, `${counts.active} allowed to vote`),
    statCard("Registered", counts.registered, "accepted the rules"),
    statCard("Verified", counts.verified, "confirmed their e-mail code"),
    statCard("Voted", counts.voted, counts.turnoutPercent === null ? "open roster — no percentage" : `${counts.turnoutPercent}% of eligible students`),
    statCard("Positions", structure.positions),
    statCard("Candidates", structure.candidates)
  ].join("");

  $("dashElectionPills").innerHTML = `${phasePill(election.phase)} ${modePill(election.mode)}`;

  $("dashElection").innerHTML = `
    <div><dt>Name</dt><dd>${escapeHtml(election.name)}</dd></div>
    <div><dt>Status set by officers</dt><dd>${escapeHtml(STATUS_TEXT[election.status] || election.status)}</dd></div>
    <div><dt>Voting opens</dt><dd>${escapeHtml(formatDateTime(election.votingOpensAt))}${election.opensByItself ? " — the server will open it by itself" : ""}</dd></div>
    <div><dt>Voting closes</dt><dd>${escapeHtml(formatDateTime(election.votingClosesAt))}</dd></div>
    <div><dt>Results published</dt><dd>${election.resultsPublished ? "Yes" : "Not yet"}</dd></div>
    <div><dt>Last changed</dt><dd>${escapeHtml(formatShortTime(election.updatedAt))} by ${escapeHtml(election.updatedBy || "system")}</dd></div>`;

  $("dashHealthPanel").hidden = !data.health;

  if (data.health) {
    $("dashHealthPill").innerHTML = pill(
      data.health.overall === "ok" ? "All good" : data.health.overall === "attention" ? "Needs attention" : "Critical",
      data.health.overall
    );
    $("dashAlerts").innerHTML = alertItems(data.health.alerts);
  }

  $("dashAnnouncement").textContent = data.announcement
    ? `"${data.announcement.message}" — posted ${formatShortTime(data.announcement.postedAt)}`
    : "No notice is showing on the voting page.";
}

async function loadFeed() {
  const panel = $("dashFeedPanel");
  const data = await call("GET", "/api/admin/activity");

  panel.hidden = false;
  $("dashFeed").innerHTML = data.entries.length
    ? data.entries
        .map((entry) => `
          <li>
            <span><span class="activity-receipt">${escapeHtml(entry.message)}</span><br /><small class="muted">${escapeHtml(entry.actor)} · ${escapeHtml(entry.category)}</small></span>
            <span class="activity-time">${escapeHtml(formatShortTime(entry.occurredAt))}</span>
          </li>`)
        .join("")
    : `<li class="activity-empty">Nothing has happened yet.</li>`;
}

/* ====================================================================== */
/* 3b. Election — name, schedule, status, mode                              */
/*                                                                          */
/*  The form is built ONCE and its fields are filled ONLY when you open the */
/*  page, after you save, or when you press "Discard changes". Background   */
/*  refreshes update the read-only summary above it and never the form, so  */
/*  an open date picker, a half-typed name or a chosen status is never      */
/*  reset while you work.                                                   */
/* ====================================================================== */

let electionDirty = false;

function selectedStatus() {
  const chosen = qs("input[name='electionStatus']:checked");
  return chosen ? chosen.value : null;
}

function fillElectionForm(election) {
  $("electionName").value = election.name || "";
  $("votingOpensAt").value = isoToLocalDatetimeInput(election.votingOpensAt);
  $("votingClosesAt").value = isoToLocalDatetimeInput(election.votingClosesAt);

  qsa("input[name='electionStatus']").forEach((radio) => {
    radio.checked = radio.value === election.status;
  });

  electionDirty = false;
  formMessage("electionMessage", "");
}

async function enterElection() {
  const body = $("body-election");

  if (!state.built.has("election")) {
    state.built.add("election");

    body.innerHTML = `
      <div class="admin-panel">
        <div class="admin-panel-heading">
          <h3>Right now</h3>
          <span id="electionPills"></span>
        </div>
        <dl class="kv-grid" id="electionSummary"></dl>
        <p class="small-note" id="electionLockNote" hidden></p>
      </div>

      <div class="admin-panel">
        <h3>Election details</h3>

        <form id="electionForm" novalidate>
          <label for="electionName">Election name</label>
          <input id="electionName" type="text" maxlength="120" autocomplete="off" />

          <div class="admin-form-grid">
            <div>
              <label for="votingOpensAt">Voting opens</label>
              <input id="votingOpensAt" type="datetime-local" />
            </div>
            <div>
              <label for="votingClosesAt">Voting closes</label>
              <input id="votingClosesAt" type="datetime-local" />
            </div>
          </div>
          <p class="field-note">
            Times are in your own time zone (<span id="zoneName"></span>). Clear a box to remove that time.
            Leave the status on <strong>Upcoming</strong> with an opening time that is still ahead and the server
            opens voting by itself at that time. At the closing time it closes voting by itself.
          </p>

          <label id="statusLabel">Status</label>
          <div class="status-picker" role="radiogroup" aria-labelledby="statusLabel">
            <label class="status-option"><input type="radio" name="electionStatus" value="upcoming" /><span>Upcoming</span></label>
            <label class="status-option"><input type="radio" name="electionStatus" value="active" /><span>Active</span></label>
            <label class="status-option"><input type="radio" name="electionStatus" value="closed" /><span>Closed</span></label>
          </div>
          <p class="field-note">
            <strong>Upcoming</strong>: voters cannot vote yet. <strong>Active</strong>: voting is open now.
            <strong>Closed</strong>: voting has ended and results can be counted — in a live election this is final.
            Changing the status asks for a fresh 2FA code.
          </p>

          <p class="form-message" id="electionMessage" role="alert"></p>

          <div class="admin-controls">
            <button class="button primary" id="electionSave" type="submit">Save changes</button>
            <button class="button secondary" id="electionDiscard" type="button">Discard changes</button>
          </div>
        </form>
      </div>

      <div class="admin-panel" id="modePanel">
        <div class="admin-panel-heading">
          <h3>Rehearsal or live</h3>
          <span id="modePill"></span>
        </div>
        <p class="muted" id="modeText"></p>
        <div class="admin-controls" id="modeControls"></div>
      </div>`;

    $("zoneName").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";

    $("electionForm").addEventListener("input", () => {
      electionDirty = true;
    });

    $("electionForm").addEventListener("submit", saveElection);

    $("electionDiscard").addEventListener("click", () => {
      if (state.election) fillElectionForm(state.election);
      toast("Changes discarded.");
    });

    onAct($("modePanel"), {
      checklist: () => go("ops"),
      reset: resetRehearsal
    });
  }

  const data = await call("GET", "/api/admin/election");

  state.election = data.election;
  renderElectionSummary(data);

  if (!electionDirty) fillElectionForm(data.election);
}

async function pollElection() {
  const data = await call("GET", "/api/admin/election", undefined, { passive: true });

  state.election = data.election;
  renderElectionSummary(data); // the form is deliberately left alone
}

function renderElectionSummary(data) {
  const election = data.election;
  const frozen = election.mode === "live" && election.status === "closed";
  const mayEdit = can("election.manage") && !frozen;

  $("electionPills").innerHTML = `${phasePill(election.phase)} ${modePill(election.mode)}`;

  $("electionSummary").innerHTML = `
    <div><dt>Name</dt><dd>${escapeHtml(election.name)}</dd></div>
    <div><dt>Status set by officers</dt><dd>${escapeHtml(STATUS_TEXT[election.status] || election.status)}</dd></div>
    <div><dt>Voting opens</dt><dd>${escapeHtml(formatDateTime(election.votingOpensAt))}${election.opensByItself ? " — the server will open it by itself" : ""}</dd></div>
    <div><dt>Voting closes</dt><dd>${escapeHtml(formatDateTime(election.votingClosesAt))}</dd></div>
    <div><dt>Opened at</dt><dd>${escapeHtml(formatDateTime(election.openedAt))}</dd></div>
    <div><dt>Closed at</dt><dd>${escapeHtml(formatDateTime(election.closedAt))}</dd></div>
    <div><dt>Ballots cast</dt><dd>${escapeHtml(data.ballotsCast)}</dd></div>
    <div><dt>Last changed</dt><dd>${escapeHtml(formatShortTime(election.updatedAt))} by ${escapeHtml(election.updatedBy || "system")}</dd></div>`;

  const note = $("electionLockNote");

  note.hidden = !(frozen || !can("election.manage"));
  note.textContent = frozen
    ? "This live election is closed and its record is frozen. It can no longer be edited."
    : "Your role can view the election but not change it.";

  qsa("#electionForm input, #electionForm button").forEach((control) => {
    control.disabled = !mayEdit;
  });

  $("modeText").textContent =
    election.mode === "live"
      ? `This is the LIVE election. It went live ${formatDateTime(election.wentLiveAt)}. The roster is closed, rehearsal data was wiped, and the election can never go back to rehearsal.`
      : "This is a REHEARSAL: you can try everything with test data, and students can sign in with any matric number. " +
        "Before the real vote, complete the go-live checklist in Operations. Going live wipes the rehearsal data and cannot be undone.";

  $("modePill").innerHTML = modePill(election.mode);

  $("modeControls").innerHTML =
    election.mode === "live"
      ? ""
      : `${can("mode.manage") ? `<button class="button primary small" type="button" data-act="checklist">Open the go-live checklist</button>
         <button class="button secondary small danger" type="button" data-act="reset">Reset rehearsal data</button>` : ""}`;
}

async function saveElection(event) {
  event.preventDefault();
  formMessage("electionMessage", "");

  const name = $("electionName").value.trim();
  const opens = localDatetimeInputToIso($("votingOpensAt").value);
  const closes = localDatetimeInputToIso($("votingClosesAt").value);
  const status = selectedStatus();

  if (name.length < 3) return formMessage("electionMessage", "Give the election a name of at least 3 characters.");
  if (!status) return formMessage("electionMessage", "Choose a status: upcoming, active or closed.");

  if (opens && closes && Date.parse(closes) <= Date.parse(opens)) {
    return formMessage("electionMessage", "The closing time must be later than the opening time.");
  }

  await withBusy($("electionSave"), async () => {
    try {
      const result = await call("PUT", "/api/admin/election", {
        electionName: name,
        status,
        votingOpensAt: opens,
        votingClosesAt: closes
      });

      state.election = result.election;
      fillElectionForm(result.election); // show exactly what the server saved
      toast("Election saved.");
      if (result.notice) formMessage("electionMessage", result.notice);
      await pollElection();
    } catch (error) {
      if (error.cancelled) return;
      formMessage("electionMessage", error.message);
    }
  });
}

async function resetRehearsal() {
  const sure = await confirmDialog({
    title: "Reset the rehearsal data?",
    body:
      "This deletes every test ballot, receipt and turnout record and clears each student's progress. " +
      "Candidates and the roster stay. It cannot be undone.",
    confirmText: "Reset rehearsal",
    danger: true,
    phrase: "RESET"
  });

  if (!sure) return;

  const result = await call("POST", "/api/admin/reset-rehearsal", { phrase: "RESET" });

  toast("Rehearsal data was reset.");
  if (result.removed) await pollElection();
}

/* ====================================================================== */
/* 3c. Voters / Students                                                    */
/* ====================================================================== */

const studentsView = { filter: "all", search: "", offset: 0, limit: 50, total: 0 };

const STUDENT_FILTERS = [
  ["all", "All"],
  ["pending", "Not started"],
  ["registered", "Registered"],
  ["verified", "Verified"],
  ["voted", "Voted"],
  ["inactive", "Disabled"]
];

function progressPill(student) {
  if (student.voted) return pill("Voted", "voted");
  if (student.verified) return pill("Verified", "verified");
  if (student.registered) return pill("Registered", "registered");
  return pill("Not started", "notstarted");
}

async function enterStudents() {
  const body = $("body-students");

  if (!state.built.has("students")) {
    state.built.add("students");

    const mayManage = can("voters.manage");

    body.innerHTML = `
      <div class="stat-grid" id="studentCounts"></div>

      <div class="admin-panel">
        <div class="admin-panel-heading">
          <h3>Roster</h3>
          <span class="small-print" id="rosterModeNote"></span>
        </div>

        <div class="toolbar">
          <div class="chips" id="studentFilters">
            ${STUDENT_FILTERS.map(([value, label]) => `<button class="chip${value === "all" ? " active" : ""}" type="button" data-filter="${value}">${label}</button>`).join("")}
          </div>
          <input class="admin-search" id="studentSearch" type="text" placeholder="Search matric, name or e-mail" aria-label="Search students" />
        </div>

        <div id="studentTable"></div>
        <div class="pager" id="studentPager"></div>
      </div>

      ${mayManage ? `
      <div class="admin-panel">
        <h3>Add one student</h3>
        <form id="studentAddForm" class="inline-form" novalidate>
          <div><label for="addMatric">Matric number (digits only)</label><input id="addMatric" type="text" inputmode="numeric" maxlength="15" autocomplete="off" /></div>
          <div><label for="addName">Full name</label><input id="addName" type="text" maxlength="200" autocomplete="off" /></div>
          <div><label for="addEmail">University e-mail</label><input id="addEmail" type="email" maxlength="200" autocomplete="off" /></div>
          <button class="button primary" type="submit">Add student</button>
        </form>
        <p class="form-message" id="studentAddMessage" role="alert"></p>
      </div>

      <div class="admin-panel">
        <h3>Upload a list of eligible students</h3>
        <p class="muted">
          One student per line: <span class="mono">matric, name, e-mail</span>. A header row is skipped.
          Matric numbers must be digits only. Choose a CSV/text file or paste the lines.
          Importing asks for a fresh 2FA code.
        </p>
        <input id="importFile" type="file" accept=".csv,.txt,text/csv,text/plain" />
        <label for="importText">Lines to import</label>
        <textarea id="importText" rows="6" placeholder="152637, Ada Obi, ada.obi@bouesti.edu.ng"></textarea>
        <div class="admin-controls">
          <button class="button primary" id="importRun" type="button" data-act="import">Import list</button>
          <button class="button secondary" type="button" data-act="export">Download roster (CSV)</button>
        </div>
        <div id="importResult"></div>
      </div>` : `
      <div class="admin-panel">
        <div class="admin-controls">
          <button class="button secondary" type="button" data-act="export">Download roster (CSV)</button>
        </div>
      </div>`}`;

    $("studentFilters").addEventListener("click", (event) => {
      const chip = event.target.closest("[data-filter]");
      if (!chip) return;

      studentsView.filter = chip.dataset.filter;
      studentsView.offset = 0;
      qsa("#studentFilters .chip").forEach((item) => item.classList.toggle("active", item === chip));
      loadStudents().catch(fail);
    });

    $("studentSearch").addEventListener("input", debounce(() => {
      studentsView.search = $("studentSearch").value.trim();
      studentsView.offset = 0;
      loadStudents().catch(fail);
    }));

    if (mayManage) {
      $("studentAddForm").addEventListener("submit", addStudent);

      $("importFile").addEventListener("change", async () => {
        try {
          $("importText").value = await readTextFile($("importFile").files[0]);
        } catch (error) {
          fail(error);
        }
      });
    }

    onAct(body, {
      toggle: async (button) => {
        const result = await call("POST", `/api/admin/students/${encodeURIComponent(button.dataset.matric)}/toggle`, {});

        toast(result.active ? "Student enabled." : "Student disabled and signed out.");
        await loadStudents();
      },
      remove: async (button) => {
        const sure = await confirmDialog({
          title: "Remove this student?",
          body: `Matric number ${button.dataset.matric} will be removed from the roster. This asks for a fresh 2FA code.`,
          confirmText: "Remove",
          danger: true
        });

        if (!sure) return;

        await call("DELETE", `/api/admin/students/${encodeURIComponent(button.dataset.matric)}`);
        toast("Student removed.");
        await loadStudents();
      },
      page: async (button) => {
        studentsView.offset = Math.max(0, studentsView.offset + Number(button.dataset.step) * studentsView.limit);
        await loadStudents();
      },
      import: importStudents,
      export: async () => {
        const name = await download("/api/admin/students/export.csv");
        toast(`Saved ${name}.`);
      }
    });
  }

  await loadStudents();
}

async function loadStudents() {
  const params = new URLSearchParams({
    filter: studentsView.filter,
    search: studentsView.search,
    limit: String(studentsView.limit),
    offset: String(studentsView.offset)
  });

  const data = await call("GET", `/api/admin/students?${params}`);
  const counts = data.counts;
  const mayManage = can("voters.manage");

  studentsView.total = data.total;

  $("studentCounts").innerHTML = [
    statCard("On the roster", counts.total, `${counts.inactive} disabled`),
    statCard("Registered", counts.registered, "accepted the rules"),
    statCard("Verified", counts.verified, "confirmed their e-mail code"),
    statCard("Voted", counts.voted)
  ].join("");

  $("rosterModeNote").textContent =
    data.rosterMode === "closed"
      ? "Closed roster: only active students listed here can vote."
      : "Open roster (rehearsal): any valid matric number can sign in.";

  $("studentTable").innerHTML = tableHtml({
    head: ["Matric number", "Name", "E-mail", "Progress", "Access", ...(mayManage ? ["Actions"] : [])],
    empty: studentsView.search || studentsView.filter !== "all" ? "No student matches that search." : "The roster is empty. Add students or upload a list below.",
    rows: data.students.map((student) => [
      `<span class="mono">${escapeHtml(student.matric)}</span>`,
      escapeHtml(student.name),
      escapeHtml(student.email),
      progressPill(student),
      student.active ? pill("Can vote", "yes") : pill("Disabled", "no"),
      ...(mayManage ? [`
        <div class="row-actions">
          <button type="button" data-act="toggle" data-matric="${escapeHtml(student.matric)}">${student.active ? "Disable" : "Enable"}</button>
          <button type="button" class="danger" data-act="remove" data-matric="${escapeHtml(student.matric)}">Remove</button>
        </div>`] : [])
    ])
  });

  const from = data.total === 0 ? 0 : studentsView.offset + 1;
  const to = Math.min(studentsView.offset + studentsView.limit, data.total);

  $("studentPager").innerHTML = `
    <span>Showing ${from}–${to} of ${data.total}</span>
    <span class="row-actions">
      <button type="button" class="chip" data-act="page" data-step="-1" ${studentsView.offset === 0 ? "disabled" : ""}>← Previous</button>
      <button type="button" class="chip" data-act="page" data-step="1" ${to >= data.total ? "disabled" : ""}>Next →</button>
    </span>`;
}

async function addStudent(event) {
  event.preventDefault();
  formMessage("studentAddMessage", "");

  const matric = $("addMatric").value.trim();
  const name = $("addName").value.trim();
  const email = $("addEmail").value.trim();

  if (!/^\d{4,15}$/.test(matric)) {
    return formMessage("studentAddMessage", "The matric number must be digits only, for example 152637.");
  }

  try {
    await call("POST", "/api/admin/students", { matric, name, email });

    ["addMatric", "addName", "addEmail"].forEach((id) => {
      $(id).value = "";
    });

    toast("Student added to the roster.");
    await loadStudents();
  } catch (error) {
    if (!error.cancelled) formMessage("studentAddMessage", error.message);
  }
}

async function importStudents(button) {
  const text = $("importText").value;

  if (!text.trim()) throw new Error("Choose a file or paste at least one line first.");

  await withBusy(button, async () => {
    const result = await call("POST", "/api/admin/students/import", { csv: text });

    $("importResult").innerHTML = `
      <p class="${result.skipped ? "alert alert--warning" : "alert alert--ok"}">
        ${escapeHtml(result.added)} added, ${escapeHtml(result.skipped)} skipped.
      </p>
      ${result.problems.length
        ? `<ul class="diff-list">${result.problems.map((problem) => `<li>Line ${escapeHtml(problem.line)}: ${escapeHtml(problem.reason)}</li>`).join("")}</ul>`
        : ""}`;

    if (result.added) {
      $("importText").value = "";
      $("importFile").value = "";
    }

    await loadStudents();
  });
}

/* ====================================================================== */
/* 3d. Candidates                                                           */
/* ====================================================================== */

async function enterCandidates() {
  const body = $("body-candidates");

  if (!state.built.has("candidates")) {
    state.built.add("candidates");

    body.innerHTML = `
      <div class="admin-panel" id="candidateLock" hidden></div>
      <div id="officeList"></div>

      <div class="admin-panel" id="addOfficePanel" hidden>
        <h3>Add a position</h3>
        <p class="muted">Every position needs at least one approved candidate to appear on the ballot.</p>
        <form id="addOfficeForm" novalidate>
          <div class="admin-form-grid">
            <div><label for="newOffice">Position (for example President)</label><input id="newOffice" type="text" maxlength="120" autocomplete="off" /></div>
            <div><label for="newCandidate">First candidate's name</label><input id="newCandidate" type="text" maxlength="120" autocomplete="off" /></div>
          </div>
          <div class="admin-form-grid">
            <div><label for="newPhotoUrl">Photo link (optional)</label><input id="newPhotoUrl" type="url" placeholder="https://…" autocomplete="off" /></div>
            <div><label for="newPhotoFile">…or upload a photo (optional)</label><input id="newPhotoFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" /></div>
          </div>
          <p class="form-message" id="addOfficeMessage" role="alert"></p>
          <div class="admin-controls"><button class="button primary" type="submit">Add position</button></div>
        </form>
      </div>`;

    $("addOfficeForm").addEventListener("submit", addOffice);

    onAct($("officeList"), {
      "add-candidate": addCandidate,
      "toggle-candidate": async (button) => {
        const result = await call("POST", `/api/admin/candidates/${button.dataset.id}/toggle`, {});

        toast(result.status === "approved" ? "Candidate approved for the ballot." : "Candidate set to pending (not on the ballot).");
        await loadOffices();
      },
      "remove-candidate": async (button) => {
        const sure = await confirmDialog({
          title: "Remove this candidate?",
          body: `${button.dataset.name} will be removed from the ballot.`,
          confirmText: "Remove",
          danger: true
        });

        if (!sure) return;

        await call("DELETE", `/api/admin/candidates/${button.dataset.id}`);
        toast("Candidate removed.");
        await loadOffices();
      },
      "remove-office": async (button) => {
        const sure = await confirmDialog({
          title: "Remove this position?",
          body: `"${button.dataset.name}" and all of its candidates will be removed.`,
          confirmText: "Remove position",
          danger: true
        });

        if (!sure) return;

        await call("DELETE", `/api/admin/offices/${button.dataset.id}`);
        toast("Position removed.");
        await loadOffices();
      }
    });
  }

  await loadOffices();
}

async function loadOffices() {
  const data = await call("GET", "/api/admin/election");

  state.election = data.election;
  renderOffices(data);
}

function candidateThumb(candidate) {
  const initials = candidate.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join("");

  return `<span class="candidate-thumb">${
    candidate.photoUrl ? `<img src="${escapeHtml(candidate.photoUrl)}" alt="" loading="lazy" />` : escapeHtml(initials)
  }</span>`;
}

function renderOffices(data) {
  const mayEdit = can("election.manage") && !data.lock;
  const lockBox = $("candidateLock");

  lockBox.hidden = !data.lock;
  lockBox.innerHTML = data.lock ? `<strong>Candidate list locked.</strong> ${escapeHtml(data.lock)}` : "";
  $("addOfficePanel").hidden = !mayEdit;

  if (!data.offices.length) {
    $("officeList").innerHTML = `<div class="admin-panel"><p class="admin-table-empty">No positions yet.${mayEdit ? " Add the first one below." : ""}</p></div>`;
    return;
  }

  $("officeList").innerHTML = data.offices
    .map((office) => `
      <div class="admin-panel office-panel" data-office="${office.id}">
        <div class="admin-panel-heading">
          <h3>${escapeHtml(office.office)}</h3>
          <span class="small-print">${office.candidates.length} candidate${office.candidates.length === 1 ? "" : "s"}</span>
        </div>

        ${tableHtml({
          head: ["Candidate", "On the ballot", ...(mayEdit ? ["Actions"] : [])],
          empty: "No candidates in this position yet.",
          rows: office.candidates.map((candidate) => [
            `${candidateThumb(candidate)}${escapeHtml(candidate.name)}`,
            candidate.status === "approved" ? pill("Approved", "approved") : pill("Pending — hidden", "pending"),
            ...(mayEdit ? [`
              <div class="row-actions">
                <button type="button" data-act="toggle-candidate" data-id="${candidate.id}">${candidate.status === "approved" ? "Make pending" : "Approve"}</button>
                <button type="button" class="danger" data-act="remove-candidate" data-id="${candidate.id}" data-name="${escapeHtml(candidate.name)}">Remove</button>
              </div>`] : [])
          ])
        })}

        ${mayEdit ? `
        <div class="office-add">
          <div><label>Add a candidate<input data-field="name" type="text" maxlength="120" placeholder="Full name" autocomplete="off" /></label></div>
          <div><label>Photo link (optional)<input data-field="url" type="url" placeholder="https://…" autocomplete="off" /></label></div>
          <div><label>…or upload<input data-field="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" /></label></div>
          <button class="button primary small" type="button" data-act="add-candidate" data-id="${office.id}">Add</button>
        </div>
        <div class="admin-controls">
          <button class="button secondary small danger" type="button" data-act="remove-office" data-id="${office.id}" data-name="${escapeHtml(office.office)}">Remove this position</button>
        </div>` : ""}
      </div>`)
    .join("");
}

async function photoFrom(urlInput, fileInput) {
  const file = fileInput.files && fileInput.files[0];

  if (file) return pictureToDataUrl(file);
  return urlInput.value.trim();
}

async function addCandidate(button) {
  const panel = button.closest(".office-panel");
  const name = qs("[data-field='name']", panel).value.trim();

  if (name.length < 2) throw new Error("Type the candidate's full name first.");

  await withBusy(button, async () => {
    const photoUrl = await photoFrom(qs("[data-field='url']", panel), qs("[data-field='file']", panel));

    await call("POST", `/api/admin/offices/${button.dataset.id}/candidates`, { name, photoUrl });
    toast("Candidate added.");
    await loadOffices();
  });
}

async function addOffice(event) {
  event.preventDefault();
  formMessage("addOfficeMessage", "");

  const office = $("newOffice").value.trim();
  const candidate = $("newCandidate").value.trim();

  if (office.length < 2 || candidate.length < 2) {
    return formMessage("addOfficeMessage", "Give the position and the first candidate a name.");
  }

  try {
    const photoUrl = await photoFrom($("newPhotoUrl"), $("newPhotoFile"));

    await call("POST", "/api/admin/offices", { office, candidate, photoUrl });

    ["newOffice", "newCandidate", "newPhotoUrl", "newPhotoFile"].forEach((id) => {
      $(id).value = "";
    });

    toast("Position added.");
    await loadOffices();
  } catch (error) {
    if (!error.cancelled) formMessage("addOfficeMessage", error.message);
  }
}

/* ====================================================================== */
/* 4a. Voting Statistics                                                    */
/* ====================================================================== */

function applyBarWidths(container) {
  qsa("[data-w]", container).forEach((bar) => {
    bar.style.width = `${Math.max(0, Math.min(100, Number(bar.dataset.w) || 0))}%`;
  });
}

/* "2026-10-11T14" (UTC) → the viewer's own clock */
function hourLabel(hour) {
  const date = new Date(`${hour}:00:00Z`);

  return Number.isNaN(date.getTime())
    ? hour
    : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric" });
}

function barRows(rows, extraClass = "") {
  if (!rows.length) return `<p class="admin-table-empty">Nothing recorded yet.</p>`;

  const top = Math.max(1, ...rows.map((row) => row.value));

  return rows
    .map((row) => `
      <div class="hbar ${extraClass}">
        <span class="hbar-label">${escapeHtml(row.label)}</span>
        <span class="hbar-track"><i data-w="${((row.value / top) * 100).toFixed(1)}"></i></span>
        <span class="hbar-value">${escapeHtml(row.value)}</span>
      </div>`)
    .join("");
}

async function enterStatistics() {
  const body = $("body-statistics");

  if (!state.built.has("statistics")) {
    state.built.add("statistics");

    body.innerHTML = `
      <div class="stat-grid" id="statCards"></div>

      <div class="admin-panel">
        <h3>How far students have got</h3>
        <div class="hbars" id="funnelBars"></div>
      </div>

      <div class="admin-panel">
        <h3>Votes cast per hour</h3>
        <p class="muted">Hours are in your own time zone. Only hourly totals are kept; there is no list of who voted when.</p>
        <div class="hbars" id="hourlyBars"></div>
      </div>

      <div class="admin-panel">
        <h3>Registrations and verifications per hour</h3>
        <p class="small-note">Registered = accepted the rules. Verified = confirmed the e-mail code.</p>
        <div class="hbars" id="registeredBars"></div>
        <div class="hbars" id="verifiedBars"></div>
      </div>`;
  }

  await pollStatistics();
}

async function pollStatistics() {
  const data = await call("GET", "/api/admin/statistics", undefined, { passive: true });

  $("statCards").innerHTML = [
    statCard("On the roster", data.total, `${data.active} allowed to vote`),
    statCard("Registered", data.registered, "accepted the rules"),
    statCard("Verified", data.verified, "confirmed their e-mail code"),
    statCard("Voted", data.voted),
    statCard("Turnout", data.turnoutPercent === null ? "—" : `${data.turnoutPercent}%`, data.turnoutPercent === null ? "open roster" : "of eligible students")
  ].join("");

  $("funnelBars").innerHTML = barRows([
    { label: "On the roster", value: data.total },
    { label: "Registered", value: data.registered },
    { label: "Verified", value: data.verified },
    { label: "Voted", value: data.voted }
  ]);

  $("hourlyBars").innerHTML = barRows(data.hourly.map((row) => ({ label: hourLabel(row.hour), value: row.voted })));

  $("registeredBars").innerHTML =
    `<p class="small-note"><strong>Registered</strong></p>` +
    barRows(data.registeredByHour.map((row) => ({ label: hourLabel(row.hour), value: row.count })), "hbar--registered");

  $("verifiedBars").innerHTML =
    `<p class="small-note"><strong>Verified</strong></p>` +
    barRows(data.verifiedByHour.map((row) => ({ label: hourLabel(row.hour), value: row.count })), "hbar--verified");

  ["funnelBars", "hourlyBars", "registeredBars", "verifiedBars"].forEach((id) => applyBarWidths($(id)));
}

/* ====================================================================== */
/* 4b. Results and independent verification                                 */
/* ====================================================================== */

const resultsView = { comparisons: [], me: null };

function tallyCards(offices) {
  if (!offices.length) return `<p class="admin-table-empty">There are no positions yet.</p>`;

  return `<div class="results-grid">${offices
    .map((office) => {
      const top = Math.max(0, ...office.candidates.map((candidate) => candidate.votes));
      const leaders = top > 0 ? office.candidates.filter((candidate) => candidate.votes === top) : [];

      const rows = office.candidates
        .map((candidate) => {
          const share = office.totalVotes > 0 ? (candidate.votes / office.totalVotes) * 100 : 0;
          const leading = top > 0 && candidate.votes === top;

          return `
            <div class="result-row${leading ? " result-row--leading" : ""}">
              <div class="result-row-top">
                <span class="result-name">${escapeHtml(candidate.name)}</span>
                <span class="result-count">${candidate.votes} · ${share.toFixed(1)}%</span>
              </div>
              <div class="result-bar"><div class="result-bar-fill" data-w="${share.toFixed(1)}"></div></div>
            </div>`;
        })
        .join("");

      const winnerLine =
        leaders.length === 1 ? `Leading: ${escapeHtml(leaders[0].name)}`
        : leaders.length > 1 ? `Tied: ${leaders.map((leader) => escapeHtml(leader.name)).join(", ")}`
        : "No votes yet";

      return `
        <div class="result-card">
          <h3>${escapeHtml(office.office)}</h3>
          ${rows || `<p class="result-empty">No candidates.</p>`}
          <p class="winner-line">${winnerLine} · ${office.totalVotes} vote${office.totalVotes === 1 ? "" : "s"}</p>
        </div>`;
    })
    .join("")}</div>`;
}

function reportStatusPill(status) {
  return pill(status === "published" ? "Published" : status[0].toUpperCase() + status.slice(1), status);
}

async function enterResults() {
  const body = $("body-results");

  if (!state.built.has("results")) {
    state.built.add("results");

    body.innerHTML = `
      <div class="admin-panel" id="resultsStatusPanel"></div>
      <div id="resultsTally"></div>

      <div class="admin-panel" id="reportsPanel" hidden>
        <div class="admin-panel-heading">
          <h3>Signed tally reports</h3>
          <span id="prepareBox"></span>
        </div>
        <p class="muted">
          Results never go public on one person's say-so. The <strong>Results Officer</strong> prepares and signs a report;
          a <strong>different officer</strong> then approves it, which publishes the totals to students.
          Anyone can download the signed file and check it on another computer.
        </p>
        <div id="reportsTable"></div>
      </div>

      <div class="admin-panel" id="comparePanel" hidden>
        <h3>Supervised comparison with the database</h3>
        <p class="muted">
          Two officials compare the live database against the published report on one screen, one running it and the other
          supervising. Every comparison, match or mismatch, is kept permanently.
        </p>
        <div id="comparisonsTable"></div>
      </div>

      <div class="admin-panel" id="verifyPanel">
        <h3>Check a downloaded report</h3>
        <p class="muted">
          Choose a signed report file. This checks its signatures, its arithmetic and the two-person rule against this
          server's signing key. To check without trusting this server at all, run <span class="mono">node scripts/verify-report.js</span>
          on another computer (see the Operations guide).
        </p>
        <input id="verifyFile" type="file" accept=".json,application/json" />
        <div class="admin-controls">
          <button class="button secondary" type="button" data-act="verify">Check the file</button>
        </div>
        <div id="verifyResult"></div>
      </div>`;

    onAct(body, {
      csv: async () => {
        const name = await download("/api/admin/results/export.csv");
        toast(`Saved ${name}.`);
      },
      prepare: prepareReport,
      approve: approveReport,
      reject: rejectReport,
      download: async (button) => {
        const name = await download(`/api/admin/results/${button.dataset.id}/download`);
        toast(`Saved ${name}.`);
      },
      compare: runComparison,
      details: showComparisonDetails,
      verify: verifyDownloadedReport,
      refresh: () => loadResults()
    });
  }

  await loadResults();
}

async function loadResults() {
  const data = await call("GET", "/api/admin/results");

  resultsView.comparisons = data.comparisons || [];
  resultsView.me = data.me;

  const status = $("resultsStatusPanel");

  if (!data.available) {
    status.innerHTML = `
      <h3>Results are sealed</h3>
      <p class="muted">${escapeHtml(data.reason)}</p>`;

    $("resultsTally").innerHTML = "";
    $("reportsPanel").hidden = true;
    $("comparePanel").hidden = true;
    return;
  }

  status.innerHTML = `
    <div class="admin-panel-heading">
      <h3>${data.provisional ? "Provisional count" : "Final count"}</h3>
      <span>
        ${data.provisional ? pill("Voting not closed", "rehearsal") : pill("Voting closed", "live")}
        ${data.resultsPublished ? pill("Published to students", "published") : pill("Not published yet", "notstarted")}
        ${modePill(data.mode)}
      </span>
    </div>
    <div class="stat-grid">
      ${statCard("Ballots cast", data.ballotsCast)}
      ${statCard("Turnout records", data.turnoutRecords, "must equal ballots cast")}
      ${statCard("Receipts issued", data.receiptsIssued, "must equal ballots cast")}
    </div>
    ${data.problems.length
      ? `<ul class="alert-list">${data.problems.map((problem) => `<li class="alert alert--critical">${escapeHtml(problem)}</li>`).join("")}</ul>`
      : `<p class="alert alert--ok">The counts agree: ballots, turnout records, receipts and every position add up.</p>`}
    <div class="admin-controls">
      <button class="button secondary" type="button" data-act="csv">Download tally (CSV)</button>
      <button class="text-button" type="button" data-act="refresh">Refresh</button>
    </div>`;

  $("resultsTally").innerHTML = tallyCards(data.offices);
  applyBarWidths($("resultsTally"));

  $("reportsPanel").hidden = false;

  $("prepareBox").innerHTML = data.me.canPrepare
    ? data.status === "closed"
      ? `<button class="button primary small" type="button" data-act="prepare">Prepare signed report</button>`
      : `<span class="small-print">Available after voting closes.</span>`
    : "";

  $("reportsTable").innerHTML = tableHtml({
    head: ["Report", "Prepared", "Status", "Approved", "Actions"],
    empty: data.status === "closed" ? "No report has been prepared yet." : "Reports can be prepared once voting has closed.",
    rows: data.reports.map((report) => {
      const mine = report.preparedBy.toLowerCase() === data.me.email.toLowerCase();
      const actions = [`<button type="button" data-act="download" data-id="${report.id}">Download</button>`];

      if (report.status === "pending") {
        if (data.me.canApprove && !mine) {
          actions.push(`<button type="button" data-act="approve" data-id="${report.id}">Approve &amp; publish</button>`);
          actions.push(`<button type="button" class="danger" data-act="reject" data-id="${report.id}">Reject</button>`);
        } else if (mine) {
          actions.push(`<span class="small-print">Waiting for a different officer</span>`);
        }
      }

      if (report.status === "published" && data.me.canCompare) {
        actions.push(`<button type="button" data-act="compare" data-id="${report.id}">Compare with database</button>`);
      }

      return [
        `#${report.id}<br /><span class="mono small-print">${escapeHtml(report.reportHash.slice(0, 12))}…</span>`,
        `${escapeHtml(formatShortTime(report.preparedAt))}<br /><span class="small-print">${escapeHtml(report.preparedBy)}</span>${report.note ? `<br /><span class="small-print">${escapeHtml(report.note)}</span>` : ""}`,
        reportStatusPill(report.status),
        report.approvedBy ? `${escapeHtml(formatShortTime(report.approvedAt))}<br /><span class="small-print">${escapeHtml(report.approvedBy)}</span>` : "—",
        `<div class="row-actions">${actions.join("")}</div>`
      ];
    })
  });

  const publishedExists = data.reports.some((report) => report.status === "published");

  $("comparePanel").hidden = !(publishedExists || resultsView.comparisons.length);

  $("comparisonsTable").innerHTML = tableHtml({
    head: ["When", "Report", "Run by", "Witness", "Outcome", ""],
    empty: "No comparison has been run yet.",
    rows: resultsView.comparisons.map((comparison) => [
      escapeHtml(formatShortTime(comparison.at)),
      `#${comparison.reportId}`,
      escapeHtml(comparison.performedBy),
      escapeHtml(comparison.witnessBy),
      pill(comparison.outcome === "match" ? "Match" : "MISMATCH", comparison.outcome),
      `<div class="row-actions"><button type="button" data-act="details" data-id="${comparison.id}">Details</button></div>`
    ])
  });
}

async function prepareReport(button) {
  const note = await promptDialog({
    title: "Prepare the signed report",
    intro:
      "The server counts every ballot, checks that the totals agree, and signs the report. " +
      "A different officer must approve it before students see any result.",
    label: "Note for the record (optional)",
    confirmText: "Prepare report",
    multiline: false
  });

  if (note === null) return;

  await withBusy(button, async () => {
    const result = await call("POST", "/api/admin/results/prepare", { note });

    toast(`Report #${result.id} prepared and signed. Ask a different officer to approve it.`);
    await loadResults();
  });
}

async function approveReport(button) {
  const sure = await confirmDialog({
    title: "Publish these results?",
    body:
      "Students will see the totals on the voting page. By approving, you confirm that you have reviewed the report " +
      "and that it was prepared by someone else (the two-person rule). This asks for a fresh 2FA code.",
    confirmText: "Approve and publish"
  });

  if (!sure) return;

  await call("POST", `/api/admin/results/${button.dataset.id}/approve`, {});
  toast("Results approved and published.");
  await loadResults();
}

async function rejectReport(button) {
  const reason = await promptDialog({
    title: "Reject this report",
    intro: "Rejecting keeps the report on record but prevents it from being published.",
    label: "Reason (at least 5 characters)",
    confirmText: "Reject report",
    minLength: 5
  });

  if (reason === null) return;

  await call("POST", `/api/admin/results/${button.dataset.id}/reject`, { reason });
  toast("Report rejected.");
  await loadResults();
}

function comparisonOutcomeHtml(outcome) {
  return outcome.outcome === "match"
    ? `<p class="alert alert--ok"><strong>MATCH.</strong> The database agrees with the published report: totals, ballot-box digest and audit-log anchor.</p>`
    : `<p class="alert alert--critical"><strong>MISMATCH.</strong> The database does not agree with the published report. Do not announce anything; open an incident.</p>
       <ul class="diff-list">${outcome.differences.map((difference) => `<li>${escapeHtml(difference)}</li>`).join("")}</ul>`;
}

async function runComparison(button) {
  const reportId = button.dataset.id;

  const outcome = await runDialog("witnessDialog", (dialog, done, signal) => {
    $("witnessIntro").textContent =
      "A second official must supervise. They type their own e-mail, password and current 2FA code here, " +
      "on this screen, while you both watch the result. The witness must be a different person from you.";

    ["witnessEmail", "witnessPassword", "witnessCode"].forEach((id) => {
      $(id).value = "";
    });

    formMessage("witnessMessage", "");
    setTimeout(() => $("witnessEmail").focus(), 30);

    $("witnessForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      formMessage("witnessMessage", "");

      const witnessEmail = $("witnessEmail").value.trim();
      const witnessPassword = $("witnessPassword").value;
      const witnessCode = $("witnessCode").value.trim();

      if (!witnessEmail || !witnessPassword || !witnessCode) {
        return formMessage("witnessMessage", "The witness must fill in all three boxes.");
      }

      await withBusy($("witnessOk"), async () => {
        try {
          done(await call("POST", `/api/admin/results/${reportId}/compare`, { witnessEmail, witnessPassword, witnessCode }));
        } catch (error) {
          if (error.cancelled) return done(null);

          formMessage("witnessMessage", error.message);
          $("witnessPassword").value = "";
          $("witnessCode").value = "";
        }
      });
    }, { signal });

    $("witnessCancel").addEventListener("click", () => done(null), { signal });
  });

  if (!outcome) return;

  await infoDialog("Comparison result", comparisonOutcomeHtml(outcome));
  await loadResults();
}

async function showComparisonDetails(button) {
  const comparison = resultsView.comparisons.find((item) => String(item.id) === button.dataset.id);

  if (!comparison) return;

  await infoDialog(
    `Comparison #${comparison.id}`,
    `<p class="muted">Report #${comparison.reportId} · ${escapeHtml(formatDateTime(comparison.at))} · run by ${escapeHtml(comparison.performedBy)}, witnessed by ${escapeHtml(comparison.witnessBy)}</p>` +
      comparisonOutcomeHtml({ outcome: comparison.outcome, differences: comparison.detail.differences || [] })
  );
}

async function verifyDownloadedReport(button) {
  const text = await readTextFile($("verifyFile").files[0]);

  await withBusy(button, async () => {
    const result = await call("POST", "/api/admin/results/verify", { text });

    $("verifyResult").innerHTML = `
      <p class="${result.ok ? "alert alert--ok" : "alert alert--critical"}">
        <strong>${result.ok ? "All checks passed." : "This file FAILED verification."}</strong>
        Trusted key fingerprint: <span class="mono">${escapeHtml(result.trustedFingerprint)}</span>
      </p>
      <ul class="check-list">
        ${result.checks.map((check) => `
          <li class="check-row check-row--${check.ok ? "ok" : "bad"}">
            <span class="check-mark">${check.ok ? "✓" : "✗"}</span>
            <span>${escapeHtml(check.name)}${check.detail ? `<span class="check-detail">${escapeHtml(check.detail)}</span>` : ""}</span>
          </li>`).join("")}
      </ul>`;
  });
}

/* ====================================================================== */
/* 4c. Notifications                                                        */
/* ====================================================================== */

/* Ready-made wording for the student communication plan (edit before posting). */
const NOTICE_TEMPLATES = [
  ["Voting is open", "Voting is now open. Log in with your matric number and password, accept the election rules, then enter the 6-digit code sent to your university e-mail."],
  ["Closing soon", "Voting closes soon. If you have not voted yet, please do so now. Check your university e-mail for your 6-digit code."],
  ["Code is late", "Some e-mail codes are arriving late. Please wait a few minutes before asking for a new code, and check your spam folder."],
  ["Short pause", "Voting is briefly paused while we fix a technical problem. Your progress is safe and nothing has been lost. Please check back shortly."],
  ["Voting extended", "Voting has been extended. The new closing time is shown on this page. Thank you for your patience."],
  ["Results coming", "Voting has closed. Results will be published here once they have been counted and verified by two electoral officers."]
];

const reportsInbox = { filter: "all" };

async function enterNotifications() {
  const body = $("body-notifications");

  if (!state.built.has("notifications")) {
    state.built.add("notifications");

    const mayPost = can("announcements.manage");

    body.innerHTML = `
      <div class="admin-panel">
        <div class="admin-panel-heading"><h3>Notice on the voting page</h3></div>
        <p class="muted" id="noticeCurrent"></p>

        ${mayPost ? `
        <form id="noticeForm" novalidate>
          <label for="noticeText">Write a notice (3–400 characters)</label>
          <textarea id="noticeText" rows="3" maxlength="400"></textarea>
          <p class="field-note"><span id="noticeCount">0</span>/400 · Quick wording for the student communication plan — click one, then edit:</p>
          <div class="chips" id="noticeTemplates">
            ${NOTICE_TEMPLATES.map(([label], index) => `<button class="chip" type="button" data-template="${index}">${escapeHtml(label)}</button>`).join("")}
          </div>
          <p class="form-message" id="noticeMessage" role="alert"></p>
          <div class="admin-controls">
            <button class="button primary" type="submit">Post to the voting page</button>
            <button class="button secondary" type="button" data-act="clear-notice">Remove the current notice</button>
          </div>
        </form>` : `<p class="small-note">Your role can read notices but not post them.</p>`}

        <h3 class="stack-gap">Earlier notices</h3>
        <div id="noticeHistory"></div>
      </div>

      <div class="admin-panel" id="inboxPanel" hidden>
        <div class="admin-panel-heading">
          <h3>Problems reported by students</h3>
          <span class="small-print" id="inboxCount"></span>
        </div>
        <div class="chips" id="inboxFilters">
          ${[["all", "All"], ["new", "New"], ["seen", "Seen"], ["resolved", "Resolved"]]
            .map(([value, label]) => `<button class="chip${value === "all" ? " active" : ""}" type="button" data-filter="${value}">${label}</button>`).join("")}
        </div>
        <div id="inboxTable"></div>
      </div>`;

    if (mayPost) {
      $("noticeForm").addEventListener("submit", postNotice);

      $("noticeText").addEventListener("input", () => {
        $("noticeCount").textContent = $("noticeText").value.length;
      });

      $("noticeTemplates").addEventListener("click", (event) => {
        const chip = event.target.closest("[data-template]");
        if (!chip) return;

        $("noticeText").value = NOTICE_TEMPLATES[Number(chip.dataset.template)][1];
        $("noticeCount").textContent = $("noticeText").value.length;
        $("noticeText").focus();
      });
    }

    $("inboxFilters").addEventListener("click", (event) => {
      const chip = event.target.closest("[data-filter]");
      if (!chip) return;

      reportsInbox.filter = chip.dataset.filter;
      qsa("#inboxFilters .chip").forEach((item) => item.classList.toggle("active", item === chip));
      loadInbox().catch(fail);
    });

    onAct(body, {
      "clear-notice": async () => {
        await call("DELETE", "/api/admin/announcements/current");
        toast("The notice was removed from the voting page.");
        await loadNotices();
      },
      report: async (button) => {
        await call("POST", `/api/admin/student-reports/${button.dataset.id}`, { status: button.dataset.status });
        await loadInbox();
      }
    });
  }

  await loadNotices();
  if (can("reports.view")) await loadInbox();
}

async function loadNotices() {
  const data = await call("GET", "/api/admin/announcements");

  $("noticeCurrent").textContent = data.current
    ? `Showing now: "${data.current.message}" (posted ${formatShortTime(data.current.postedAt)})`
    : "No notice is showing on the voting page right now.";

  $("noticeHistory").innerHTML = tableHtml({
    head: ["Posted", "By", "Notice", ""],
    empty: "No notice has been posted yet.",
    rows: data.history.map((notice) => [
      escapeHtml(formatShortTime(notice.postedAt)),
      escapeHtml(notice.postedBy),
      escapeHtml(notice.message),
      notice.hidden ? pill("Removed", "notstarted") : pill("Showing / latest", "active")
    ])
  });
}

async function postNotice(event) {
  event.preventDefault();
  formMessage("noticeMessage", "");

  const message = $("noticeText").value.trim();

  if (message.length < 3) return formMessage("noticeMessage", "Write at least 3 characters.");

  try {
    await call("POST", "/api/admin/announcements", { message });
    $("noticeText").value = "";
    $("noticeCount").textContent = "0";
    toast("Notice posted. Students will see it on the voting page.");
    await loadNotices();
  } catch (error) {
    if (!error.cancelled) formMessage("noticeMessage", error.message);
  }
}

async function loadInbox() {
  const panel = $("inboxPanel");

  panel.hidden = false;

  const query = reportsInbox.filter === "all" ? "" : `?status=${reportsInbox.filter}`;
  const data = await call("GET", `/api/admin/student-reports${query}`);
  const mayHandle = can("reports.manage");

  $("inboxCount").textContent = `${data.reports.filter((report) => report.status === "new").length} new`;

  $("inboxTable").innerHTML = tableHtml({
    head: ["Received", "Kind", "Message", "Contact", "Status", ...(mayHandle ? ["Actions"] : [])],
    empty: "No reports.",
    rows: data.reports.map((report) => [
      escapeHtml(formatShortTime(report.receivedAt)),
      escapeHtml(report.category),
      `${escapeHtml(report.message)}${report.matric ? `<br /><span class="small-print mono">matric ${escapeHtml(report.matric)}</span>` : ""}`,
      escapeHtml(report.contact || "—"),
      pill(report.status[0].toUpperCase() + report.status.slice(1), report.status),
      ...(mayHandle ? [`
        <div class="row-actions">
          ${report.status !== "seen" ? `<button type="button" data-act="report" data-id="${report.id}" data-status="seen">Mark seen</button>` : ""}
          ${report.status !== "resolved" ? `<button type="button" data-act="report" data-id="${report.id}" data-status="resolved">Resolved</button>` : ""}
        </div>`] : [])
    ])
  });
}

/* ====================================================================== */
/* 4d. Activity / Audit Logs — restricted, and your reading is recorded      */
/* ====================================================================== */

const auditView = { entries: [], nextBeforeId: null, category: "", search: "", voter: "" };

async function enterAudit() {
  const body = $("body-audit");

  if (!state.built.has("audit")) {
    state.built.add("audit");

    body.innerHTML = `
      <div class="admin-panel">
        <p class="alert alert--info">
          <strong>Restricted record.</strong> Everything that happens in the system is written here, but never anyone's choice.
          Every time you open or search this log, your name is recorded. Following one student's trail asks for a fresh 2FA code
          and is always recorded, under an anonymous tag instead of the matric number.
        </p>

        <form id="auditForm" class="inline-form" novalidate>
          <div><label for="auditCategory">Kind of event</label><select id="auditCategory"><option value="">All</option></select></div>
          <div><label for="auditSearch">Words in the message</label><input id="auditSearch" type="text" maxlength="80" autocomplete="off" /></div>
          ${can("audit.view") ? `<div><label for="auditVoter">One student's trail (matric, digits)</label><input id="auditVoter" type="text" inputmode="numeric" maxlength="15" autocomplete="off" /></div>` : ""}
          <button class="button primary" type="submit">Search</button>
        </form>

        <p class="small-note" id="auditHead"></p>
        <div id="auditTable"></div>
        <div class="admin-controls"><button class="button secondary small" id="auditOlder" type="button" data-act="older" hidden>Load older entries</button></div>
      </div>

      <div class="admin-panel">
        <h3>Integrity and oversight</h3>
        <p class="muted">
          Each entry is chained to the one before it, and signed checkpoints are saved at key moments. Verifying recomputes the
          whole chain; any change, deletion or insertion breaks it.
        </p>
        <div class="admin-controls">
          <button class="button primary" type="button" data-act="verify">Verify the whole log now</button>
          <button class="button secondary" type="button" data-act="checkpoints">Signed checkpoints</button>
          <button class="button secondary" type="button" data-act="access">Who has read this log</button>
          ${can("audit.export") ? `<button class="button secondary" type="button" data-act="export">Export the log (file)</button>` : ""}
        </div>
        <div id="auditVerifyResult"></div>
      </div>`;

    $("auditForm").addEventListener("submit", (event) => {
      event.preventDefault();
      auditView.category = $("auditCategory").value;
      auditView.search = $("auditSearch").value.trim();
      auditView.voter = $("auditVoter") ? $("auditVoter").value.trim() : "";

      if (auditView.voter && !/^\d{4,15}$/.test(auditView.voter)) {
        return toast("Type the matric number as digits only.", "error");
      }

      loadAudit(true).catch(fail);
    });

    onAct(body, {
      older: () => loadAudit(false),
      verify: verifyAuditChain,
      checkpoints: showCheckpoints,
      access: showAccessLog,
      export: async () => {
        const name = await download("/api/admin/audit/export");
        toast(`Saved ${name}. Keep it with the signed checkpoint noted in the log.`);
      }
    });
  }

  await loadAudit(true);
}

async function loadAudit(fresh) {
  const params = new URLSearchParams({ limit: "100" });

  if (auditView.category) params.set("category", auditView.category);
  if (auditView.search) params.set("search", auditView.search);
  if (auditView.voter) params.set("voter", auditView.voter);
  if (!fresh && auditView.nextBeforeId) params.set("beforeId", String(auditView.nextBeforeId));

  const data = await call("GET", `/api/admin/audit?${params}`);

  auditView.entries = fresh ? data.entries : auditView.entries.concat(data.entries);
  auditView.nextBeforeId = data.entries.length === 100 ? data.nextBeforeId : null;

  const select = $("auditCategory");

  if (select.options.length !== data.categories.length + 1) {
    const chosen = select.value;

    select.innerHTML =
      `<option value="">All</option>` +
      data.categories.map((row) => `<option value="${escapeHtml(row.category)}">${escapeHtml(row.category)} (${row.n})</option>`).join("");
    select.value = chosen;
  }

  $("auditHead").textContent = `Latest entry #${data.head.id}${data.head.occurredAt ? ` · ${formatDateTime(data.head.occurredAt)}` : ""} · showing ${auditView.entries.length} entries`;

  $("auditTable").innerHTML = tableHtml({
    head: ["#", "Time", "Who", "Kind", "What happened"],
    empty: "No entries match.",
    rows: auditView.entries.map((entry) => [
      `<span class="mono">${entry.id}</span>`,
      escapeHtml(formatShortTime(entry.occurredAt)),
      escapeHtml(entry.actor),
      pill(entry.category, "info"),
      escapeHtml(entry.message)
    ])
  });

  $("auditOlder").hidden = !auditView.nextBeforeId;
}

async function verifyAuditChain(button) {
  await withBusy(button, async () => {
    const result = await call("POST", "/api/admin/audit/verify", {});

    $("auditVerifyResult").innerHTML = result.ok
      ? `<p class="alert alert--ok"><strong>The log is intact.</strong> ${result.entries} entries and ${result.checkpointsChecked} signed checkpoints were re-checked in ${result.durationMs} ms.</p>`
      : `<p class="alert alert--critical"><strong>The log FAILED verification.</strong> Stop, do not publish results, and open an incident.</p>
         <ul class="diff-list">${result.problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>`;
  });
}

async function showCheckpoints() {
  const data = await call("GET", "/api/admin/audit/checkpoints");

  await infoDialog(
    "Signed checkpoints",
    `<p class="muted">Each checkpoint signs the state of the log at one moment. Signing key fingerprint: <span class="mono">${escapeHtml(data.publicKeyFingerprint)}</span></p>` +
      tableHtml({
        head: ["#", "Log entry", "Reason", "When", "Signature"],
        empty: "No checkpoints yet.",
        rows: data.checkpoints.map((checkpoint) => [
          checkpoint.id,
          `#${checkpoint.auditId}`,
          escapeHtml(checkpoint.reason),
          escapeHtml(formatShortTime(checkpoint.createdAt)),
          `<span class="mono">${escapeHtml(checkpoint.signature.slice(0, 16))}…</span>`
        ])
      })
  );
}

async function showAccessLog() {
  const data = await call("GET", "/api/admin/audit/access");

  await infoDialog(
    "Who has read the log",
    tableHtml({
      head: ["When", "Who", "What"],
      empty: "Nobody has opened the log yet.",
      rows: data.entries.map((entry) => [
        escapeHtml(formatShortTime(entry.occurredAt)),
        escapeHtml(entry.actor),
        escapeHtml(entry.message)
      ])
    })
  );
}

/* ====================================================================== */
/* 5a. Settings                                                             */
/* ====================================================================== */

let settingsDirty = false;

function fillSettingsForm(election) {
  $("schoolName").value = election.school || "";

  qsa("input[name='rosterMode']").forEach((radio) => {
    radio.checked = radio.value === election.rosterMode;
    radio.disabled = election.mode === "live" && radio.value === "open";
  });

  settingsDirty = false;
  formMessage("settingsMessage", "");
}

async function enterSettings() {
  const body = $("body-settings");

  if (!state.built.has("settings")) {
    state.built.add("settings");

    body.innerHTML = `
      <div class="admin-panel">
        <h3>School and sign-in</h3>
        <form id="settingsForm" novalidate>
          <label for="schoolName">School name (shown on the voting page)</label>
          <input id="schoolName" type="text" maxlength="150" autocomplete="off" />

          <label id="rosterLabel">Who may sign in to vote</label>
          <div class="status-picker" role="radiogroup" aria-labelledby="rosterLabel">
            <label class="status-option"><input type="radio" name="rosterMode" value="closed" /><span>Closed roster</span></label>
            <label class="status-option"><input type="radio" name="rosterMode" value="open" /><span>Open roster (rehearsal only)</span></label>
          </div>
          <p class="field-note">
            <strong>Closed roster</strong>: only students on the roster list (and not disabled) can sign in. A live election always uses this.
            <strong>Open roster</strong>: any valid matric number can sign in — useful only for rehearsals.
            Changing it asks for a fresh 2FA code.
          </p>

          <p class="form-message" id="settingsMessage" role="alert"></p>
          <div class="admin-controls">
            <button class="button primary" id="settingsSave" type="submit">Save settings</button>
            <button class="button secondary" id="settingsDiscard" type="button">Discard changes</button>
          </div>
        </form>
      </div>`;

    $("settingsForm").addEventListener("input", () => {
      settingsDirty = true;
    });

    $("settingsForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      formMessage("settingsMessage", "");

      const chosen = qs("input[name='rosterMode']:checked");

      await withBusy($("settingsSave"), async () => {
        try {
          const result = await call("PUT", "/api/admin/settings", {
            schoolName: $("schoolName").value.trim(),
            rosterMode: chosen ? chosen.value : undefined
          });

          state.election = result.election;
          fillSettingsForm(result.election);
          toast("Settings saved.");
        } catch (error) {
          if (!error.cancelled) formMessage("settingsMessage", error.message);
        }
      });
    });

    $("settingsDiscard").addEventListener("click", () => {
      if (state.election) fillSettingsForm(state.election);
      toast("Changes discarded.");
    });
  }

  const data = await call("GET", "/api/admin/election");

  state.election = data.election;
  if (!settingsDirty) fillSettingsForm(data.election);
}

/* ====================================================================== */
/* 5b. Administrators                                                       */
/* ====================================================================== */

const adminsView = { roles: [], admins: [] };

function adminStatusPill(admin) {
  if (admin.disabled) return pill("Disabled", "disabled");
  if (admin.locked) return pill(`Locked until ${new Date(admin.lockedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, "fail");
  return pill("Active", "active");
}

async function enterAdmins() {
  const body = $("body-admins");

  if (!state.built.has("admins")) {
    state.built.add("admins");

    const mayManage = can("admins.manage");

    body.innerHTML = `
      <div class="admin-panel" id="adminFrozen" hidden>
        <p class="alert alert--warning">
          <strong>Frozen.</strong> While live results are being counted and verified, the web page cannot change the Electoral
          Officer's or Results Officer's account. If someone is locked out, the Technical Support Officer can recover the account
          from the server (see the Operations guide).
        </p>
      </div>

      <div class="admin-panel">
        <div class="admin-panel-heading">
          <h3>Administrator accounts</h3>
          <span class="small-print" id="adminPolicy"></span>
        </div>
        <div id="adminTable"></div>
      </div>

      ${mayManage ? `
      <div class="admin-panel">
        <h3>Add an administrator</h3>
        <p class="muted">The new person receives a one-time password. At first sign-in they choose their own password and set up two-factor sign-in.</p>
        <form id="adminAddForm" class="inline-form" novalidate>
          <div><label for="newAdminEmail">E-mail</label><input id="newAdminEmail" type="email" autocomplete="off" /></div>
          <div><label for="newAdminName">Full name</label><input id="newAdminName" type="text" maxlength="120" autocomplete="off" /></div>
          <div><label for="newAdminRole">Role</label><select id="newAdminRole"></select></div>
          <button class="button primary" type="submit">Create account</button>
        </form>
        <p class="form-message" id="adminAddMessage" role="alert"></p>
      </div>

      <div class="admin-panel">
        <h3>Password-reset codes</h3>
        <div id="resetsTable"></div>
      </div>` : ""}

      <div class="admin-panel">
        <h3>What each role can do</h3>
        <div id="rolesTable"></div>
      </div>`;

    if (mayManage) $("adminAddForm").addEventListener("submit", createAdmin);

    body.addEventListener("change", async (event) => {
      const select = event.target.closest("select[data-role-for]");
      if (!select) return;

      try {
        await changeRole(select);
      } catch (error) {
        fail(error);
      }

      await loadAdmins();
    });

    onAct(body, {
      unlock: async (button) => {
        await call("POST", `/api/admin/admins/${button.dataset.id}/unlock`, {});
        toast("Account unlocked.");
        await loadAdmins();
      },
      disable: async (button) => {
        const disabling = button.dataset.disabled !== "true";
        const sure = await confirmDialog({
          title: disabling ? "Disable this account?" : "Enable this account?",
          body: disabling
            ? `${button.dataset.name} will be signed out and unable to sign in until you enable the account again.`
            : `${button.dataset.name} will be able to sign in again.`,
          confirmText: disabling ? "Disable" : "Enable",
          danger: disabling
        });

        if (!sure) return;

        await call("POST", `/api/admin/admins/${button.dataset.id}/disable`, { disabled: disabling });
        toast(disabling ? "Account disabled." : "Account enabled.");
        await loadAdmins();
      },
      "reset-password": async (button) => {
        const sure = await confirmDialog({
          title: "Issue a password-reset code?",
          body: `${button.dataset.name} will get a one-time code to choose a new password. Their current sessions end. You must give them the code in person.`,
          confirmText: "Issue code"
        });

        if (!sure) return;

        const result = await call("POST", `/api/admin/admins/${button.dataset.id}/reset-password`, {});

        await secretDialog({
          title: "One-time reset code",
          intro: result.notice,
          text: result.code,
          note: `Valid until ${formatDateTime(result.expiresAt)}.`
        });

        await loadAdmins();
      },
      "reset-2fa": async (button) => {
        const sure = await confirmDialog({
          title: "Reset two-factor sign-in?",
          body: `${button.dataset.name} will lose their authenticator link and recovery codes, be signed out, and must set up two-factor again at next sign-in.`,
          confirmText: "Reset 2FA",
          danger: true
        });

        if (!sure) return;

        const result = await call("POST", `/api/admin/admins/${button.dataset.id}/reset-2fa`, {});

        toast(result.notice);
        await loadAdmins();
      },
      history: async (button) => {
        const data = await call("GET", `/api/admin/admins/${button.dataset.id}/history`);

        await infoDialog(
          `Sign-in history — ${data.email}`,
          tableHtml({
            head: ["When", "Outcome", "From", "Detail"],
            empty: "No sign-in attempts yet.",
            rows: data.history.map((entry) => [
              escapeHtml(formatShortTime(entry.at)),
              escapeHtml(entry.outcome),
              `<span class="mono">${escapeHtml(entry.ip || "—")}</span>`,
              escapeHtml(entry.detail || "")
            ])
          })
        );
      }
    });
  }

  await loadAdmins();
}

async function loadAdmins() {
  const data = await call("GET", "/api/admin/admins");
  const mayManage = can("admins.manage");

  adminsView.roles = data.roles;
  adminsView.admins = data.admins;

  $("adminFrozen").hidden = !data.frozen;

  $("adminPolicy").textContent =
    `Lock-out: ${data.policy.lockoutAttempts} wrong attempts → ${data.policy.lockoutMinutes} minutes · reset codes last ${data.policy.resetCodeMinutes} minutes`;

  $("adminTable").innerHTML = tableHtml({
    head: ["Person", "Role", "Two-factor", "Status", "Last sign-in", ...(mayManage ? ["Actions"] : [])],
    rows: data.admins.map((admin) => {
      const itsMe = state.admin && admin.id === state.admin.id;

      return [
        `<strong>${escapeHtml(admin.displayName)}</strong>${itsMe ? " (you)" : ""}<br /><span class="small-print">${escapeHtml(admin.email)}</span>`,
        mayManage && !itsMe
          ? `<select data-role-for="${admin.id}" data-name="${escapeHtml(admin.displayName)}" aria-label="Role of ${escapeHtml(admin.displayName)}">
              ${data.roles.map((role) => `<option value="${escapeHtml(role.key)}"${role.key === admin.role ? " selected" : ""}>${escapeHtml(role.label)}</option>`).join("")}
            </select>`
          : escapeHtml(admin.roleLabel),
        admin.mustChangePassword ? pill("Password not chosen yet", "pending") : admin.totpEnabled ? pill("On", "yes") : pill("Not set up", "pending"),
        adminStatusPill(admin),
        `${escapeHtml(admin.lastLoginAt ? agoText(admin.lastLoginAt) : "never")}<br /><span class="small-print">${admin.activeSessions} active session${admin.activeSessions === 1 ? "" : "s"}</span>`,
        ...(mayManage ? [`
          <div class="row-actions">
            ${admin.locked ? `<button type="button" data-act="unlock" data-id="${admin.id}">Unlock</button>` : ""}
            ${itsMe ? "" : `<button type="button" data-act="disable" data-id="${admin.id}" data-name="${escapeHtml(admin.displayName)}" data-disabled="${admin.disabled}">${admin.disabled ? "Enable" : "Disable"}</button>`}
            ${itsMe ? "" : `<button type="button" data-act="reset-password" data-id="${admin.id}" data-name="${escapeHtml(admin.displayName)}">Reset password</button>`}
            ${itsMe ? "" : `<button type="button" class="danger" data-act="reset-2fa" data-id="${admin.id}" data-name="${escapeHtml(admin.displayName)}">Reset 2FA</button>`}
            <button type="button" data-act="history" data-id="${admin.id}">History</button>
          </div>`] : [`<div class="row-actions"><button type="button" data-act="history" data-id="${admin.id}">History</button></div>`])
      ];
    })
  });

  if (mayManage) {
    const select = $("newAdminRole");

    if (select && select.options.length !== data.roles.length) {
      select.innerHTML = data.roles.map((role) => `<option value="${escapeHtml(role.key)}">${escapeHtml(role.label)}</option>`).join("");
    }

    $("resetsTable").innerHTML = tableHtml({
      head: ["For", "Issued by", "Issued", "Expires", "Status"],
      empty: "No reset codes have been issued.",
      rows: data.resets.map((reset) => [
        escapeHtml(reset.adminEmail),
        escapeHtml(reset.issuedBy),
        escapeHtml(formatShortTime(reset.issuedAt)),
        escapeHtml(formatShortTime(reset.expiresAt)),
        pill(reset.status, reset.status === "used" ? "ok" : reset.status === "active" || reset.status === "pending" ? "pending" : "notstarted")
      ])
    });
  }

  $("rolesTable").innerHTML = tableHtml({
    head: ["Role", "Duties"],
    rows: data.roles.map((role) => [
      `<strong>${escapeHtml(role.label)}</strong>`,
      `${escapeHtml(role.summary)}<br /><span class="small-print">${role.permissions.length} permissions</span>`
    ])
  });
}

async function changeRole(select) {
  const sure = await confirmDialog({
    title: "Change this person's role?",
    body: `${select.dataset.name} will get the permissions of the new role straight away, and their sessions are signed out. This asks for a fresh 2FA code.`,
    confirmText: "Change role"
  });

  if (!sure) return;

  await call("POST", `/api/admin/admins/${select.dataset.roleFor}/role`, { role: select.value });
  toast("Role changed.");
}

async function createAdmin(event) {
  event.preventDefault();
  formMessage("adminAddMessage", "");

  const email = $("newAdminEmail").value.trim();
  const displayName = $("newAdminName").value.trim();
  const role = $("newAdminRole").value;

  if (!email || !displayName) return formMessage("adminAddMessage", "Fill in the e-mail and the name.");

  try {
    const result = await call("POST", "/api/admin/admins", { email, displayName, role });

    $("newAdminEmail").value = "";
    $("newAdminName").value = "";

    await secretDialog({
      title: "Temporary password",
      intro: result.notice,
      text: result.temporaryPassword,
      note: `Account created for ${result.admin.email}.`
    });

    await loadAdmins();
  } catch (error) {
    if (!error.cancelled) formMessage("adminAddMessage", error.message);
  }
}

/* ====================================================================== */
/* 5c. Operations                                                           */
/* ====================================================================== */

const HEALTH_TEXT = { ok: "All good", attention: "Needs attention", critical: "Critical" };

async function enterOps() {
  const body = $("body-ops");

  if (!state.built.has("ops")) {
    state.built.add("ops");

    const mayManage = can("ops.manage");
    const mayIncident = can("incidents.manage");

    body.innerHTML = `
      <div class="admin-panel">
        <div class="admin-panel-heading">
          <h3>Monitoring</h3>
          <span id="opsHealthPill"></span>
        </div>
        <ul class="alert-list" id="opsAlerts"></ul>
        <div class="stat-grid ops-metrics" id="opsMetrics"></div>
        <p class="small-note" id="opsUpdated"></p>
      </div>

      <div class="admin-panel">
        <div class="admin-panel-heading">
          <h3>Go-live checklist</h3>
          <span id="opsReadyPill"></span>
        </div>
        <div id="opsReadiness"></div>
      </div>

      <div class="admin-panel">
        <div class="admin-panel-heading">
          <h3>Encrypted backups</h3>
          ${mayManage ? `<span class="row-actions">
            <button class="button primary small" type="button" data-act="backup">Back up now</button>
            <button class="button secondary small" type="button" data-act="drill">Test a restore now</button>
          </span>` : ""}
        </div>
        <p class="muted" id="backupFacts"></p>
        <div id="backupsTable"></div>
      </div>

      <div class="admin-panel">
        <h3>Restoration drills</h3>
        <p class="muted">A backup is only trusted once it has been restored somewhere safe and checked. Drills do exactly that, on a scratch copy.</p>
        <div id="drillsTable"></div>
      </div>

      <div class="admin-panel">
        <div class="admin-panel-heading">
          <h3>Read-only audit copy</h3>
          ${mayManage ? `<button class="button secondary small" type="button" data-act="auditcopy">Make a copy now</button>` : ""}
        </div>
        <p class="muted">
          A separate copy for post-election review. It contains the audit log, the ballot box and the results — and no student list,
          no passwords, no sessions and no 2FA secrets.
        </p>
        <div id="auditCopiesTable"></div>
      </div>

      ${mayManage ? `
      <div class="admin-panel">
        <h3>Send a test e-mail</h3>
        <p class="muted">Proves the server can deliver verification codes. Send it to a real mailbox and confirm it arrives.</p>
        <form id="testMailForm" class="inline-form" novalidate>
          <div><label for="testMailTo">Send to</label><input id="testMailTo" type="email" autocomplete="off" /></div>
          <button class="button primary" id="testMailSend" type="submit">Send test e-mail</button>
        </form>
        <p class="form-message" id="testMailMessage" role="status"></p>
      </div>` : ""}

      <div class="admin-panel">
        <div class="admin-panel-heading"><h3>Incidents</h3><span class="small-print" id="incidentCount"></span></div>
        ${mayIncident ? `
        <form id="incidentForm" novalidate>
          <div class="admin-form-grid">
            <div><label for="incidentSeverity">How serious?</label>
              <select id="incidentSeverity"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="critical">Critical</option></select>
            </div>
            <div><label for="incidentTitle">Short title</label><input id="incidentTitle" type="text" maxlength="120" autocomplete="off" /></div>
          </div>
          <label for="incidentDetails">What happened?</label>
          <textarea id="incidentDetails" rows="3" maxlength="2000"></textarea>
          <p class="field-note">Do not type students' matric numbers or anything about their choices.</p>
          <p class="form-message" id="incidentMessage" role="alert"></p>
          <div class="admin-controls"><button class="button primary" type="submit">Open incident</button></div>
        </form>` : ""}
        <div id="incidentList"></div>
      </div>

      <div class="admin-panel">
        <h3>While voting is open — what to watch</h3>
        <ul class="runbook">
          <li>Keep this page open. The monitoring panel refreshes by itself every 15 seconds.</li>
          <li>Votes per hour should rise steadily. A sudden stop usually means a network or e-mail problem — check "E-mail failures".</li>
          <li>Many wrong passwords or wrong codes from one place can be guessing: see "Rate-limit blocks" and the audit log.</li>
          <li>Post a notice (Notifications) as soon as students are affected, then open an incident here.</li>
          <li>Never restart the server or restore a backup during voting without the Electoral Officer's agreement; both are recorded.</li>
          <li>Full procedures, student messages and the incident contact list are in <span class="mono">docs/OPERATIONS.md</span>.</li>
        </ul>
      </div>`;

    if (mayManage) $("testMailForm").addEventListener("submit", sendTestEmail);
    if (mayIncident) $("incidentForm").addEventListener("submit", openIncident);

    onAct(body, {
      confirm: async (button) => {
        await call("POST", "/api/admin/ops/confirmations", { key: button.dataset.key, confirmed: button.dataset.confirmed !== "true" });
        await loadReadiness();
      },
      golive: goLive,
      backup: async (button) => {
        await withBusy(button, async () => {
          const result = await call("POST", "/api/admin/ops/backup", {});

          toast(`Backup saved (${formatBytes(result.sizeBytes)}).`);
          await loadBackups();
        });
      },
      drill: async (button) => {
        await withBusy(button, async () => {
          const result = await call("POST", "/api/admin/ops/drill", {});

          await showDrillResult(result);
          await loadBackups();
        });
      },
      "drill-details": async (button) => {
        const drill = opsView.drills.find((item) => String(item.id) === button.dataset.id);
        if (drill) await showDrillResult({ ok: drill.status === "pass", file: drill.backupFile, durationMs: drill.durationMs, checks: drill.checks });
      },
      auditcopy: async (button) => {
        await withBusy(button, async () => {
          const result = await call("POST", "/api/admin/ops/audit-copy", {});

          toast(`Audit copy saved (${formatBytes(result.sizeBytes)}).`);
          await loadBackups();
        });
      },
      "get-backup": async (button) => {
        toast(`Saved ${await download(`/api/admin/ops/backups/${encodeURIComponent(button.dataset.file)}${button.dataset.manifest ? "/manifest" : ""}`)}.`);
      },
      "get-copy": async (button) => {
        toast(`Saved ${await download(`/api/admin/ops/audit-copies/${encodeURIComponent(button.dataset.file)}${button.dataset.manifest ? "/manifest" : ""}`)}.`);
      },
      incident: updateIncidentStatus
    });
  }

  await Promise.all([pollOps(), loadReadiness(), loadBackups(), loadIncidents()]);
}

const opsView = { drills: [], incidents: [], readiness: null };

async function pollOps() {
  const health = await call("GET", "/api/admin/ops/health", undefined, { passive: true });

  $("opsHealthPill").innerHTML = pill(HEALTH_TEXT[health.overall] || health.overall, health.overall);
  $("opsAlerts").innerHTML = alertItems(health.alerts);

  const backups = health.backups;
  const lastBackup = backups.lastBackup;

  $("opsMetrics").innerHTML = [
    statCard("Votes this hour", health.turnout.thisHour, `previous hour: ${health.turnout.previousHour}`),
    statCard("Voted so far", health.turnout.voted, `${health.turnout.registered} registered · ${health.turnout.verified} verified`),
    statCard("Signed in now", `${health.sessions.voter} students`, `${health.sessions.admin} officers`),
    statCard("Rate-limit blocks", health.traffic.rateLimitBlocksNow, `${health.traffic.rateLimitTrips1h} trips in the last hour`),
    statCard("Wrong passwords (1 h)", health.traffic.voterWrongPassword1h),
    statCard("Wrong e-mail codes (1 h)", health.traffic.otpWrong1h),
    statCard("Officer sign-in failures (1 h)", health.traffic.adminFailures1h),
    statCard("E-mail failures (15 min)", health.traffic.mailFailures15m),
    statCard("Audit log", health.audit.chain.ok ? "Intact" : "BROKEN", `${health.audit.entries} entries · checked ${agoText(health.audit.chain.checkedAt)}`),
    statCard("Database", health.database.integrity.ok ? "Healthy" : "PROBLEM", `${formatBytes(health.database.bytes)} (+${formatBytes(health.database.walBytes)} log)`),
    statCard("Last backup", lastBackup ? agoText(lastBackup.finishedAt || lastBackup.startedAt) : "none yet", `${backups.files} file(s) · ${formatBytes(backups.bytes)}`),
    statCard("Last restore test", backups.lastPassingDrill ? agoText(backups.lastPassingDrill.startedAt) : "never passed"),
    statCard("Open incidents", health.incidents.open, health.incidents.serious ? `${health.incidents.serious} serious` : ""),
    statCard("New student reports", health.reports.unhandled),
    statCard("Server up for", formatDuration(health.server.uptimeSec), `${health.server.environment} · codes by ${health.server.otpMode}`)
  ].join("");

  $("opsUpdated").textContent = `Updated ${formatClockTime(health.generatedAt)}.`;
}

function formatClockTime(iso) {
  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

async function loadReadiness() {
  const data = await call("GET", "/api/admin/ops/readiness");
  const mayConfirm = (can("mode.manage") || can("ops.manage")) && data.mode !== "live";
  const mayGoLive = can("mode.manage") && data.mode === "rehearsal";

  opsView.readiness = data;

  $("opsReadyPill").innerHTML = data.alreadyLive
    ? pill("Already live", "live")
    : data.ready ? pill("Ready to go live", "ok") : pill(`${data.blockers.length} thing${data.blockers.length === 1 ? "" : "s"} to finish`, "attention");

  const confirmationByKey = new Map(data.confirmations.map((item) => [`confirm-${item.key}`, item]));

  $("opsReadiness").innerHTML = `
    <p class="muted">
      ${data.alreadyLive
        ? "The election is already live; this is the record of what was checked."
        : "Going live wipes all rehearsal data, closes the roster and cannot be undone. Every required item must be ticked first. Items marked “recommended” will not block you."}
    </p>
    <ul class="check-list">
      ${data.checks.map((check) => {
        const person = confirmationByKey.get(check.id);

        return `
          <li class="check-row check-row--${check.ok ? "ok" : "bad"}${check.required ? "" : " check-row--optional"}">
            <span class="check-mark">${check.ok ? "✓" : check.required ? "✗" : "!"}</span>
            <span>
              ${escapeHtml(check.label)}${check.required ? "" : ` <span class="small-print">(recommended)</span>`}
              <span class="check-detail">${escapeHtml(check.detail)}</span>
              ${!check.ok && check.fix ? `<span class="check-fix">What to do: ${escapeHtml(check.fix)}</span>` : ""}
              ${person && mayConfirm ? `<span class="check-actions"><button class="button secondary small" type="button" data-act="confirm" data-key="${escapeHtml(person.key)}" data-confirmed="${person.confirmed}">${person.confirmed ? "Un-confirm" : "I confirm this is true"}</button></span>` : ""}
            </span>
          </li>`;
      }).join("")}
    </ul>
    ${mayGoLive ? `
      <div class="admin-controls">
        <button class="button primary danger" type="button" data-act="golive" ${data.ready ? "" : "disabled"}>Go live…</button>
        ${data.ready ? "" : `<span class="small-print">Finish every required item above first.</span>`}
      </div>` : ""}`;
}

async function goLive() {
  const sure = await confirmDialog({
    title: "Go live?",
    body:
      "This starts the REAL election. All rehearsal ballots, receipts and student progress are wiped, the roster is closed, " +
      "voting is set to Upcoming, and the election can never go back to rehearsal. A safety backup is taken first. " +
      "This asks for a fresh 2FA code.",
    confirmText: "Go live",
    danger: true,
    phrase: "GO LIVE"
  });

  if (!sure) return;

  try {
    const result = await call("POST", "/api/admin/go-live", { phrase: "GO LIVE" });

    toast(result.message);
  } catch (error) {
    if (error.cancelled) return;

    if (error.code === "not-ready" && error.data && error.data.blockers) {
      await infoDialog(
        "Not ready yet",
        `<p class="muted">${escapeHtml(error.message)}</p><ul class="diff-list">${error.data.blockers.map((blocker) => `<li>${escapeHtml(blocker.label)}</li>`).join("")}</ul>`
      );
    } else {
      throw error;
    }
  }

  await loadReadiness();
  await pollElection().catch(() => {});
}

async function showDrillResult(result) {
  const checks = result.checks || [];

  await infoDialog(
    result.ok ? "Restoration drill passed" : "Restoration drill FAILED",
    `${result.ok
      ? `<p class="alert alert--ok">The backup was restored on a scratch copy and every check passed${result.durationMs ? ` (${result.durationMs} ms)` : ""}.</p>`
      : `<p class="alert alert--critical">${escapeHtml(result.error || "At least one check failed. Treat this backup as untrusted and make a new one.")}</p>`}
     ${result.file ? `<p class="small-note">Backup tested: <span class="mono">${escapeHtml(result.file)}</span></p>` : ""}
     <ul class="check-list">
       ${checks.map((check) => `
         <li class="check-row check-row--${check.ok ? "ok" : "bad"}">
           <span class="check-mark">${check.ok ? "✓" : "✗"}</span>
           <span>${escapeHtml(check.name)}${check.detail ? `<span class="check-detail">${escapeHtml(check.detail)}</span>` : ""}</span>
         </li>`).join("")}
     </ul>`
  );
}

async function loadBackups() {
  const mayManage = can("ops.manage");
  const mayCopy = can("audit.export");

  const [backups, drills, copies] = await Promise.all([
    call("GET", "/api/admin/ops/backups"),
    call("GET", "/api/admin/ops/drills"),
    call("GET", "/api/admin/ops/audit-copies")
  ]);

  opsView.drills = drills.drills;

  const intervals = backups.status.intervals;

  $("backupFacts").textContent =
    `Automatic: a backup every ${intervals.backupMinutes} minutes, a restore test every ${Math.round(intervals.drillMinutes / 60)} hours, ` +
    `and one more of each when voting closes. ${backups.status.mirrorConfigured ? "A second copy goes to the mirror location." : "No second location is set (BACKUP_MIRROR_DIR)."} ` +
    "Backups are encrypted; they are useless without the master key.";

  $("backupsTable").innerHTML = tableHtml({
    head: ["When", "Why", "Size", "Result", "", ...(mayManage ? ["Download"] : [])],
    empty: "No backup has been made yet.",
    rows: backups.backups.slice(0, 15).map((backup) => [
      escapeHtml(formatShortTime(backup.startedAt)),
      escapeHtml(backup.trigger),
      backup.sizeBytes ? escapeHtml(formatBytes(backup.sizeBytes)) : "—",
      backup.status === "ok" ? pill("OK", "ok") : pill("Failed", "failed"),
      backup.status === "ok"
        ? backup.present ? `<span class="small-print mono">${escapeHtml((backup.sha256 || "").slice(0, 10))}…</span>` : `<span class="small-print">pruned</span>`
        : `<span class="small-print">${escapeHtml(backup.detail || "")}</span>`,
      ...(mayManage ? [backup.present
        ? `<div class="row-actions">
             <button type="button" data-act="get-backup" data-file="${escapeHtml(backup.file)}">Backup</button>
             <button type="button" data-act="get-backup" data-file="${escapeHtml(backup.file)}" data-manifest="1">Manifest</button>
           </div>`
        : "—"] : [])
    ])
  });

  $("drillsTable").innerHTML = tableHtml({
    head: ["When", "Why", "Backup tested", "Result", "Time", ""],
    empty: "No restoration drill has been run yet.",
    rows: drills.drills.slice(0, 10).map((drill) => [
      escapeHtml(formatShortTime(drill.startedAt)),
      escapeHtml(drill.trigger),
      `<span class="small-print mono">${escapeHtml(drill.backupFile || "—")}</span>`,
      pill(drill.status === "pass" ? "Passed" : "FAILED", drill.status === "pass" ? "pass" : "fail"),
      `${drill.durationMs || 0} ms`,
      `<div class="row-actions"><button type="button" data-act="drill-details" data-id="${drill.id}">Details</button></div>`
    ])
  });

  $("auditCopiesTable").innerHTML = tableHtml({
    head: ["Made", "Why", "Size", "Log entry", ...(mayCopy ? ["Download"] : [])],
    empty: "No audit copy has been made yet.",
    rows: copies.copies.slice(0, 10).map((copy) => [
      escapeHtml(formatShortTime(copy.createdAt)),
      escapeHtml(copy.reason),
      escapeHtml(formatBytes(copy.sizeBytes)),
      copy.auditHeadId ? `#${copy.auditHeadId}` : "—",
      ...(mayCopy ? [copy.present
        ? `<div class="row-actions">
             <button type="button" data-act="get-copy" data-file="${escapeHtml(copy.file)}">Copy</button>
             <button type="button" data-act="get-copy" data-file="${escapeHtml(copy.file)}" data-manifest="1">Manifest</button>
           </div>`
        : "pruned"] : [])
    ])
  });
}

async function sendTestEmail(event) {
  event.preventDefault();
  formMessage("testMailMessage", "");

  const to = $("testMailTo").value.trim();

  if (!to) return formMessage("testMailMessage", "Type the address to send the test to.");

  await withBusy($("testMailSend"), async () => {
    try {
      const result = await call("POST", "/api/admin/ops/test-mail", { to });

      formMessage("testMailMessage", result.message, result.via === "smtp");
      await loadReadiness();
    } catch (error) {
      if (!error.cancelled) formMessage("testMailMessage", error.message);
    }
  });
}

async function loadIncidents() {
  const data = await call("GET", "/api/admin/incidents");
  const mayManage = can("incidents.manage");

  opsView.incidents = data.incidents;

  const open = data.incidents.filter((incident) => incident.status !== "resolved").length;

  $("incidentCount").textContent = `${open} open`;

  $("incidentList").innerHTML = tableHtml({
    head: ["#", "Opened", "Severity", "What", "Status", ...(mayManage ? ["Actions"] : [])],
    empty: "No incidents have been recorded.",
    rows: data.incidents.map((incident) => [
      incident.id,
      `${escapeHtml(formatShortTime(incident.openedAt))}<br /><span class="small-print">${escapeHtml(incident.openedBy)}</span>`,
      pill(incident.severity, incident.severity),
      `<strong>${escapeHtml(incident.title)}</strong>${incident.details ? `<br /><span class="small-print">${escapeHtml(incident.details)}</span>` : ""}${incident.resolution ? `<br /><span class="small-print"><em>Resolution:</em> ${escapeHtml(incident.resolution)}</span>` : ""}`,
      pill(incident.status, incident.status === "resolved" ? "resolved" : incident.status === "investigating" ? "investigating" : "new"),
      ...(mayManage ? [incident.status === "resolved" ? "—" : `
        <div class="row-actions">
          ${incident.status === "open" ? `<button type="button" data-act="incident" data-id="${incident.id}" data-status="investigating">Investigating</button>` : ""}
          <button type="button" data-act="incident" data-id="${incident.id}" data-status="resolved">Resolve</button>
        </div>`] : [])
    ])
  });
}

async function openIncident(event) {
  event.preventDefault();
  formMessage("incidentMessage", "");

  const severity = $("incidentSeverity").value;
  const title = $("incidentTitle").value.trim();
  const details = $("incidentDetails").value.trim();

  if (title.length < 5) return formMessage("incidentMessage", "Give the incident a short title (at least 5 characters).");

  try {
    const result = await call("POST", "/api/admin/incidents", { severity, title, details });

    $("incidentTitle").value = "";
    $("incidentDetails").value = "";
    toast(`Incident #${result.id} opened.`);
    await loadIncidents();
  } catch (error) {
    if (!error.cancelled) formMessage("incidentMessage", error.message);
  }
}

async function updateIncidentStatus(button) {
  const status = button.dataset.status;
  let resolution;

  if (status === "resolved") {
    resolution = await promptDialog({
      title: "Resolve this incident",
      intro: "Say briefly what was done, so the record explains itself later.",
      label: "How was it resolved? (at least 5 characters)",
      confirmText: "Mark resolved",
      minLength: 5
    });

    if (resolution === null) return;
  }

  await call("POST", `/api/admin/incidents/${button.dataset.id}`, resolution === undefined ? { status } : { status, resolution });
  await loadIncidents();
}

/* ====================================================================== */
/* 5d. My account                                                           */
/* ====================================================================== */

async function enterAccount() {
  const body = $("body-account");

  if (!state.built.has("account")) {
    state.built.add("account");

    body.innerHTML = `
      <div class="admin-panel">
        <h3>Your account</h3>
        <dl class="kv-grid" id="accountFacts"></dl>
      </div>

      <div class="admin-panel">
        <h3>Change your password</h3>
        <form id="passwordChangeForm" novalidate>
          <div class="admin-form-grid">
            <div><label for="currentPassword">Current password</label><input id="currentPassword" type="password" autocomplete="current-password" /></div>
            <div><label for="changeNewPassword">New password</label><input id="changeNewPassword" type="password" autocomplete="new-password" /></div>
            <div><label for="changeNewPasswordAgain">New password again</label><input id="changeNewPasswordAgain" type="password" autocomplete="new-password" /></div>
          </div>
          <p class="field-note" id="passwordRule"></p>
          <p class="form-message" id="passwordChangeMessage" role="alert"></p>
          <div class="admin-controls"><button class="button primary" id="passwordChangeSave" type="submit">Change password</button></div>
        </form>
      </div>

      <div class="admin-panel">
        <h3>Recovery codes</h3>
        <p class="muted" id="recoveryInfo"></p>
        <div class="admin-controls"><button class="button secondary" type="button" data-act="regenerate">Make new recovery codes</button></div>
      </div>

      <div class="admin-panel">
        <div class="admin-panel-heading">
          <h3>Where you are signed in</h3>
          <button class="button secondary small danger" type="button" data-act="logout-all">Sign out everywhere</button>
        </div>
        <div id="sessionsTable"></div>
      </div>

      <div class="admin-panel">
        <h3>Your recent sign-in attempts</h3>
        <div id="historyTable"></div>
      </div>`;

    $("passwordChangeForm").addEventListener("submit", changePassword);

    onAct(body, {
      regenerate: async () => {
        const sure = await confirmDialog({
          title: "Make new recovery codes?",
          body: "The old codes stop working. The new ones are shown once. This asks for a fresh 2FA code.",
          confirmText: "Make new codes"
        });

        if (!sure) return;

        const result = await call("POST", "/api/admin/recovery-codes/regenerate", {});

        await secretDialog({
          title: "Your new recovery codes",
          intro: result.notice,
          text: result.recoveryCodes.join("\n")
        });

        await loadAccount();
      },
      "logout-all": async () => {
        const sure = await confirmDialog({
          title: "Sign out everywhere?",
          body: "Every device where you are signed in, including this one, will be signed out.",
          confirmText: "Sign out everywhere",
          danger: true
        });

        if (!sure) return;

        await call("POST", "/api/admin/logout-all", {});
        redirectToSignIn("You have been signed out of every device.");
      }
    });
  }

  await loadAccount();
}

async function loadAccount() {
  const data = await call("GET", "/api/admin/security", undefined, { passive: true });
  const admin = data.admin;

  $("accountFacts").innerHTML = `
    <div><dt>Name</dt><dd>${escapeHtml(admin.displayName)}</dd></div>
    <div><dt>E-mail</dt><dd>${escapeHtml(admin.email)}</dd></div>
    <div><dt>Role</dt><dd>${escapeHtml(admin.roleLabel)}</dd></div>
    <div><dt>Two-factor sign-in</dt><dd>${admin.totpEnabled ? "On" : "Not set up"}</dd></div>
    <div><dt>Password last changed</dt><dd>${escapeHtml(formatDateTime(admin.passwordChangedAt))}</dd></div>
    <div><dt>Account created</dt><dd>${escapeHtml(formatDateTime(admin.createdAt))}</dd></div>`;

  $("passwordRule").textContent =
    `At least ${data.policy.minPasswordLength} characters. A long phrase is better than a short complicated word. Changing it signs out your other sessions.`;

  $("recoveryInfo").textContent =
    `You have ${data.recoveryCodesLeft} unused recovery code${data.recoveryCodesLeft === 1 ? "" : "s"}. Each works once if you lose your phone.`;

  $("sessionsTable").innerHTML =
    tableHtml({
      head: ["Device", "From", "Signed in", "Last active", "Ends in", ""],
      rows: data.sessions.map((session) => [
        `<span class="small-print">${escapeHtml((session.device || "unknown").slice(0, 70))}</span>`,
        `<span class="mono">${escapeHtml(session.ip || "—")}</span>`,
        escapeHtml(formatShortTime(session.signedInAt)),
        escapeHtml(agoText(session.lastActiveAt)),
        escapeHtml(formatDuration(session.expiresInSec)),
        session.current ? pill("This device", "yes") : ""
      ])
    }) +
    `<p class="small-note">Sessions end after ${data.policy.idleMinutes} minutes without activity, or ${data.policy.absoluteHours} hours at most.
      After ${data.policy.lockoutAttempts} wrong sign-in attempts an account is locked for ${data.policy.lockoutMinutes} minutes.</p>`;

  $("historyTable").innerHTML = tableHtml({
    head: ["When", "Result", "From", "Detail"],
    empty: "No attempts yet.",
    rows: data.history.map((entry) => [
      escapeHtml(formatShortTime(entry.at)),
      escapeHtml(entry.outcome),
      `<span class="mono">${escapeHtml(entry.ip || "—")}</span>`,
      escapeHtml(entry.detail || "")
    ])
  });
}

async function changePassword(event) {
  event.preventDefault();
  formMessage("passwordChangeMessage", "");

  const currentPassword = $("currentPassword").value;
  const newPassword = $("changeNewPassword").value;
  const again = $("changeNewPasswordAgain").value;

  if (!currentPassword || !newPassword) return formMessage("passwordChangeMessage", "Fill in your current and new password.");
  if (newPassword !== again) return formMessage("passwordChangeMessage", "The two new passwords are not the same.");

  await withBusy($("passwordChangeSave"), async () => {
    try {
      const result = await call("POST", "/api/admin/password", { currentPassword, newPassword });

      ["currentPassword", "changeNewPassword", "changeNewPasswordAgain"].forEach((id) => {
        $(id).value = "";
      });

      formMessage("passwordChangeMessage", result.message, true);
      await loadAccount();
    } catch (error) {
      if (!error.cancelled) formMessage("passwordChangeMessage", error.message);
    }
  });
}

/* ====================================================================== */
/* 5e. Start                                                                */
/* ====================================================================== */

async function start() {
  let described;

  try {
    described = await api("GET", "/api/admin/session");
  } catch (error) {
    return redirectToSignIn();
  }

  if (!applySession(described)) return;

  $("whoName").textContent = state.admin.displayName || state.admin.email;
  $("whoRole").textContent = state.admin.roleLabel;

  state.views = buildViews();
  buildNav();

  $("adminNav").addEventListener("click", (event) => {
    const button = event.target.closest(".admin-nav-button");

    if (!button) return;
    if (button.dataset.action === "logout") return logout();
    if (button.dataset.view) go(button.dataset.view);
  });

  $("sessionStay").addEventListener("click", keepAlive);
  window.addEventListener("popstate", () => showView(window.location.hash.slice(1)));

  tick();
  startBackgroundWork();

  await showView(window.location.hash.slice(1));
}

start();
