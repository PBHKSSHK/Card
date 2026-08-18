import { Link, useLocation } from "wouter";
import { useTheme } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import {
  LayoutDashboard, Upload, GitCompareArrows, AlertTriangle, Package,
  FileDown, BarChart3, Settings, Sun, Moon, CreditCard, Menu, LogOut, User, Landmark,
  Receipt, Inbox, HandCoins,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";

// superOnly = 只有 owner/admin 可見
const ccNavItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, superOnly: false },
  { href: "/upload", label: "Upload Centre", icon: Upload, superOnly: false },
  { href: "/recon", label: "Recon Queue", icon: GitCompareArrows, superOnly: false },
  { href: "/exceptions", label: "Exceptions", icon: AlertTriangle, superOnly: false },
  { href: "/export", label: "Journal Export", icon: FileDown, superOnly: true },
  { href: "/bundle", label: "Bundle Download", icon: Package, superOnly: true },
  { href: "/report", label: "BU Report", icon: BarChart3, superOnly: false },
];

const bankNavItems = [
  { href: "/bank-upload", label: "Bank Upload", icon: Upload, superOnly: true },
  { href: "/bank-recon", label: "Bank Recon", icon: Landmark, superOnly: true },
];

const claimNavItems = [
  { href: "/claims/inbox", label: "審批 Inbox", icon: Inbox, superOnly: false },
  { href: "/claims", label: "Claim Forms", icon: Receipt, superOnly: false },
  { href: "/payments", label: "付款申請", icon: HandCoins, superOnly: false },
  { href: "/claims/export", label: "Claim Journal Export", icon: FileDown, superOnly: true },
];

