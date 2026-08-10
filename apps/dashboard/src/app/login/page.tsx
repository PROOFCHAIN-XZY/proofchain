import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { BACKEND_URL, TOKEN_COOKIE } from "@/lib/api";

export const dynamic = "force-dynamic";

async function signIn(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const res = await fetch(`${BACKEND_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });

  if (!res.ok) redirect("/login?error=1");

  const { accessToken } = (await res.json()) as { accessToken: string };

  // httpOnly: the token must be unreachable from client JavaScript.
  (await cookies()).set(TOKEN_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });

  redirect("/");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main style={{ maxWidth: "24rem" }}>
      <div className="page-head">
        <div>
          <p className="eyebrow">Operator access</p>
          <h1>Sign in</h1>
        </div>
      </div>

      {error ? <p className="error">Those credentials were not accepted.</p> : null}

      <form action={signIn} style={{ display: "grid", gap: "1rem", marginTop: "1.5rem" }}>
        <label>
          Email
          <input name="email" type="email" required autoComplete="username" />
        </label>
        <label>
          Password
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
        <button className="btn" data-variant="primary" type="submit">
          Sign in
        </button>
      </form>

      <p className="note" style={{ marginTop: "1.5rem" }}>
        Auditors get read-only access. Verification endpoints and audit reports stay public by
        design — a buyer must be able to check our claims without an account.
      </p>
    </main>
  );
}
