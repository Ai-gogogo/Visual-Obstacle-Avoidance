import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../styles/tokens.css";
import "../styles/components.css";
import "../styles/features.css";
import "../styles/layout.css";
import "../styles/motion.css";

export const metadata: Metadata = {
  title: "Judge view · VisionAssist",
  description: "VisionAssist dual-camera monitor and local voice assistant.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
