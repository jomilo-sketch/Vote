/*
  BOUESTI Vote — the student's voting journey (browser side).

      log in  ->  accept rules  ->  e-mail code  ->  choose  ->  review  ->  submit

  This file only DRAWS the journey. Every decision is made by the server
  (voters.js): which matric numbers are accepted (digits only), which
  password is accepted, whether the student already voted, whether the code
  is right, whether the ballot is valid. A refresh in the middle resumes at
  the right step because the step lives in the server-side session.
*/

"use strict";

const MATRIC_FORMAT = /^\d{4,15}$/;
const STATE_POLL_MS = 45_000;

const $ = (id) => document.getElementById(id);

const panels = document.querySelectorAll(".panel");
const steps = document.querySelectorAll(".step");

const loginForm = $("loginForm");
const identityForm = $("identityForm");
const otpForm = $("otpForm");
const ballotForm = $("ballotForm");

const matricNumber = $("matricNumber");
const password = $("password");
const universityEmail = $("universityEmail");
const otpInput = $("otpInput");

const rulesDialog = $("rulesDialog");
const rulesBody = $("rulesBody");
const agreeRules = $("agreeRules");
const acceptRulesButton = $("acceptRules");
const declineRulesButton = $("declineRules");

const resendButton = $("resendButton");
const voteConfirmation = $("voteConfirmation");

let voterState = null; // what the server says about this session
let lastEmail = ""; // kept in memory only, so "Resend" works; never stored
let currentOffices = [];
let publicState = null;
let otpTimerId = null;
let resendTimerId = null;
let bannerTimeoutId = null;
let dismissedAnnouncementId = null;
let shownResultsAt = null;

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

function showPanel(panelId, activeStep) {
  panels.forEach((panel) => {
    panel.classList.toggle("active-panel", panel.id === panelId);
  });

  steps.forEach((step) => {
    step.classList.toggle("active", Number(step.dataset.step) === activeStep);
  });

  $("votingShell").scrollIntoView({ behavior: "smooth", block: "start" });
}

function showMessage(elementId, text = "") {
  $(elementId).textContent = text;
}

