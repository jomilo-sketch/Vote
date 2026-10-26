/*
  BOUESTI Vote — administrator sign-in page.

  The server walks each person through the steps; this page only shows the
  step the server says is next. It never decides who is allowed in.

      e-mail + password ─► (first use) choose password ─► (first use) 2FA set-up ─► recovery codes
                        └► (later)     6-digit code    ─────────────────────────► dashboard
*/

"use strict";

const $ = (id) => document.getElementById(id);

const PANELS = ["signinPanel", "passwordPanel", "enrollPanel", "totpPanel", "recoveryPanel", "resetPanel", "noticePanel"];
const DASHBOARD = "/dashboard.html";

let pendingRecoveryCodes = [];
let enrollStarted = false;

/* ---------- small helpers ---------- */

function show(panelId) {
  PANELS.forEach((id) => {
    $(id).hidden = id !== panelId;
  });

  const first = $(panelId).querySelector("input:not([type=checkbox]):not([disabled])");
  if (first) setTimeout(() => first.focus(), 30);
}

function message(id, text, ok = false) {
  const element = $(id);

  element.textContent = text || "";
  element.classList.toggle("form-message--ok", Boolean(ok && text));
}

function clearMessages() {
  ["signinMessage", "passwordMessage", "enrollMessage", "totpMessage", "resetMessage"].forEach((id) => message(id, ""));
}

function busy(button, isBusy, idleText) {
  if (!button) return;

  button.disabled = isBusy;
  if (idleText !== undefined) button.textContent = isBusy ? "Please wait…" : idleText;
}

function goToDashboard() {
  window.location.replace(DASHBOARD);
}

/* Show the panel the server says comes next. */
function goTo(next) {
  clearMessages();

  if (next === "dashboard") return goToDashboard();
  if (next === "totp") return show("totpPanel");
  if (next === "change-password") return show("passwordPanel");

  if (next === "enroll") {
    show("enrollPanel");
    return startEnrollment();
  }

  show("signinPanel");
}

/* A 401 mid-way means the five-minute sign-in window ran out. */
function handleStepError(error, messageId) {
  if (error.code === "unauthenticated" || error.code === "wrong-stage") {
    $("adminPassword").value = "";
    show("signinPanel");
    message("signinMessage", "That sign-in took too long or was interrupted. Please sign in again.");
    return;
  }

  message(messageId, error.message);
}

/* ---------- 1. e-mail and password ---------- */

$("signinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  message("signinMessage", "");

  const email = $("adminEmail").value.trim();
  const password = $("adminPassword").value;

  if (!email || !password) {
    message("signinMessage", "Enter your e-mail address and password.");
    return;
  }

  busy($("signinButton"), true, "Continue");

  try {
    const result = await api("POST", "/api/admin/login", { email, password });

    $("adminPassword").value = "";
    goTo(result.next);
  } catch (error) {
    message("signinMessage", error.message);
  } finally {
    busy($("signinButton"), false, "Continue");
  }
});

/* ---------- "use a different account" ---------- */

document.querySelectorAll("[data-action='start-over']").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      await api("POST", "/api/admin/logout");
    } catch (error) {
      /* the pending sign-in ends by itself in a few minutes anyway */
    }

    enrollStarted = false;
    $("adminPassword").value = "";
    clearMessages();
    show("signinPanel");
  });
});

/* ---------- 2. first use: choose a password ---------- */

$("passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  message("passwordMessage", "");

  const first = $("newPassword").value;
  const second = $("newPasswordAgain").value;

  if (first !== second) {
    message("passwordMessage", "The two passwords are not the same.");
    return;
  }

  try {
    const result = await api("POST", "/api/admin/setup/password", { newPassword: first });

    $("newPassword").value = "";
    $("newPasswordAgain").value = "";
    goTo(result.next);
  } catch (error) {
    handleStepError(error, "passwordMessage");
  }
});

/* ---------- 3. first use: two-factor set-up ---------- */

async function startEnrollment() {
  if (enrollStarted) return;
  enrollStarted = true;

  $("enrollSecret").textContent = "Loading…";

  try {
    const setup = await api("POST", "/api/admin/setup/totp/start", {});

    $("enrollSecret").textContent = setup.secret;
    $("enrollAccount").textContent = setup.account;
    $("enrollLink").href = setup.uri;
  } catch (error) {
    enrollStarted = false;
    $("enrollSecret").textContent = "—";
    handleStepError(error, "enrollMessage");
  }
}

