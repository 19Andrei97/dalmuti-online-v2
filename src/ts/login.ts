/* Sign-in / registration form for the (deprecated) account system. */
interface AuthResponse {
  error?: string;
}

const form = document.getElementById("auth-form") as HTMLFormElement | null;
const errorEl = document.getElementById("auth-error");

function message(text: string): void {
  if (errorEl) errorEl.textContent = text;
}

async function submit(mode: "login" | "register"): Promise<void> {
  if (!form) return;
  message("");
  const username = (document.getElementById("username") as HTMLInputElement | null)?.value.trim() ?? "";
  const password = (document.getElementById("password") as HTMLInputElement | null)?.value ?? "";

  try {
    const res = await fetch(`/api/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      location.href = "/";
      return;
    }
    const data = (await res.json().catch(() => ({}))) as AuthResponse;
    message(data.error ?? "Request failed");
  } catch {
    message("Network error");
  }
}

form?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  void submit("login");
});

document.getElementById("register-btn")?.addEventListener("click", () => {
  void submit("register");
});