function setBusy(button, busy, busyText) {
  if (!button) return;

  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    if (busyText) button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

function candidatePlaceholder(name) {
  const initials = String(name)
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .slice(0, 2)
    .toUpperCase();

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">
      <rect width="120" height="120" rx="60" fill="#d7e5e7"/>
      <circle cx="60" cy="43" r="21" fill="#7d9a9d"/>
      <path d="M22 109c6-24 22-36 38-36s32 12 38 36" fill="#7d9a9d"/>
      <text x="60" y="111" text-anchor="middle"
        font-family="Arial" font-size="12" font-weight="bold"
        fill="#152f3e">${initials}</text>
    </svg>
  `;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/* ------------------------------------------------------------------ */
/* What the election looks like right now (public, no sign-in needed)   */
/* ------------------------------------------------------------------ */

function statusLine(state) {
  if (state.phase === "open") {
    return state.votingClosesAt
      ? `Voting closes <strong>${escapeHtml(formatShortTime(state.votingClosesAt))}</strong>`
      : "Voting is <strong>open</strong>";
  }

  if (state.phase === "upcoming") {
    return state.votingOpensAt
      ? `Voting opens <strong>${escapeHtml(formatShortTime(state.votingOpensAt))}</strong>`
      : "Voting is <strong>upcoming</strong>";
  }

  return "Voting is <strong>closed</strong>";
}

function applyPublicState(state) {
  publicState = state;

  const open = state.phase === "open";

  $("electionStatusText").innerHTML = statusLine(state);
  $("electionStatusDot").classList.toggle("status-dot--closed", !open);
  $("electionNameEyebrow").textContent = `${state.electionName} · Voting Portal`;
  $("rehearsalBanner").hidden = !state.rehearsal;

  const closedNotice = $("electionClosedNotice");

  if (state.phase === "upcoming") {
    closedNotice.hidden = false;
    closedNotice.textContent =
      "Voting hasn't opened yet for this election. Please check back once the Electoral Committee opens voting.";
  } else if (state.phase === "closed") {
    closedNotice.hidden = false;
    closedNotice.textContent =
      "Voting has closed for this election. Thank you to everyone who participated — results will be announced by the Electoral Committee.";
  } else if (!closedNotice.dataset.sticky) {
    closedNotice.hidden = true;
  }

  // Someone who is not signed in cannot start while voting is not open.
  if (!voterState) {
    loginForm.querySelectorAll("input, button").forEach((element) => {
      element.disabled = !open;
    });
  }

  const banner = $("announcementBanner");
  const note = state.announcement;

  if (note && note.id !== dismissedAnnouncementId) {
    $("announcementText").textContent = note.message;
    banner.hidden = false;
    banner.dataset.id = String(note.id);
  } else {
    banner.hidden = true;
  }

  if (state.resultsPublished) showResults();
  else $("resultsSection").hidden = true;
}

async function refreshPublicState() {
  try {
    applyPublicState(await api("GET", "/api/public/state"));
  } catch (error) {
    /* offline for a moment — keep what is on screen */
  }
}

/* ---------- published results ---------- */

function renderResults(data) {
  $("resultsTitle").textContent = `${data.election.name} — results`;
  $("resultsMeta").textContent =
    `${data.totals.ballotsCast} ballot${data.totals.ballotsCast === 1 ? "" : "s"} counted · published ${formatDateTime(data.publishedAt)}`;

  $("resultsBody").innerHTML = data.offices
    .map((office) => {
      const top = Math.max(0, ...office.candidates.map((candidate) => candidate.votes));

      const rows = office.candidates
        .map((candidate) => {
          const share = office.totalVotes > 0 ? (candidate.votes / office.totalVotes) * 100 : 0;
          const leading = top > 0 && candidate.votes === top;

          return `
            <li class="result-row${leading ? " result-row--leading" : ""}">
              <span class="result-name">${escapeHtml(candidate.name)}${leading ? " <small>★</small>" : ""}</span>
              <span class="result-bar"><i data-share="${share.toFixed(1)}"></i></span>
              <span class="result-votes">${candidate.votes} · ${share.toFixed(1)}%</span>
            </li>`;
        })
        .join("");

      return `
        <div class="result-office">
          <h3>${escapeHtml(office.office)}</h3>
          <ul class="result-rows">${rows}</ul>
        </div>`;
    })
    .join("");

  $("resultsBody").querySelectorAll("[data-share]").forEach((bar) => {
    bar.style.width = `${bar.dataset.share}%`;
  });

  $("resultsSignature").textContent =
    `Signed by the Electoral Committee (${data.signature.algorithm}, key ${data.signature.fingerprint}). ${data.signature.note}`;

  $("resultsSection").hidden = false;
}

async function showResults() {
  try {
    const data = await api("GET", "/api/public/results");

    if (!data.published) {
      $("resultsSection").hidden = true;
      return;
    }

    if (shownResultsAt !== data.publishedAt) {
      shownResultsAt = data.publishedAt;
      renderResults(data);
    }
  } catch (error) {
    /* try again at the next refresh */
  }
}

/* ------------------------------------------------------------------ */
/* Notices on the login panel                                           */
/* ------------------------------------------------------------------ */

function clearLoginNotices() {
  const closedNotice = $("electionClosedNotice");

  $("alreadyVotedNotice").hidden = true;
  $("notEligibleNotice").hidden = true;
  delete closedNotice.dataset.sticky;

  if (publicState) applyPublicState(publicState);
  else closedNotice.hidden = true;
}

function showLoginOutcome(outcome, message) {
  clearLoginNotices();

  if (outcome === "already_voted") {
    $("alreadyVotedText").textContent = message;
    $("alreadyVotedNotice").hidden = false;
  } else if (outcome === "not_eligible") {
    $("notEligibleNotice").textContent = message;
    $("notEligibleNotice").hidden = false;
  } else {
    const closedNotice = $("electionClosedNotice");

    closedNotice.textContent = message;
    closedNotice.hidden = false;
    closedNotice.dataset.sticky = "1";
  }
}

/* ------------------------------------------------------------------ */
/* Starting over (after voting, sign-out, time-out)                      */
/* ------------------------------------------------------------------ */

function stopTimers() {
  clearInterval(otpTimerId);
  clearInterval(resendTimerId);
  otpTimerId = null;
  resendTimerId = null;
}

function resetResendButton() {
  clearInterval(resendTimerId);
  resendButton.disabled = false;
  resendButton.textContent = "Resend code";
}

function resetPortal({ message = "", outcome = "", confirmation = false } = {}) {
  stopTimers();
  resetResendButton();

  voterState = null;
  lastEmail = "";
  currentOffices = [];

  loginForm.reset();
  identityForm.reset();
  otpForm.reset();
  ballotForm.reset();

  $("ballotPositions").innerHTML = "";
  $("reviewList").innerHTML = "";
  $("confirmVote").checked = false;
  $("receiptId").textContent = "";
  $("demoNote").hidden = true;

  agreeRules.checked = false;
  agreeRules.disabled = true;
  acceptRulesButton.disabled = true;

  ["loginMessage", "identityMessage", "otpMessage", "ballotMessage", "reviewMessage", "rulesMessage"].forEach((id) => showMessage(id));

  if (rulesDialog.open) rulesDialog.close();

  clearLoginNotices();
  if (outcome) showLoginOutcome(outcome, message);
  else if (message) showMessage("loginMessage", message);

  if (publicState) applyPublicState(publicState);
  showPanel("loginPanel", 1);

  if (confirmation) {
    voteConfirmation.hidden = false;
    clearTimeout(bannerTimeoutId);
    bannerTimeoutId = setTimeout(() => {
      voteConfirmation.hidden = true;
    }, 8000);

    document.querySelector(".hero").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

/* One place that understands the server's "this journey cannot continue" answers. */
function handleFlowError(error, messageId) {
  if (error.code === "session-ended") {
    resetPortal({ message: "Your session timed out. Please log in again." });
    return true;
  }

  if (error.code === "closed") {
    resetPortal({ message: error.message, outcome: "closed" });
    refreshPublicState();
    return true;
  }

  if (error.code === "already-voted") {
    resetPortal({ message: error.message, outcome: "already_voted" });
    return true;
  }

  if (error.code === "not-eligible") {
    resetPortal({ message: error.message, outcome: "not_eligible" });
    return true;
  }

  showMessage(messageId, error.message);
  return false;
}

/* ------------------------------------------------------------------ */
/* Step 1 — log in                                                      */
/* ------------------------------------------------------------------ */

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  clearLoginNotices();

  const matric = matricNumber.value.trim();

  // Item 1: digits only. The server checks again; this just answers faster.
  if (!MATRIC_FORMAT.test(matric)) {
    showMessage("loginMessage", "Enter your matriculation number as digits only (e.g. 152637) — no letters, spaces or prefix.");
    return;
  }

  showMessage("loginMessage");
  setBusy($("loginButton"), true, "Checking…");

  try {
    const result = await api("POST", "/api/voter/login", { matric, password: password.value });

    password.value = "";

    if (result.outcome !== "signed_in") {
      showLoginOutcome(result.outcome, result.message);
      return;
    }

    applySession(result.state);
    openRulesDialog();
  } catch (error) {
    password.value = "";
    showMessage("loginMessage", error.message);
  } finally {
    setBusy($("loginButton"), false);
  }
});

function applySession(state) {
  voterState = state;
  $("signedInMatric").textContent = state.matric;
}

/* ------------------------------------------------------------------ */
/* Step 2 — election rules (=> registered), then e-mail code (=> verified) */
/* ------------------------------------------------------------------ */

function unlockRulesCheckbox() {
  agreeRules.disabled = false;
}

function checkRulesScroll() {
  if (rulesBody.scrollTop + rulesBody.clientHeight >= rulesBody.scrollHeight - 8) unlockRulesCheckbox();
}

function openRulesDialog() {
  agreeRules.checked = false;
  agreeRules.disabled = true;
  acceptRulesButton.disabled = true;
  showMessage("rulesMessage");

  if (!rulesDialog.open) rulesDialog.showModal();

  requestAnimationFrame(() => {
    rulesBody.scrollTop = 0;
    if (rulesBody.scrollHeight <= rulesBody.clientHeight) unlockRulesCheckbox();
  });
}

rulesBody.addEventListener("scroll", checkRulesScroll);

agreeRules.addEventListener("change", () => {
  acceptRulesButton.disabled = !agreeRules.checked;
});

// The rules must be accepted or declined — Escape does not skip them.
rulesDialog.addEventListener("cancel", (event) => event.preventDefault());

acceptRulesButton.addEventListener("click", async () => {
  if (!agreeRules.checked) {
    showMessage("rulesMessage", "Please confirm you agree to the election rules.");
    return;
  }

  setBusy(acceptRulesButton, true, "Saving…");

  try {
    const result = await api("POST", "/api/voter/rules");

    applySession(result.state);
    rulesDialog.close();
    showPanel("verifyPanel", 2);
    universityEmail.focus();
  } catch (error) {
    if (rulesDialog.open) rulesDialog.close();
    handleFlowError(error, "loginMessage");
  } finally {
    setBusy(acceptRulesButton, false);
  }
});

declineRulesButton.addEventListener("click", async () => {
  try {
    await api("POST", "/api/voter/logout");
  } catch (error) {
    /* the session ends by itself either way */
  }

  resetPortal({ message: "You must accept the election rules before you can vote. Log in again to review them." });
});

$("signOutButton").addEventListener("click", async () => {
  try {
    await api("POST", "/api/voter/logout");
  } catch (error) {
    /* fine */
  }

  resetPortal({ message: "You have been signed out." });
});

/* ---------- e-mail code ---------- */

function startOtpTimers(expiresInSec, resendInSec) {
  stopTimers();

  const expiresAt = Date.now() + expiresInSec * 1000;
  const resendAt = Date.now() + resendInSec * 1000;

  const tickExpiry = () => {
    const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    $("timer").textContent = formatClock(left);

    if (left <= 0) {
      clearInterval(otpTimerId);
      showMessage("otpMessage", "Your OTP has expired. Request a new code.");
    }
  };

  const tickResend = () => {
    const left = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));

    if (left <= 0) {
      resetResendButton();
      return;
    }

    resendButton.disabled = true;
    resendButton.textContent = `Resend code (${left}s)`;
  };

  tickExpiry();
  tickResend();
  otpTimerId = setInterval(tickExpiry, 1000);
  resendTimerId = setInterval(tickResend, 1000);
}

function showOtpPanel(info) {
  $("maskedEmail").textContent = info.maskedEmail;

  const demo = $("demoNote");
  demo.hidden = !info.demoHint;
  demo.textContent = info.demoHint || "";

  startOtpTimers(info.expiresInSec, info.resendInSec);
  showMessage("otpMessage");
  showPanel("otpPanel", 2);
  otpInput.focus();
}

identityForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = universityEmail.value.trim();

  if (!/^[^\s@]+@bouesti\.edu\.ng$/i.test(email)) {
    showMessage("identityMessage", "Use your university-registered @bouesti.edu.ng email address.");
    return;
  }

  showMessage("identityMessage");
  setBusy($("sendCodeButton"), true, "Sending…");

  try {
    const result = await api("POST", "/api/voter/otp/request", { email });

    lastEmail = email;
    applySession(result.state);
    showOtpPanel(result);
  } catch (error) {
    handleFlowError(error, "identityMessage");
  } finally {
    setBusy($("sendCodeButton"), false);
  }
});

otpForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const code = otpInput.value.replace(/\s/g, "");

  if (!/^\d{6}$/.test(code)) {
    showMessage("otpMessage", "Enter the 6-digit code.");
    return;
  }

  setBusy($("verifyButton"), true, "Checking…");

  try {
    const result = await api("POST", "/api/voter/otp/verify", { code });

    applySession(result.state);
    stopTimers();
    showMessage("otpMessage");
    otpInput.value = "";

    await loadBallot();
    showPanel("ballotPanel", 3);
  } catch (error) {
    if (!handleFlowError(error, "otpMessage")) otpInput.select();
  } finally {
    setBusy($("verifyButton"), false);
  }
});

resendButton.addEventListener("click", async () => {
  if (!lastEmail) {
    showPanel("verifyPanel", 2);
    showMessage("identityMessage", "Enter your university email again to receive a new code.");
    return;
  }

  resendButton.disabled = true;

  try {
    const result = await api("POST", "/api/voter/otp/request", { email: lastEmail });

    showOtpPanel(result);
    showMessage("otpMessage", "A fresh code has been sent to your university email.");
  } catch (error) {
    resetResendButton();
    handleFlowError(error, "otpMessage");

    if (error.data && error.data.retryAfterSec) {
      startOtpTimers(0, error.data.retryAfterSec);
    }
  }
});

document.querySelectorAll("[data-back]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.back;
    showPanel(target, target === "verifyPanel" ? 2 : 3);
  });
});

/* ------------------------------------------------------------------ */
/* Step 3 — choose candidates                                           */
/* ------------------------------------------------------------------ */

async function loadBallot() {
  const data = await api("GET", "/api/voter/ballot");

  currentOffices = data.offices;

  $("ballotPositions").innerHTML = currentOffices
    .map((office) => {
      const cards = office.candidates
        .map((candidate) => {
          const photo = candidate.photoUrl || candidatePlaceholder(candidate.name);

          return `
            <label class="candidate">
              <input type="radio" name="office-${office.id}" value="${candidate.id}" required />
              <img class="candidate-photo" src="${escapeHtml(photo)}" alt="Photo of ${escapeHtml(candidate.name)}" />
              <span>
                <strong>${escapeHtml(candidate.name)}</strong>
                <small>BOUESTI student candidate</small>
                ${candidate.photoUrl ? "" : '<small class="photo-note">Official photo slot</small>'}
              </span>
              <i>✓</i>
            </label>`;
        })
        .join("");

      return `
        <fieldset>
          <legend>${escapeHtml(office.office)}</legend>
          <div class="candidate-grid">${cards}</div>
        </fieldset>`;
    })
    .join("");
}

function currentChoices() {
  const form = new FormData(ballotForm);
  const choices = {};

  currentOffices.forEach((office) => {
    const value = form.get(`office-${office.id}`);
    if (value) choices[String(office.id)] = Number(value);
  });

  return choices;
}

ballotForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const choices = currentChoices();
  const missing = currentOffices.find((office) => !choices[String(office.id)]);

  if (missing) {
    showMessage("ballotMessage", `Choose a candidate for ${missing.office}.`);
    return;
  }

  $("reviewList").innerHTML = currentOffices
    .map((office) => {
      const picked = office.candidates.find((candidate) => candidate.id === choices[String(office.id)]);

      return `
        <div>
          <dt>${escapeHtml(office.office)}</dt>
          <dd>${escapeHtml(picked ? picked.name : "")}</dd>
        </div>`;
    })
    .join("");

  showMessage("ballotMessage");
  showPanel("reviewPanel", 4);
});

/* ------------------------------------------------------------------ */
/* Step 4 — submit                                                      */
/* ------------------------------------------------------------------ */

$("submitVote").addEventListener("click", async () => {
  if (!$("confirmVote").checked) {
    showMessage("reviewMessage", "Confirm your choices before submitting your ballot.");
    return;
  }

  showMessage("reviewMessage");
  setBusy($("submitVote"), true, "Submitting…");

  try {
    const result = await api("POST", "/api/voter/vote", { choices: currentChoices() });

    // The server ended the session with the ballot; forget everything here too.
    voterState = null;
    lastEmail = "";
    currentOffices = [];
    $("ballotPositions").innerHTML = "";
    $("reviewList").innerHTML = "";
    $("receiptId").textContent = result.receipt;

    showPanel("successPanel", 4);
  } catch (error) {
    handleFlowError(error, "reviewMessage");
  } finally {
    setBusy($("submitVote"), false);
  }
});

/* Return to the home page: ready for the next student, even on the same device. */
$("returnHomeButton").addEventListener("click", () => {
  resetPortal({ confirmation: true });
  refreshPublicState();
});

$("dismissConfirmation").addEventListener("click", () => {
  voteConfirmation.hidden = true;
  clearTimeout(bannerTimeoutId);
});

$("dismissAnnouncement").addEventListener("click", () => {
  const banner = $("announcementBanner");

  dismissedAnnouncementId = Number(banner.dataset.id) || null;
  banner.hidden = true;
});

/* ------------------------------------------------------------------ */
/* Help: report a problem, check a receipt                               */
/* ------------------------------------------------------------------ */

$("helpButton").addEventListener("click", () => {
  showMessage("problemStatus");
  showMessage("receiptStatus");
  $("helpDialog").showModal();
});

$("closeHelp").addEventListener("click", () => $("helpDialog").close());

$("problemForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = $("problemMessage").value.trim();

  if (message.length < 10) {
    showMessage("problemStatus", "Please describe the problem in a sentence or two.");
    return;
  }

  try {
    const result = await api("POST", "/api/public/problem", {
      category: $("problemCategory").value,
      message,
      contact: $("problemContact").value.trim(),
      matric: voterState ? voterState.matric : ""
    });

    $("problemForm").reset();
    $("problemStatus").classList.add("form-message--ok");
    showMessage("problemStatus", result.message);
  } catch (error) {
    $("problemStatus").classList.remove("form-message--ok");
    showMessage("problemStatus", error.message);
  }
});

$("receiptForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const code = $("receiptInput").value.trim();

  if (code.length < 8) {
    showMessage("receiptStatus", "Enter the receipt ID exactly as shown after voting.");
    return;
  }

  try {
    const result = await api("POST", "/api/public/receipt", { code });

    showMessage(
      "receiptStatus",
      result.found
        ? "Receipt found: a ballot with this receipt was accepted. (Receipts never reveal how anyone voted.)"
        : "No ballot with that receipt was found. Check for typing mistakes."
    );
  } catch (error) {
    showMessage("receiptStatus", error.message);
  }
});

/* ------------------------------------------------------------------ */
/* Start-up: show the election, and resume a half-finished journey       */
/* ------------------------------------------------------------------ */

async function resumeSession() {
  let data;

  try {
    data = await api("GET", "/api/voter/session");
  } catch (error) {
    return;
  }

  if (!data.signedIn) return;

  applySession(data.state);

  const { stage, otp } = data.state;

  if (stage === "login") {
    openRulesDialog();
  } else if (stage === "rules" && otp) {
    showOtpPanel({ maskedEmail: otp.maskedEmail, expiresInSec: otp.expiresInSec, resendInSec: otp.resendInSec, demoHint: undefined });
  } else if (stage === "rules") {
    showPanel("verifyPanel", 2);
  } else if (stage === "verified") {
    try {
      await loadBallot();
      showPanel("ballotPanel", 3);
    } catch (error) {
      handleFlowError(error, "loginMessage");
    }
  }
}

(async () => {
  await refreshPublicState();
  await resumeSession();
})();

setInterval(refreshPublicState, STATE_POLL_MS);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshPublicState();
});
