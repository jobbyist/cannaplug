import { createFileRoute } from "@tanstack/react-router";
import { CannaPlugHome } from "@/components/CannaPlugHome";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "CannaPlug | Premium Cannabis Dispensary Pretoria" },
    { name: "description", content: "Premium cannabis products, expert guidance and a better dispensary experience in Pretoria, South Africa." },
    { property: "og:title", content: "CannaPlug | Quality Cannabis. Real People." },
    { property: "og:description", content: "Premium cannabis, curated with care. Visit CannaPlug in Pretoria Central." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ]}),
  component: Index,
});

function Index() {
  return <CannaPlugHome />;
}
