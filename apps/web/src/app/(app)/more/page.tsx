import Link from "next/link";
import { NAV } from "@/lib/nav";
import { PageHeader } from "@/components/ui";

export default function More() {
  return (
    <>
      <PageHeader title="All pages" />
      <ul className="panel divide-y divide-mist">
        {NAV.map((n) => (
          <li key={n.href}><Link href={n.href} className="block px-4 min-h-[48px] py-3">{n.label}</Link></li>
        ))}
        <li><Link href="/onboarding" className="block px-4 min-h-[48px] py-3">Setup wizard</Link></li>
      </ul>
    </>
  );
}
