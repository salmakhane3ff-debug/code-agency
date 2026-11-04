"use client";
/**
 * /recruiter/login — recruiter sign-in (Arabic, RTL).
 * POST /api/recruiter/auth sets the HttpOnly cookie; only error CODES are read from the
 * response and shown with fixed Arabic texts (never server text).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, LogIn, UserCog } from "lucide-react";
import { toRecruiterError } from "@/lib/recruiterVisibility";
import { recruiterErrorLabel } from "../errorLabels";

export default function RecruiterLoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (!username.trim() || !password) { setError(recruiterErrorLabel("INVALID_INPUT")); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/recruiter/auth", {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (res.ok) { setPassword(""); router.replace("/recruiter"); return; }
      const body = await res.json().catch(() => null);
      setError(recruiterErrorLabel(toRecruiterError(body).code));
    } catch {
      setError(recruiterErrorLabel(null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm min-w-0">
        <div className="flex flex-col items-center text-center mb-6">
          <span className="w-14 h-14 rounded-2xl bg-emerald-600 text-white flex items-center justify-center shadow-sm">
            <UserCog className="w-7 h-7" aria-hidden="true" />
          </span>
          <h1 className="mt-3 text-xl font-bold">فضاء مسؤول التوظيف</h1>
          <p className="mt-1 text-sm text-slate-500">سجّل الدخول للوصول إلى لوحة التحكم</p>
        </div>
        <form onSubmit={submit} noValidate className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4" data-recruiter-login>
          <div>
            <label htmlFor="rec-username" className="block text-sm font-semibold mb-1">اسم المستخدم</label>
            <input id="rec-username" name="username" autoComplete="username" dir="ltr" value={username}
              onChange={(e) => setUsername(e.target.value)} disabled={busy}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-left focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
          <div>
            <label htmlFor="rec-password" className="block text-sm font-semibold mb-1">كلمة السر</label>
            <div className="relative">
              <input id="rec-password" name="password" type={show ? "text" : "password"} autoComplete="current-password" dir="ltr"
                value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy}
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5 pl-11 text-left focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "إخفاء كلمة السر" : "إظهار كلمة السر"}
                className="absolute inset-y-0 left-0 px-3 text-slate-500 hover:text-slate-800">
                {show ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
              </button>
            </div>
          </div>
          {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2" data-login-error>{error}</p>}
          <button type="submit" disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 text-white font-bold py-2.5 hover:bg-emerald-700 disabled:opacity-60">
            <LogIn className="w-4 h-4" aria-hidden="true" />
            {busy ? "جارٍ تسجيل الدخول…" : "تسجيل الدخول"}
          </button>
        </form>
      </div>
    </main>
  );
}