const settingsNavItems = [
  { href: "/settings", label: "Settings", icon: Settings },
];

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="CardRecon">
      <rect x="2" y="6" width="28" height="20" rx="3" stroke="currentColor" strokeWidth="2" />
      <path d="M2 12h28" stroke="currentColor" strokeWidth="2" />
      <path d="M7 18h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7 22h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
      <circle cx="24" cy="20" r="3" stroke="currentColor" strokeWidth="1.5" opacity="0.7" />
      <path d="M22.5 21.5l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { theme, toggleTheme } = useTheme();
  const { profile, signOut, isSuperUser, isOwner, hasModule } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Sidebar active 判斷。特別處理：付款申請表格 (/claims/new/payment_supplier
  // / payment_freelancer / payment) 屬於「付款申請」面板，唔算 Claim Forms。
  const isNavActive = (href: string) => {
    const isPaymentForm = location.startsWith("/claims/new/payment");
    if (href === "/payments") return location.startsWith("/payments") || isPaymentForm;
    if (href === "/claims") return location.startsWith("/claims") && !isPaymentForm;
    return location === href || (href !== "/" && location.startsWith(href));
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed lg:static inset-y-0 left-0 z-50
          w-60 bg-sidebar border-r border-sidebar-border
          flex flex-col transition-transform duration-200
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        <div className="flex items-center gap-2.5 px-5 h-14 border-b border-sidebar-border">
          <Logo />
          <span className="font-semibold text-sm tracking-tight text-sidebar-foreground">CardRecon</span>
        </div>

        <nav className="flex-1 px-3 py-3 overflow-y-auto">
          {/* Credit Card Module — Settings -> Users 可用模組控制顯示 */}
          {hasModule("card") && (
          <div className="mb-1">
            <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">Credit Card</div>
            <div className="space-y-0.5">
              {ccNavItems.filter(i => !i.superOnly || isSuperUser).map((item) => {
                const isActive = isNavActive(item.href);
                return (
                  <Link key={item.href} href={item.href}>
                    <div
                      data-testid={`nav-${item.label.toLowerCase().replace(/\s/g, '-')}`}
                      className={`
                        flex items-center gap-2.5 px-3 py-2 rounded-md text-sm cursor-pointer
                        transition-colors duration-150
                        ${isActive
                          ? 'bg-sidebar-accent text-sidebar-foreground font-medium'
                          : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                        }
                      `}
                      onClick={() => setSidebarOpen(false)}
                    >
                      <item.icon size={16} strokeWidth={isActive ? 2 : 1.5} />
                      {item.label}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          )}

          {/* Bank Module */}
          {hasModule("bank") && (
          <div className="mb-1">
            <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">Bank</div>
            <div className="space-y-0.5">
              {bankNavItems.filter(i => !i.superOnly || isSuperUser).map((item) => {
                const isActive = isNavActive(item.href);
                return (
                  <Link key={item.href} href={item.href}>
                    <div
                      data-testid={`nav-${item.label.toLowerCase().replace(/\s/g, '-')}`}
                      className={`
                        flex items-center gap-2.5 px-3 py-2 rounded-md text-sm cursor-pointer
                        transition-colors duration-150
                        ${isActive
                          ? 'bg-sidebar-accent text-sidebar-foreground font-medium'
                          : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                        }
                      `}
                      onClick={() => setSidebarOpen(false)}
                    >
                      <item.icon size={16} strokeWidth={isActive ? 2 : 1.5} />
                      {item.label}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          )}

          {/* Claim Forms Module */}
          {hasModule("claims") && (
          <div className="mb-1">
            <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">Claims</div>
            <div className="space-y-0.5">
              {claimNavItems.filter(i => !i.superOnly || isSuperUser).map((item) => {
                const isActive = isNavActive(item.href);
                return (
                  <Link key={item.href} href={item.href}>
                    <div
                      data-testid={`nav-${item.label.toLowerCase().replace(/\s/g, '-')}`}
                      className={`
                        flex items-center gap-2.5 px-3 py-2 rounded-md text-sm cursor-pointer
                        transition-colors duration-150
                        ${isActive
                          ? 'bg-sidebar-accent text-sidebar-foreground font-medium'
                          : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                        }
                      `}
                      onClick={() => setSidebarOpen(false)}
                    >
                      <item.icon size={16} strokeWidth={isActive ? 2 : 1.5} />
                      {item.label}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          )}

          {/* Settings — 只限 Owner/Admin (BU user 唔顯示) */}
          {isSuperUser && (
          <div className="mt-2 pt-2 border-t border-sidebar-border/50">
            <div className="space-y-0.5">
              {settingsNavItems.map((item) => {
                const isActive = isNavActive(item.href);
                return (
                  <Link key={item.href} href={item.href}>
                    <div
                      data-testid={`nav-${item.label.toLowerCase().replace(/\s/g, '-')}`}
                      className={`
                        flex items-center gap-2.5 px-3 py-2 rounded-md text-sm cursor-pointer
                        transition-colors duration-150
                        ${isActive
                          ? 'bg-sidebar-accent text-sidebar-foreground font-medium'
                          : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                        }
                      `}
                      onClick={() => setSidebarOpen(false)}
                    >
                      <item.icon size={16} strokeWidth={isActive ? 2 : 1.5} />
                      {item.label}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
          )}
        </nav>

        {/* User info + actions */}
        <div className="px-3 py-3 border-t border-sidebar-border space-y-1">
          {profile && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
              <User size={14} />
              <span className="truncate flex-1">{profile.full_name || profile.email}</span>
              {isOwner && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 font-medium">Owner</span>
              )}
              {profile.role === "admin" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">Admin</span>
              )}
              {profile.role === "bu_user" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                  {profile.entity_scope.join(",") || "BU"}
                </span>
              )}
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            className="w-full justify-start gap-2 text-muted-foreground"
            data-testid="button-theme-toggle"
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={signOut}
            className="w-full justify-start gap-2 text-muted-foreground hover:text-destructive"
          >
            <LogOut size={16} />
            Sign out
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center gap-3 px-4 h-14 border-b border-border bg-background">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSidebarOpen(true)}
            data-testid="button-menu"
          >
            <Menu size={18} />
          </Button>
          <div className="flex items-center gap-2">
            <CreditCard size={18} className="text-primary" />
            <span className="font-semibold text-sm">CardRecon</span>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
