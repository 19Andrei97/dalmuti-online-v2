"use strict";

(function () {
  const form = document.getElementById("auth-form");
  const errorEl = document.getElementById("auth-error");

  async function submit(mode) {
    errorEl.textContent = "";
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    try {
      const res = await fetch("/api/" + mode, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      const data = await res.json().catch(() => ({}));
      errorEl.textContent = data.error || "Request failed";
    } catch (e) {
      errorEl.textContent = "Network error";
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit("login");
  });
  document.getElementById("register-btn").addEventListener("click", () => submit("register"));
})();
