import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeepStocks — NSE Quant Screener & AI Analyzer",
  description: "Indian Stock Market Quant Screener with AI-powered institutional analysis. NSE/BSE focused.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased" style={{ background: "#04070f", color: "#e2e8f0" }}>{children}</body>
    </html>
  );
}