$("enrollForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  message("enrollMessage", "");

  const code = $("enrollCode").value.replace(/\s/g, "");

  if (!/^\d{6}$/.test(code)) {
    message("enrollMessage", "Type the 6 digits shown in your authenticator app.");
    return;
  }

  try {
    const result = await api("POST", "/api/admin/setup/totp/confirm", { code });

    $("enrollCode").value = "";
    $("enrollSecret").textContent = "";
    enrollStarted = false;

    pendingRecoveryCodes = result.recoveryCodes || [];
    showRecoveryCodes();
  } catch (error) {
    handleStepError(error, "enrollMessage");
  }
});

/* ---------- 4. every later sign-in ---------- */

$("totpForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  message("totpMessage", "");

  const code = $("totpCode").value.trim();

  if (!code) {
    message("totpMessage", "Type the code from your authenticator app.");
    return;
  }

  try {
    const result = await api("POST", "/api/admin/totp", { code });

    $("totpCode").value = "";

    if (result.warning) {
      $("noticeText").textContent = result.warning;
      show("noticePanel");
      return;
    }

    goToDashboard();
  } catch (error) {
    $("totpCode").value = "";
    handleStepError(error, "totpMessage");
  }
});

$("noticeContinue").addEventListener("click", goToDashboard);

/* ---------- 5. recovery codes ---------- */

function showRecoveryCodes() {
  $("recoveryList").innerHTML = pendingRecoveryCodes.map((code) => `<li>${escapeHtml(code)}</li>`).join("");
  $("recoverySaved").checked = false;
  $("recoveryContinue").disabled = true;
  show("recoveryPanel");
}

$("recoverySaved").addEventListener("change", () => {
  $("recoveryContinue").disabled = !$("recoverySaved").checked;
});

$("copyRecovery").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(pendingRecoveryCodes.join("\n"));
    $("copyRecovery").textContent = "Copied ✓";
  } catch (error) {
    $("copyRecovery").textContent = "Select the codes and copy them by hand";
  }

  setTimeout(() => {
    $("copyRecovery").textContent = "Copy codes";
  }, 2500);
});

$("downloadRecovery").addEventListener("click", () => {
  const body =
    "BOUESTI Vote — administrator recovery codes\n" +
    "Each code works once if you lose your phone. Keep this file private.\n\n" +
    `${pendingRecoveryCodes.join("\n")}\n`;

  const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
  const link = document.createElement("a");

  link.href = url;
  link.download = "bouesti-vote-recovery-codes.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$("recoveryContinue").addEventListener("click", () => {
  pendingRecoveryCodes = [];
  $("recoveryList").innerHTML = "";
  goToDashboard();
});

/* ---------- 6. forgotten password ---------- */

$("showReset").addEventListener("click", () => {
  clearMessages();
  $("resetEmail").value = $("adminEmail").value;
  show("resetPanel");
});

$("backToSignin").addEventListener("click", () => {
  clearMessages();
  show("signinPanel");
});

$("resetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  message("resetMessage", "");

  const email = $("resetEmail").value.trim();
  const code = $("resetCode").value.trim();
  const first = $("resetPassword").value;
  const second = $("resetPasswordAgain").value;

  if (!email || !code || !first) {
    message("resetMessage", "Fill in every box.");
    return;
  }

  if (first !== second) {
    message("resetMessage", "The two passwords are not the same.");
    return;
  }

  try {
    const result = await api("POST", "/api/admin/reset/redeem", { email, code, newPassword: first });

    ["resetCode", "resetPassword", "resetPasswordAgain"].forEach((id) => {
      $(id).value = "";
    });

    $("adminEmail").value = email;
    show("signinPanel");
    message("signinMessage", result.message, true);
  } catch (error) {
    message("resetMessage", error.message);
  }
});

/* ---------- on arrival: carry on from wherever the server says we are ---------- */

(async function start() {
  show("signinPanel");

  // The dashboard leaves a short reason here when it sends you back (session ended, signed out…).
  try {
    const flash = sessionStorage.getItem("bouesti-flash");

    if (flash) {
      sessionStorage.removeItem("bouesti-flash");
      message("signinMessage", flash, true);
    }
  } catch (error) {
    /* storage can be unavailable */
  }

  try {
    const session = await api("GET", "/api/admin/session");

    if (session.signedIn) goTo(session.next);
  } catch (error) {
    /* not signed in, or the server is busy: the sign-in form is already showing */
  }
})();
