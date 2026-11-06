"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV = [
  { href: "/", label: "Command Center", short: "Today" },
  { href: "/pipeline", label: "Job Pipeline", short: "Pipeline" },
  { href: "/explorer", label: "Opportunity Explorer", short: "Explore" },
  { href: "/companies", label: "Company Intelligence", short: "Companies" },
  { href: "/applications", label: "Applications", short: "Applied" },
  { href: "/outreach", label: "Contacts and Outreach", short: "Outreach" },
  { href: "/proof", label: "Proof-of-Work Assets", short: "Proof" },
  { href: "/inbox", label: "Notifications and Exceptions", short: "Inbox" },
  { href: "/analytics", label: "Recruiting Analytics", short: "Analytics" },
  { href: "/chief", label: "AI Chief of Staff", short: "Chief" },
  { href: "/settings", label: "Integrations and Settings", short: "Settings" },
];
const TABS = ["/", "/pipeline", "/inbox", "/chief"];

const active = (path: string, href: string) => (href === "/" ? path === "/" : path.startsWith(href));

export function SideNav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="hidden md:flex flex-col gap-0.5 p-3">
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} aria-current={active(path, n.href) ? "page" : undefined}
          className={`px-3 py-2 rounded-board text-sm border-l-2 ${active(path, n.href) ? "border-teal bg-chalk font-medium" : "border-transparent text-soft hover:text-ink"}`}>
          {n.label}
        </Link>
      ))}
    </nav>
  );
}

export function TabBar() {
  const path = usePathname();
  const tabs = NAV.filter((n) => TABS.includes(n.href));
  return (
    <nav aria-label="Main" className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-paper border-t border-mist grid grid-cols-5 pb-[env(safe-area-inset-bottom)]">
      {tabs.map((n) => (
        <Link key={n.href} href={n.href} aria-current={active(path, n.href) ? "page" : undefined}
          className={`min-h-[56px] flex items-center justify-center text-xs ${active(path, n.href) ? "text-teal font-semibold border-t-2 border-teal -mt-px" : "text-soft"}`}>
          {n.short}
        </Link>
      ))}
      <Link href="/more" className={`min-h-[56px] flex items-center justify-center text-xs ${path === "/more" ? "text-teal font-semibold" : "text-soft"}`}>More</Link>
    </nav>
  );
}
