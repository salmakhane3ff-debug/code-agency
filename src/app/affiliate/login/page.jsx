"use client";
/**
 * /affiliate/login — affiliate sign-in. Language follows the visitor's market
 * (useMarketLocale → AFFILIATE_TABS_TEXT, login_* keys): MA → Arabic / RTL,
 * FR → French / LTR. The username/phone and password inputs stay LTR islands
 * (the password field and its show/hide button are positioned physically,
 * consistently with that LTR input). Auth logic unchanged.
 */
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Users, Lock, Loader2, AlertCircle, Eye, EyeOff } from "lucide-react";
import { useMarketLocale } from "@/context/useMarketLocale";
import { AFFILIATE_TABS_TEXT } from "@/lib/affiliateTabsI18n";
import { localizeServerError } from "@/lib/serverText/affiliateServerText";

export default function AffiliateLoginPage() {
  const router = useRouter();
  const { t, lang } = useMarketLocale(AFFILIATE_TABS_TEXT);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd,  setShowPwd]  = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);

  // Already logged in → redirect
  useEffect(() => {
    if (typeof window !== "undefined" && localStorage.getItem("affiliateToken")) {
      router.replace("/affiliate/dashboard");
    }
  }, [router]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/affiliate/auth", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ username: username.trim(), password }),
      });

      const data = await res.json();

      if (res.ok) {
        localStorage.setItem("affiliateToken",    data.token);
        localStorage.setItem("affiliateId",       data.affiliate.id);
        localStorage.setItem("affiliateUsername", data.affiliate.username);
        localStorage.setItem("affiliateName",     data.affiliate.name || data.affiliate.username);
        router.push("/affiliate/dashboard");
      } else {
        // Server text (+ code) kept as sent and localized at display time; our own fallback is a key.
        setError(data.error ? { text: data.error, code: data.code } : { key: "login_err_default" });
      }
    } catch {
      setError({ key: "login_err_server" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo / header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white/10 rounded-2xl mb-4 backdrop-blur">
            <Users className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">{t("login_title")}</h1>
          <p className="text-gray-400 text-sm mt-1">{t("login_subtitle")}</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-3xl shadow-2xl p-7 space-y-5">

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2.5 bg-red-50 border border-red-100 rounded-2xl px-4 py-3">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <p className="text-sm text-red-600">{error.key ? t(error.key) : localizeServerError(error, lang)}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Username / Phone */}
            <div>
              <label htmlFor="aff-login-username" className="block text-xs font-semibold text-gray-600 mb-1.5">
                {t("login_username")}
              </label>
              <input
                id="aff-login-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t("login_username_placeholder")}
                required
                autoFocus
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400 font-mono"
                dir="ltr"
              />
            </div>

            {/* Password */}
            <div>
              <label htmlFor="aff-login-password" className="block text-xs font-semibold text-gray-600 mb-1.5">
                {t("login_password")}
              </label>
              <div className="relative" dir="ltr">
                <input
                  id="aff-login-password"
                  type={showPwd ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="w-full px-4 py-3 pr-10 text-sm border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:border-gray-400"
                  dir="ltr"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd(!showPwd)}
                  aria-label={showPwd ? t("login_hide_password") : t("login_show_password")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !username.trim() || !password}
              className="w-full flex items-center justify-center gap-2 py-3 bg-gray-900 hover:bg-gray-800 text-white rounded-xl font-bold text-sm transition-all disabled:opacity-50 active:scale-[0.99]"
            >
              {loading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> {t("login_loading")}</>
              ) : (
                <><Lock className="w-4 h-4" /> {t("login_submit")}</>
              )}
            </button>
          </form>

          <p className="text-center text-xs text-gray-400 pt-1">
            {t("login_not_partner")}{" "}
            <span className="text-gray-600 font-medium">{t("login_contact")}</span>
          </p>
        </div>

        <p className="text-center text-xs text-gray-500 mt-6">
          © <bdi>{new Date().getFullYear()}</bdi> — {t("login_footer")}
        </p>
      </div>
    </div>
  );
}
