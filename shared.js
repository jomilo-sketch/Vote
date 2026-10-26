/*
  BOUESTI Vote — shared browser helpers.

  Loaded first by every page. It holds no secrets and makes no decisions:
  the server decides who may do what. In particular this file does NOT
  contain the student password, the demo code, or any permission list that
  the server does not re-check.

  How the browser talks to the server
    * same origin, so the session cookie (HttpOnly, SameSite=Strict, Secure
      over HTTPS) is sent automatically — JavaScript never sees the token;
    * every request carries  X-Requested-With: bouesti-vote  which the server
      requires on anything that changes data (a cross-site page cannot add
      that header).
*/

"use strict";

/* ---------- text safety ---------- */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

/* ---------- talking to the server ---------- */

class ApiError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function api(method, path, body) {
  const headers = { "X-Requested-With": "bouesti-vote" };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;

  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    throw new ApiError("Couldn't reach the server. Check your connection and try again.", 0, "network");
  }

  let data = null;

  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }

  if (!response.ok) {
    throw new ApiError(
      (data && data.error) || `The request failed (${response.status}). Please try again.`,
      response.status,
      data && data.code,
      data
    );
  }

  return data;
}

/* Save a file the server generates (CSV, signed report, backup...). The
   session cookie is sent, so only a signed-in administrator can fetch it. */
async function downloadFile(path) {
  let response;

  try {
    response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Requested-With": "bouesti-vote" }
    });
  } catch (error) {
    throw new ApiError("Couldn't reach the server. Check your connection and try again.", 0, "network");
  }

  if (!response.ok) {
    let data = null;

    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }

    throw new ApiError((data && data.error) || `The download failed (${response.status}).`, response.status, data && data.code, data);
  }

  const disposition = response.headers.get("Content-Disposition") || "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const fileName = match ? match[1] : "download";

  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return fileName;
}

/* ---------- dates and times (always shown in the viewer's own time zone) ---------- */

function formatDateTime(value) {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString(undefined, {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit"
  });
}

function formatShortTime(value) {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/* "04:59" from a number of seconds. */
function formatClock(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

/* A <input type="datetime-local"> holds LOCAL wall-clock time with no zone,
   while the server stores UTC instants. These two convert in both directions
   without ever shifting the time the officer typed. */
function isoToLocalDatetimeInput(iso) {
  if (!iso) return "";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const pad = (number) => String(number).padStart(2, "0");

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function localDatetimeInputToIso(value) {
  if (!value) return null;

  const date = new Date(value); // a zone-less date-time string is read as LOCAL time
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
