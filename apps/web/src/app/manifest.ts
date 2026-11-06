import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Recruiting OS", short_name: "Recruiting", start_url: "/", display: "standalone",
    background_color: "#EDF0EE", theme_color: "#10212E",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
