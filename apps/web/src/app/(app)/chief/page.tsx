import { Chat } from "@/components/chat";
import { PageHeader } from "@/components/ui";

export default function Chief() {
  return (
    <>
      <PageHeader title="AI Chief of Staff" lede="Ask questions about your pipeline. The database is the source of truth, not this chat." />
      <Chat />
    </>
  );
}
