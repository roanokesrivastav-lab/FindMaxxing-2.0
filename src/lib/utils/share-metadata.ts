import type { Metadata } from "next";
import { truncate } from "./format";

const DESCRIPTION_MAX = 200;

/**
 * Builds the metadata block for a shareable page (place, event, profile) so
 * links pasted into chats and social apps unfurl with a real title, summary
 * and image. `path` and `image` may be relative; the root layout sets
 * `metadataBase`, so Next resolves them against NEXT_PUBLIC_SITE_URL.
 *
 * Only public data should ever be passed in: crawlers are never signed in,
 * so a private listing must not leak its details through these tags.
 */
export function shareMetadata({
  title,
  description,
  path,
  image,
  type = "website",
}: {
  title: string;
  description: string;
  path: string;
  image?: string | null;
  type?: "website" | "article" | "profile";
}): Metadata {
  const summary = truncate(description.replace(/\s+/g, " ").trim(), DESCRIPTION_MAX);
  const images = image ? [{ url: image, alt: title }] : undefined;
  return {
    title,
    description: summary,
    alternates: { canonical: path },
    openGraph: { type, title, description: summary, url: path, siteName: "FindMaxxing", images },
    twitter: { card: image ? "summary_large_image" : "summary", title, description: summary, images: image ? [image] : undefined },
  };
}
