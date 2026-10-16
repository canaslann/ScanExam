import type { Metadata } from "next";
import "./globals.css";
import { AppThemeProvider } from "@/components/theme-controls";

export const metadata: Metadata = {
  title: "Scan Exam",
  description: "Sınav kâğıtlarının üst bölümünü okuyup kontrollü biçimde Excel'e aktaran mobil uygulama.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr" suppressHydrationWarning>
      <body className="antialiased"><AppThemeProvider>{children}</AppThemeProvider></body>
    </html>
  );
}
