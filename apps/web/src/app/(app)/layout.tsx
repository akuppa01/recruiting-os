import Link from "next/link";
import { SideNav, TabBar } from "@/components/nav";
import { DemoBanner } from "@/components/ui";
import { isDemoMode } from "@/lib/data";

export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="md:grid md:grid-cols-[232px_1fr] min-h-screen">
      <aside className="hidden md:block bg-paper border-r border-mist sticky top-0 h-screen overflow-y-auto">
        <Link href="/" className="block px-6 pt-6 pb-3 font-serif text-xl">Recruiting OS</Link>
        <SideNav />
      </aside>
      <div className="min-w-0">
        {isDemoMode() && <DemoBanner />}
        <main className="px-4 md:px-10 py-6 md:py-10 pb-28 md:pb-12 max-w-6xl">{children}</main>
      </div>
      <TabBar />
    </div>
  );
}
