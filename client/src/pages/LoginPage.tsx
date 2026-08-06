import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, Loader2, CreditCard, LogIn } from "lucide-react";

export default function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const emailClean = email.trim().toLowerCase();
    if (!emailClean || !password) {
      setError("請輸入 email 同 password");
      return;
    }

    setLoading(true);
    const { error: err } = await signIn(emailClean, password);
    setLoading(false);

    if (err) {
      setError(err);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center space-y-2">
          <div className="flex items-center justify-center gap-2">
            <CreditCard size={24} className="text-primary" />
            <CardTitle className="text-xl">CardRecon</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">
            請用 email + password 登入
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoFocus
                required
                className="h-10"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="h-10"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 text-destructive text-sm">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading || !email.trim() || !password}>
              {loading ? (
                <><Loader2 className="animate-spin mr-2" size={16} /> 登入緊...</>
              ) : (
                <><LogIn size={16} className="mr-2" /> 登入</>
              )}
            </Button>

            <p className="text-[11px] text-muted-foreground leading-relaxed pt-2 border-t border-border">
              Password 由 admin 提供。如果忘記 password，請聯絡 Alex 或 Yannese reset。
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
