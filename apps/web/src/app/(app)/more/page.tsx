import Link from "next/link";
import { NAV } from "@/lib/nav";
import { Card, PageHeader } from "@/components/ui";

export default function More() {
  return (
    <>
      <PageHeader variant="apple" title="All pages" />
      <Card>
        <ul className="divide-y divide-mist">
          {NAV.map((n) => (
            <li key={n.href}><Link href={n.href} className="block px-4 min-h-[48px] py-3">{n.label}</Link></li>
          ))}
          <li><Link href="/usage" className="block px-4 min-h-[48px] py-3">Usage and limits</Link></li>
          <li><Link href="/onboarding" className="block px-4 min-h-[48px] py-3">Setup wizard</Link></li>
        </ul>
      </Card>
    </>
  );
}
