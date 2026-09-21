import type { Metadata, Viewport } from "next";
import OfflineRegistration from "@/components/OfflineRegistration";
import "./globals.css";

export const metadata: Metadata = {
  title: "ULTRON Orb UI",
  description: "An offline-capable holographic orb built with Three.js and Next.js",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <OfflineRegistration />
        {children}
      </body>
    </html>
  );
}
