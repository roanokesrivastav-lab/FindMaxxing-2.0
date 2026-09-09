import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FindMaxxing",
    short_name: "FindMaxxing",
    description: "Local knowledge, mapped. Discover places locals use, save them, add your own, and meet people.",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f4ee",
    theme_color: "#f6f4ee",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
